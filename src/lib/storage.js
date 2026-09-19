// Patch and settings persistence on top of chrome.storage.local.
// The storage area is injectable so the module can be unit-tested.

import { scopeMatches, scopeRank } from './scope.js';

const KEY_PATCHES = 'patches';
const KEY_SETTINGS = 'settings';

export const DEFAULT_SETTINGS = {
  provider: 'anthropic', // 'anthropic' | 'openai' | 'compatible'
  apiKey: '',
  model: '',
  baseUrl: '',
  effort: 'medium', // anthropic only: low | medium | high
  globalEnabled: true,
};

export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
  compatible: '',
};

function area(custom) {
  const a = custom || globalThis.chrome?.storage?.local;
  if (!a) throw new Error('chrome.storage.local is not available');
  return a;
}

async function get(keys, a) {
  return new Promise((resolve, reject) => {
    const r = area(a).get(keys, (result) => {
      const err = globalThis.chrome?.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
    if (r && typeof r.then === 'function') r.then(resolve, reject);
  });
}

async function set(obj, a) {
  return new Promise((resolve, reject) => {
    const r = area(a).set(obj, () => {
      const err = globalThis.chrome?.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
    if (r && typeof r.then === 'function') r.then(resolve, reject);
  });
}

export async function getSettings(a) {
  const { [KEY_SETTINGS]: s } = await get([KEY_SETTINGS], a);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(partial, a) {
  const current = await getSettings(a);
  const next = { ...current, ...partial };
  await set({ [KEY_SETTINGS]: next }, a);
  return next;
}

export async function getAllPatches(a) {
  const { [KEY_PATCHES]: p } = await get([KEY_PATCHES], a);
  return p && typeof p === 'object' ? p : {};
}

export async function savePatch(patch, a) {
  if (!patch?.id) throw new Error('patch needs an id');
  const all = await getAllPatches(a);
  all[patch.id] = { ...patch, updatedAt: Date.now() };
  await set({ [KEY_PATCHES]: all }, a);
  return all[patch.id];
}

export async function deletePatch(id, a) {
  const all = await getAllPatches(a);
  delete all[id];
  await set({ [KEY_PATCHES]: all }, a);
}

export async function setPatchEnabled(id, enabled, a) {
  const all = await getAllPatches(a);
  if (!all[id]) return null;
  all[id].enabled = !!enabled;
  all[id].updatedAt = Date.now();
  await set({ [KEY_PATCHES]: all }, a);
  return all[id];
}

/** Pure helper: which of `patches` apply to `url`, broad scopes first. */
export function selectPatches(patches, url, { includeDisabled = false } = {}) {
  return Object.values(patches || {})
    .filter((p) => p && p.scope && scopeMatches(p.scope, url))
    .filter((p) => includeDisabled || p.enabled !== false)
    .sort((x, y) => scopeRank(x.scope) - scopeRank(y.scope) || (x.createdAt || 0) - (y.createdAt || 0));
}

export async function patchesForUrl(url, opts, a) {
  return selectPatches(await getAllPatches(a), url, opts);
}

/** Patches whose origin matches, regardless of path (for the side panel list). */
export async function patchesForOrigin(url, a) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return [];
  }
  return Object.values(await getAllPatches(a))
    .filter((p) => p?.scope?.origin === origin)
    .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
}

export async function exportAll(a) {
  const [patches, settings] = await Promise.all([getAllPatches(a), getSettings(a)]);
  const { apiKey, ...safeSettings } = settings;
  return { format: 'peruser-export', version: 1, exportedAt: new Date().toISOString(), settings: safeSettings, patches };
}

export async function importAll(data, { replace = false } = {}, a) {
  if (!data || data.format !== 'peruser-export' || !data.patches) throw new Error('Not a Peruser export file');
  const current = replace ? {} : await getAllPatches(a);
  let count = 0;
  for (const [id, p] of Object.entries(data.patches)) {
    if (p && p.scope && typeof p.id === 'string') {
      current[id] = p;
      count++;
    }
  }
  await set({ [KEY_PATCHES]: current }, a);
  return count;
}

export async function clearAllPatches(a) {
  await set({ [KEY_PATCHES]: {} }, a);
}

export const STORAGE_KEYS = { KEY_PATCHES, KEY_SETTINGS };
