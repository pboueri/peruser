import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store, DEFAULT_ROOT } from '../../bridge/src/store.js';
import { tmpDir, rm, until } from '../helpers/tmp.js';

const origin = 'https://example.test';
const patch = (id, viewId, extra = {}) => ({ id, viewId, name: 'Big Text', scope: { type: 'origin', origin }, css: 'p{font-size:20px}', rules: [], enabled: true, ...extra });

test('DEFAULT_ROOT is under the home directory', () => {
  assert.match(DEFAULT_ROOT, /\.peruser$/);
});

test('init creates the layout; views, patches and active view round-trip through files', async () => {
  const root = await tmpDir();
  try {
    const store = await new Store({ root }).init();
    assert.ok(fs.existsSync(path.join(root, 'README.md')));
    await new Store({ root }).init(); // idempotent
    assert.deepEqual(store.catalog, { patches: {}, views: {}, activeViews: {} });

    await assert.rejects(store.saveView({}), /needs id and origin/);
    const changes = [];
    store.on('change', (c) => changes.push(c));
    const view = await store.saveView({ id: 'v1', origin, name: 'Focus mode' });
    assert.equal(view.name, 'Focus mode');
    assert.ok(fs.existsSync(path.join(root, 'sites', 'example.test', 'focus-mode')));
    await store.saveView({ id: 'v1', origin, name: 'Focus' }); // rename keeps folder
    assert.equal(store.catalog.views.v1.name, 'Focus');
    await store.saveView({ id: 'v2', origin, name: 'Focus mode', createdAt: 5 }); // slug collision -> focus-mode-2
    assert.ok(fs.existsSync(path.join(root, 'sites', 'example.test', 'focus-mode-2')));
    assert.equal(store.catalog.views.v2.createdAt, 5);

    await assert.rejects(store.savePatch({}), /needs id/);
    await assert.rejects(store.savePatch(patch('p1', 'nope')), /unknown view/);
    const saved = await store.savePatch(patch('p1', 'v1'));
    assert.equal(saved.css, 'p{font-size:20px}');
    assert.equal(saved.viewId, 'v1');
    const dir = store.pathOf('p1');
    assert.ok(dir.endsWith(path.join('focus-mode', 'big-text')));
    assert.equal(await fsp.readFile(path.join(dir, 'style.css'), 'utf8'), 'p{font-size:20px}');
    const json = JSON.parse(await fsp.readFile(path.join(dir, 'patch.json'), 'utf8'));
    assert.equal(json.css, undefined);
    await store.savePatch(patch('p2', 'v1')); // same name -> big-text-2
    assert.ok(store.pathOf('p2').endsWith('big-text-2'));
    await store.savePatch(patch('p1', 'v1', { name: 'Renamed', css: '' })); // update keeps folder
    assert.equal(store.pathOf('p1'), dir);
    assert.equal(store.catalog.patches.p1.name, 'Renamed');
    assert.equal(store.pathOf('v1'), path.join(root, 'sites', 'example.test', 'focus-mode'));
    assert.equal(store.pathOf('zzz'), null);
    const noCss = await store.savePatch({ ...patch('p3', 'v1'), css: undefined });
    assert.equal(noCss.css, '');

    await assert.rejects(store.setActiveView(origin, 'v9'), /unknown view v9/);
    assert.deepEqual(await store.setActiveView(origin, 'v1'), { [origin]: 'v1' });
    assert.deepEqual(await store.setActiveView(origin), {});
    await store.setActiveView(origin, 'v1');

    // reload from disk gives the same catalog
    const again = await new Store({ root }).init();
    assert.deepEqual(Object.keys(again.catalog.patches).sort(), ['p1', 'p2', 'p3']);
    assert.equal(again.catalog.activeViews[origin], 'v1');

    assert.equal(await store.deletePatch('p2'), true);
    assert.equal(await store.deletePatch('p2'), false);
    assert.equal(store.catalog.patches.p2, undefined);
    assert.equal(await store.deleteView('v1'), true);
    assert.equal(await store.deleteView('v1'), false);
    assert.equal(store.catalog.activeViews[origin], undefined);
    assert.equal(store.catalog.patches.p1, undefined);
    assert.ok(changes.length >= 8);
    store.close();
  } finally {
    await rm(root);
  }
});

test('site folders for colliding slugs and a second origin', async () => {
  const root = await tmpDir();
  try {
    const store = await new Store({ root }).init();
    await store.saveView({ id: 'a', origin: 'https://x.test', name: 'A' });
    await store.saveView({ id: 'b', origin: 'http://x.test', name: 'B' });
    const dirs = await fsp.readdir(path.join(root, 'sites'));
    assert.deepEqual(dirs.sort(), ['x.test', 'x.test-2']);
    assert.equal(store.catalog.views.b.origin, 'http://x.test');
  } finally {
    await rm(root);
  }
});

test('load tolerates hand-edited and broken files', async () => {
  const root = await tmpDir();
  try {
    const sites = path.join(root, 'sites');
    await fsp.mkdir(path.join(sites, 'good', 'view-a', 'patch-a'), { recursive: true });
    await fsp.mkdir(path.join(sites, 'good', 'view-a', 'broken'), { recursive: true });
    await fsp.mkdir(path.join(sites, 'good', 'view-a', 'noid'), { recursive: true });
    await fsp.mkdir(path.join(sites, 'good', 'view-a', 'empty'), { recursive: true });
    await fsp.writeFile(path.join(sites, 'good', 'view-a', 'stray.txt'), 'x');
    await fsp.mkdir(path.join(sites, 'good', 'ghost-view-folder-missing'), { recursive: true });
    await fsp.writeFile(
      path.join(sites, 'good', 'views.json'),
      JSON.stringify({
        origin: 'https://good.test',
        activeViewId: 'gone',
        views: [{ id: 'va', slug: 'view-a' }, { id: 'vgone', slug: 'not-there', name: 'Gone' }, null, { id: 'noslug' }],
      }),
    );
    await fsp.writeFile(path.join(sites, 'good', 'view-a', 'patch-a', 'patch.json'), JSON.stringify({ id: 'pa', scope: { type: 'origin', origin: 'https://good.test' } }));
    await fsp.writeFile(path.join(sites, 'good', 'view-a', 'broken', 'patch.json'), '{ not json');
    await fsp.writeFile(path.join(sites, 'good', 'view-a', 'noid', 'patch.json'), '{}');
    await fsp.mkdir(path.join(sites, 'nometa'));
    await fsp.mkdir(path.join(sites, 'badmeta'));
    await fsp.writeFile(path.join(sites, 'badmeta', 'views.json'), '{{');
    await fsp.mkdir(path.join(sites, 'noorigin'));
    await fsp.writeFile(path.join(sites, 'noorigin', 'views.json'), '{"views": "junk"}');
    await fsp.mkdir(path.join(sites, 'junkviews'));
    await fsp.writeFile(path.join(sites, 'junkviews', 'views.json'), '{"origin": "https://junk.test", "views": "junk"}');
    await fsp.writeFile(path.join(sites, 'afile'), 'x');
    const store = await new Store({ root }).init();
    assert.deepEqual(Object.keys(store.catalog.patches), ['pa']);
    assert.equal(store.catalog.patches.pa.css, '');
    assert.equal(store.catalog.views.va.name, 'view-a');
    assert.equal(store.catalog.views.vgone, undefined);
    assert.deepEqual(store.catalog.activeViews, {});
    assert.equal(store.problems.length, 6, store.problems.join('\n'));
    assert.match(store.problems.join('\n'), /broken\/patch.json/);
    assert.match(store.problems.join('\n'), /nometa\/views.json is missing/);
    assert.match(store.problems.join('\n'), /badmeta\/views.json/);
    // unreadable css / json surfaces as an error other than ENOENT
    await fsp.rm(path.join(sites, 'good', 'view-a', 'patch-a', 'style.css'), { force: true });
    await fsp.mkdir(path.join(sites, 'good', 'view-a', 'patch-a', 'style.css'));
    await assert.rejects(store.load(), /EISDIR/);
    // readSiteMeta on a folder without views.json
    assert.deepEqual(await store.readSiteMeta(path.join(sites, 'nometa')), { origin: '', views: [], activeViewId: null });
  } finally {
    await rm(root);
  }
});

test('watch reloads on external edits and ignores its own writes', async () => {
  const root = await tmpDir();
  try {
    const store = await new Store({ root }).init();
    store.watch({ debounceMs: 50 }).watch();
    await store.saveView({ id: 'v1', origin, name: 'V' });
    await store.savePatch(patch('p1', 'v1'));
    const changes = [];
    store.on('change', (c) => changes.push(c));
    const cssFile = path.join(store.pathOf('p1'), 'style.css');
    await new Promise((r) => setTimeout(r, 350)); // let the self-write suspension lapse
    await fsp.writeFile(cssFile, 'p{color:red}');
    await until(() => store.catalog.patches.p1?.css === 'p{color:red}');
    assert.ok(changes.length >= 1);
    const errors = [];
    store.on('error', (e) => errors.push(e));
    store.load = async () => {
      throw new Error('boom');
    };
    await fsp.writeFile(cssFile, 'p{color:blue}');
    await until(() => errors.length === 1);
    assert.equal(errors[0].message, 'boom');
    store.close();
    store.close();
  } finally {
    await rm(root);
  }
});
