// Extension-side persistence over chrome.storage.local.
//
// The bridge's files are the source of truth for patches and views; this
// module is the cache that keeps patches applying when the bridge is not
// running. Settings and per-site acknowledgements live only here.
// The storage area is injectable so the module can be unit-tested.

import { scopeMatches, scopeRank } from './scope.js';

export const KEYS = {
  PATCHES: 'patches',
  VIEWS: 'views',
  ACTIVE_VIEWS: 'activeViews',
  ACKS: 'acks',
  SETTINGS: 'settings',
  PROFILE: 'profile',
};

export const DEFAULT_SETTINGS = {
  bridgePort: 48923,
  harness: 'claude', // 'claude' | 'codex' | 'fake'
  model: '',
  globalEnabled: true,
  allowJs: false,
};

function area(custom) {
  const a = custom || globalThis.chrome?.storage?.local;
  if (!a) throw new Error('chrome.storage.local is not available');
  return a;
}

function lastError() {
  const err = globalThis.chrome?.runtime?.lastError;
  return err ? new Error(err.message) : null;
}

export function get(keys, a) {
  return new Promise((resolve, reject) => {
    const r = area(a).get(keys, (result) => {
      const err = lastError();
      err ? reject(err) : resolve(result);
    });
    if (r && typeof r.then === 'function') r.then(resolve, reject);
  });
}

export function set(obj, a) {
  return new Promise((resolve, reject) => {
    const r = area(a).set(obj, () => {
      const err = lastError();
      err ? reject(err) : resolve();
    });
    if (r && typeof r.then === 'function') r.then(() => resolve(), reject);
  });
}

// ---- settings --------------------------------------------------------------

export async function getSettings(a) {
  const { [KEYS.SETTINGS]: s } = await get([KEYS.SETTINGS], a);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(partial, a) {
  const next = { ...(await getSettings(a)), ...partial };
  await set({ [KEYS.SETTINGS]: next }, a);
  return next;
}

// ---- catalog (patches + views + active views) ------------------------------

export async function getCatalog(a) {
  const r = await get([KEYS.PATCHES, KEYS.VIEWS, KEYS.ACTIVE_VIEWS, KEYS.PROFILE], a);
  return {
    patches: r[KEYS.PATCHES] && typeof r[KEYS.PATCHES] === 'object' ? r[KEYS.PATCHES] : {},
    views: r[KEYS.VIEWS] && typeof r[KEYS.VIEWS] === 'object' ? r[KEYS.VIEWS] : {},
    activeViews: r[KEYS.ACTIVE_VIEWS] && typeof r[KEYS.ACTIVE_VIEWS] === 'object' ? r[KEYS.ACTIVE_VIEWS] : {},
    profile: typeof r[KEYS.PROFILE] === 'string' ? r[KEYS.PROFILE] : '',
  };
}

/** Replace the whole cache with what the bridge sent. */
export async function setCatalog(catalog, a) {
  await set(
    {
      [KEYS.PATCHES]: catalog?.patches || {},
      [KEYS.VIEWS]: catalog?.views || {},
      [KEYS.ACTIVE_VIEWS]: catalog?.activeViews || {},
      [KEYS.PROFILE]: catalog?.profile || '',
    },
    a,
  );
}

export async function savePatch(patch, a) {
  if (!patch?.id) throw new Error('patch needs an id');
  const { patches } = await getCatalog(a);
  patches[patch.id] = { ...patch, updatedAt: patch.updatedAt || Date.now() };
  await set({ [KEYS.PATCHES]: patches }, a);
  return patches[patch.id];
}

export async function deletePatch(id, a) {
  const { patches } = await getCatalog(a);
  delete patches[id];
  await set({ [KEYS.PATCHES]: patches }, a);
}

export async function updatePatch(id, changes, a) {
  const { patches } = await getCatalog(a);
  if (!patches[id]) return null;
  patches[id] = { ...patches[id], ...changes, updatedAt: Date.now() };
  await set({ [KEYS.PATCHES]: patches }, a);
  return patches[id];
}

export async function saveView(view, a) {
  if (!view?.id) throw new Error('view needs an id');
  const { views } = await getCatalog(a);
  views[view.id] = view;
  await set({ [KEYS.VIEWS]: views }, a);
  return view;
}

export async function deleteView(id, a) {
  const { patches, views, activeViews } = await getCatalog(a);
  const view = views[id];
  delete views[id];
  for (const p of Object.values(patches)) if (p.viewId === id) delete patches[p.id];
  if (view && activeViews[view.origin] === id) delete activeViews[view.origin];
  await set({ [KEYS.VIEWS]: views, [KEYS.PATCHES]: patches, [KEYS.ACTIVE_VIEWS]: activeViews }, a);
}

export async function setActiveView(origin, viewId, a) {
  const { activeViews } = await getCatalog(a);
  if (viewId == null) delete activeViews[origin];
  else activeViews[origin] = viewId;
  await set({ [KEYS.ACTIVE_VIEWS]: activeViews }, a);
  return activeViews;
}

// ---- acknowledgements (volatile sites, high-risk patches) -----------------

export async function getAcks(a) {
  const { [KEYS.ACKS]: acks } = await get([KEYS.ACKS], a);
  return acks && typeof acks === 'object' ? acks : {};
}

export async function acknowledge(origin, key, a) {
  const acks = await getAcks(a);
  acks[origin] = { ...(acks[origin] || {}), [key]: Date.now() };
  await set({ [KEYS.ACKS]: acks }, a);
  return acks[origin];
}

// ---- selection --------------------------------------------------------------

const createdAt = (x) => x.createdAt || 0;
const updatedAt = (x) => x.updatedAt || 0;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Pure: the patches to apply on `url` given a catalog. Only the active view
 * of the site contributes; broad scopes apply before narrow ones.
 */
export function selectPatches(catalog, url, { includeDisabled = false, viewId } = {}) {
  const origin = originOf(url);
  if (!origin) return [];
  const active = viewId !== undefined ? viewId : catalog.activeViews?.[origin] ?? null;
  if (active == null) return [];
  return Object.values(catalog.patches || {})
    .filter((p) => p && p.viewId === active && p.scope && scopeMatches(p.scope, url))
    .filter((p) => includeDisabled || p.enabled !== false)
    .filter((p) => p.risk !== 'high' || p.acknowledgedRisk)
    .sort((x, y) => scopeRank(x.scope) - scopeRank(y.scope) || createdAt(x) - createdAt(y));
}

export async function patchesForUrl(url, opts, a) {
  return selectPatches(await getCatalog(a), url, opts);
}

/** Everything about a site for the panel: views, patches per view, active view. */
export function siteSummary(catalog, url) {
  const origin = originOf(url);
  const views = Object.values(catalog.views || {})
    .filter((v) => v && v.origin === origin)
    .sort((a, b) => createdAt(a) - createdAt(b));
  const patches = Object.values(catalog.patches || {})
    .filter((p) => p?.scope?.origin === origin)
    .sort((a, b) => updatedAt(b) - updatedAt(a));
  return {
    origin,
    views,
    patches,
    activeViewId: origin ? catalog.activeViews?.[origin] ?? null : null,
  };
}

// ---- export / import ---------------------------------------------------------

export async function exportAll(a) {
  const [catalog, settings, acks] = await Promise.all([getCatalog(a), getSettings(a), getAcks(a)]);
  return { format: 'peruser-export', version: 2, exportedAt: new Date().toISOString(), settings, acks, ...catalog };
}

export async function importAll(data, { replace = false } = {}, a) {
  if (!data || data.format !== 'peruser-export' || !data.patches) throw new Error('Not a Peruser export file');
  const current = replace ? { patches: {}, views: {}, activeViews: {}, profile: '' } : await getCatalog(a);
  let count = 0;
  for (const [id, v] of Object.entries(data.views || {})) if (v && v.origin) current.views[id] = v;
  for (const [id, p] of Object.entries(data.patches)) {
    if (p && p.scope && typeof p.id === 'string') {
      current.patches[id] = p;
      count++;
    }
  }
  Object.assign(current.activeViews, data.activeViews || {});
  if (typeof data.profile === 'string' && data.profile) current.profile = data.profile;
  await setCatalog(current, a);
  return count;
}

export async function clearAll(a) {
  await setCatalog({ patches: {}, views: {}, activeViews: {}, profile: '' }, a);
}
