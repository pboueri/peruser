// File-backed patch store.
//
//   <root>/sites/<site-slug>/views.json                { views: [...], activeViewId }
//   <root>/sites/<site-slug>/<view-slug>/<patch-slug>/patch.json
//   <root>/sites/<site-slug>/<view-slug>/<patch-slug>/style.css
//
// Files are the source of truth: anyone (an editor, Claude Code itself) can
// change them and the watcher pushes the new catalog to the extension.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { slugify, siteSlug, uniqueSlug } from '../../src/lib/slug.js';
import { parseProfile, formatProfile } from '../../src/lib/profile.js';

export const DEFAULT_ROOT = path.join(os.homedir(), '.peruser');

const README = `# Peruser patches

Each folder under sites/ is one web site. Inside it, views.json lists the
site's views (named sets of patches) and which one is active. Each view is a
folder; each patch inside it is a folder with:

  patch.json   name, summary, scope, rules, risk, warnings, enabled, ...
  style.css    the CSS the patch injects
  script.js    JavaScript the patch runs (only if you allowed JS patches)

profile.md next to this file holds your standing preferences (checkboxes and
notes) that the agent reads on every run.

Edit these files with any editor. The Peruser bridge watches this folder and
pushes changes to the browser immediately. Deleting a folder deletes the
patch or view.
`;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

export class Store extends EventEmitter {
  constructor({ root = DEFAULT_ROOT } = {}) {
    super();
    this.root = root;
    this.sitesDir = path.join(root, 'sites');
    this.catalog = { patches: {}, views: {}, activeViews: {}, profile: '' };
    /** id -> { dir, siteDir } for patches and views */
    this.index = { patches: new Map(), views: new Map(), sites: new Map() };
    this.problems = [];
    this.watcher = null;
    this.rootWatcher = null;
    this.reloadTimer = null;
  }

  async init() {
    await fsp.mkdir(this.sitesDir, { recursive: true });
    const readme = path.join(this.root, 'README.md');
    if (!fs.existsSync(readme)) await fsp.writeFile(readme, README);
    if (!fs.existsSync(this.profilePath)) await fsp.writeFile(this.profilePath, formatProfile());
    await this.load();
    return this;
  }

  get profilePath() {
    return path.join(this.root, 'profile.md');
  }

  /** Re-read everything from disk. */
  async load() {
    const catalog = { patches: {}, views: {}, activeViews: {}, profile: await readText(this.profilePath) };
    const index = { patches: new Map(), views: new Map(), sites: new Map() };
    const problems = [];
    const sites = (await fsp.readdir(this.sitesDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    for (const site of sites) {
      const siteDir = path.join(this.sitesDir, site.name);
      let meta;
      try {
        meta = await readJson(path.join(siteDir, 'views.json'));
      } catch (e) {
        problems.push(`${site.name}/views.json: ${e.message}`);
        continue;
      }
      if (!meta || !meta.origin) {
        problems.push(`${site.name}/views.json is missing or has no origin; skipped`);
        continue;
      }
      index.sites.set(meta.origin, siteDir);
      const views = Array.isArray(meta.views) ? meta.views : [];
      for (const v of views) {
        if (!v || !v.id || !v.slug) continue;
        const viewDir = path.join(siteDir, v.slug);
        if (!isDir(viewDir)) continue; // folder deleted by hand -> view gone
        catalog.views[v.id] = { id: v.id, origin: meta.origin, name: v.name || v.slug, createdAt: v.createdAt || 0 };
        index.views.set(v.id, { dir: viewDir, siteDir, slug: v.slug });
        const entries = (await fsp.readdir(viewDir, { withFileTypes: true })).filter((d) => d.isDirectory());
        for (const entry of entries) {
          const dir = path.join(viewDir, entry.name);
          let data;
          try {
            data = await readJson(path.join(dir, 'patch.json'));
          } catch (e) {
            problems.push(`${path.relative(this.root, dir)}/patch.json: ${e.message}`);
            continue;
          }
          if (!data || !data.id || !data.scope) {
            problems.push(`${path.relative(this.root, dir)}/patch.json is missing an id or scope; skipped`);
            continue;
          }
          const css = await readText(path.join(dir, 'style.css'));
          const js = await readText(path.join(dir, 'script.js'));
          catalog.patches[data.id] = { ...data, viewId: v.id, css, js };
          index.patches.set(data.id, { dir, siteDir, viewDir });
        }
      }
      if (meta.activeViewId && catalog.views[meta.activeViewId]) catalog.activeViews[meta.origin] = meta.activeViewId;
    }
    this.catalog = catalog;
    this.index = index;
    this.problems = problems;
    return catalog;
  }

  // ---- writing ----------------------------------------------------------------

  async siteDirFor(origin) {
    const existing = this.index.sites.get(origin);
    if (existing) return existing;
    let dir = path.join(this.sitesDir, siteSlug(origin));
    if (isDir(dir)) {
      // slug collision with another origin (http vs https): disambiguate
      const taken = (await fsp.readdir(this.sitesDir)).filter((n) => n.startsWith(siteSlug(origin)));
      dir = path.join(this.sitesDir, uniqueSlug(siteSlug(origin), taken));
    }
    await fsp.mkdir(dir, { recursive: true });
    await this.writeJson(path.join(dir, 'views.json'), { origin, views: [], activeViewId: null });
    this.index.sites.set(origin, dir);
    return dir;
  }

  async readSiteMeta(siteDir) {
    return (await readJson(path.join(siteDir, 'views.json'))) || { origin: '', views: [], activeViewId: null };
  }

  async writeJson(file, data) {
    await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n');
  }

  async saveView(view) {
    if (!view?.id || !view.origin) throw new Error('view needs id and origin');
    const siteDir = await this.siteDirFor(view.origin);
    const meta = await this.readSiteMeta(siteDir);
    let entry = meta.views.find((v) => v.id === view.id);
    if (!entry) {
      const slug = uniqueSlug(slugify(view.name, { fallback: 'view' }), meta.views.map((v) => v.slug));
      entry = { id: view.id, slug, name: view.name, createdAt: view.createdAt || Date.now() };
      meta.views.push(entry);
    } else {
      entry.name = view.name;
    }
    await fsp.mkdir(path.join(siteDir, entry.slug), { recursive: true });
    await this.writeJson(path.join(siteDir, 'views.json'), meta);
    await this.load();
    this.emit('change', this.catalog);
    return this.catalog.views[view.id];
  }

  async deleteView(id) {
    const info = this.index.views.get(id);
    if (!info) return false;
    const meta = await this.readSiteMeta(info.siteDir);
    meta.views = meta.views.filter((v) => v.id !== id);
    if (meta.activeViewId === id) meta.activeViewId = null;
    await fsp.rm(info.dir, { recursive: true, force: true });
    await this.writeJson(path.join(info.siteDir, 'views.json'), meta);
    await this.load();
    this.emit('change', this.catalog);
    return true;
  }

  async setActiveView(origin, viewId) {
    const siteDir = await this.siteDirFor(origin);
    const meta = await this.readSiteMeta(siteDir);
    if (viewId != null && !meta.views.some((v) => v.id === viewId)) throw new Error(`unknown view ${viewId} for ${origin}`);
    meta.activeViewId = viewId ?? null;
    await this.writeJson(path.join(siteDir, 'views.json'), meta);
    await this.load();
    this.emit('change', this.catalog);
    return this.catalog.activeViews;
  }

  async savePatch(patch) {
    if (!patch?.id || !patch.scope?.origin || !patch.viewId) throw new Error('patch needs id, scope.origin and viewId');
    const viewInfo = this.index.views.get(patch.viewId);
    if (!viewInfo) throw new Error(`unknown view ${patch.viewId}`);
    let info = this.index.patches.get(patch.id);
    if (!info) {
      const taken = (await fsp.readdir(viewInfo.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      const slug = uniqueSlug(slugify(patch.name, { fallback: 'patch' }), taken);
      info = { dir: path.join(viewInfo.dir, slug), siteDir: viewInfo.siteDir, viewDir: viewInfo.dir };
      await fsp.mkdir(info.dir, { recursive: true });
    }
    const { css = '', js = '', ...rest } = patch;
    await this.writeJson(path.join(info.dir, 'patch.json'), { ...rest, updatedAt: Date.now() });
    await fsp.writeFile(path.join(info.dir, 'style.css'), css);
    if (js.trim()) await fsp.writeFile(path.join(info.dir, 'script.js'), js);
    else await fsp.rm(path.join(info.dir, 'script.js'), { force: true });
    await this.load();
    this.emit('change', this.catalog);
    return this.catalog.patches[patch.id];
  }

  async deletePatch(id) {
    const info = this.index.patches.get(id);
    if (!info) return false;
    await fsp.rm(info.dir, { recursive: true, force: true });
    await this.load();
    this.emit('change', this.catalog);
    return true;
  }

  /** The parsed preferences profile. */
  get profile() {
    return parseProfile(this.catalog.profile);
  }

  async saveProfile(profile) {
    await fsp.writeFile(this.profilePath, typeof profile === 'string' ? profile : formatProfile(profile));
    await this.load();
    this.emit('change', this.catalog);
    return this.profile;
  }

  /** Where a patch lives, for "open in editor" links. */
  pathOf(id) {
    return this.index.patches.get(id)?.dir || this.index.views.get(id)?.dir || null;
  }

  // ---- watching ---------------------------------------------------------------

  watch({ debounceMs = 250 } = {}) {
    if (this.watcher) return this;
    const onChange = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(async () => {
        try {
          await this.load();
          this.emit('change', this.catalog);
        } catch (e) {
          this.emit('error', e);
        }
      }, debounceMs);
      this.reloadTimer.unref?.();
    };
    this.onWatchChange = onChange;
    this.armWatchers();
    return this;
  }

  /** (Re)create the fs watchers. A recursive watcher dies when a watched folder is removed. */
  armWatchers() {
    for (const w of [this.watcher, this.rootWatcher]) w?.close();
    const onError = (e) => {
      this.emit('watch-error', e);
      clearTimeout(this.rearmTimer);
      this.rearmTimer = setTimeout(() => {
        try {
          this.armWatchers();
          this.onWatchChange();
        } catch (err) {
          this.emit('watch-error', err);
        }
      }, 200);
      this.rearmTimer.unref?.();
    };
    this.watcher = fs.watch(this.sitesDir, { recursive: true }, this.onWatchChange);
    this.watcher.on('error', onError);
    this.rootWatcher = fs.watch(this.root, (_event, file) => file === 'profile.md' && this.onWatchChange());
    this.rootWatcher.on('error', onError);
  }

  close() {
    clearTimeout(this.reloadTimer);
    clearTimeout(this.rearmTimer);
    for (const w of [this.watcher, this.rootWatcher]) w?.close();
    this.watcher = null;
    this.rootWatcher = null;
  }
}
