// Runs JavaScript patches in tabs.
//
// Preferred: chrome.userScripts (Chrome 120+; the user must enable
// "Allow User Scripts" for the extension). Scripts registered there persist,
// run on every matching page, and are immune to the page's CSP.
// Fallback: chrome.scripting in the MAIN world, injected by us on every
// navigation. Subject to the page's CSP (eval must be allowed).

import { wrapUserScript, cleanupScript, matchPatternFor, scopeGuard, allActiveJsPatches, jsPatchesFor } from '../lib/jspatch.js';

const PREFIX = 'peruser-';

export function userScriptsApi() {
  try {
    const api = chrome.userScripts;
    if (api && typeof api.register === 'function') return api;
  } catch {
    /* permission toggle not enabled */
  }
  return null;
}

export async function jsStatus(settings) {
  const api = userScriptsApi();
  return {
    allowed: !!settings.allowJs,
    engine: api ? (typeof api.execute === 'function' ? 'userScripts' : 'userScripts-register-only') : 'scripting',
    hint: api
      ? ''
      : 'For JavaScript patches to survive strict pages, enable "Allow User Scripts" for Peruser on chrome://extensions (Chrome 138+; earlier versions need Developer mode).',
  };
}

async function execRaw(tabId, code) {
  const api = userScriptsApi();
  if (api && typeof api.execute === 'function') {
    const [res] = await api.execute({ target: { tabId }, js: [{ code }], world: 'USER_SCRIPT' });
    if (res?.error) throw new Error(res.error.message || String(res.error));
    return res?.result;
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (src) => {
      try {
        return { ok: true, result: (0, eval)(src) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    args: [code],
  });
  if (!res?.result?.ok) throw new Error(res?.result?.error || 'script injection failed (the page may block eval)');
  return res.result.result;
}

/** Run a patch's JS in a tab now. Returns { ok, error? , engine }. */
export async function runPatchJs(tabId, patch) {
  const engine = userScriptsApi()?.execute ? 'userScripts' : 'scripting';
  try {
    await execRaw(tabId, wrapUserScript(patch.id || 'preview', patch.js, { guard: patch.scope ? scopeGuard(patch.scope) : '' }));
    const err = await execRaw(tabId, `(globalThis.__peruserScripts || {}).lastError || null`).catch(() => null);
    if (err) {
      await execRaw(tabId, `delete (globalThis.__peruserScripts || {}).lastError`).catch(() => {});
      return { ok: false, error: err, engine };
    }
    return { ok: true, engine };
  } catch (e) {
    return { ok: false, error: e.message, engine };
  }
}

/** Undo a patch's JS in a tab: true when its cleanup ran. */
export async function cleanupPatchJs(tabId, patchId) {
  try {
    return !!(await execRaw(tabId, cleanupScript(patchId)));
  } catch {
    return false;
  }
}

/** Keep chrome.userScripts registrations in sync with the saved catalog. */
export async function syncRegistrations(catalog, settings) {
  const api = userScriptsApi();
  if (!api) return { engine: 'scripting', registered: 0 };
  const wanted = settings.allowJs ? allActiveJsPatches(catalog) : [];
  const existing = await api.getScripts();
  const keep = new Set();
  const toRegister = [];
  const toUpdate = [];
  for (const p of wanted) {
    const id = PREFIX + p.id;
    keep.add(id);
    const script = { id, matches: [matchPatternFor(p.scope)], js: [{ code: wrapUserScript(p.id, p.js, { guard: scopeGuard(p.scope) }) }], runAt: 'document_idle', world: 'USER_SCRIPT' };
    const cur = existing.find((s) => s.id === id);
    if (!cur) toRegister.push(script);
    else if (cur.js?.[0]?.code !== script.js[0].code || cur.matches?.[0] !== script.matches[0]) toUpdate.push(script);
  }
  const toRemove = existing.filter((s) => s.id.startsWith(PREFIX) && !keep.has(s.id)).map((s) => s.id);
  if (toRemove.length) await api.unregister({ ids: toRemove });
  if (toUpdate.length) await api.update(toUpdate);
  if (toRegister.length) await api.register(toRegister);
  return { engine: 'userScripts', registered: wanted.length };
}

/** Fallback path: inject JS patches for a page that just loaded. */
export async function injectForNavigation(tabId, url, catalog, settings) {
  if (!settings.allowJs || userScriptsApi()) return [];
  const results = [];
  for (const p of jsPatchesFor(catalog, url)) results.push({ id: p.id, ...(await runPatchJs(tabId, p)) });
  return results;
}
