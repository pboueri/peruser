// JavaScript patches: how a patch's script is wrapped, matched and undone.
//
// A script runs once per page load in its own world. It may return a
// function, which Peruser keeps as the cleanup to run when the patch is
// toggled off; without one, only a reload fully undoes it.

import { hasJs } from './patch.js';
import { selectPatches } from './storage.js';

export const REGISTRY = '__peruserScripts';

/** Wrap user code so it runs once, records its cleanup, and reports errors. */
export function wrapUserScript(patchId, code, { guard = '' } = {}) {
  return `(() => {
  const reg = (globalThis.${REGISTRY} ||= { cleanups: {}, ran: {} });
  const id = ${JSON.stringify(patchId)};
  ${guard ? `if (!(${guard})) return;` : ''}
  if (reg.ran[id]) return;
  reg.ran[id] = true;
  try {
    const result = (function () {
${code}
    })();
    if (typeof result === 'function') reg.cleanups[id] = result;
  } catch (e) {
    reg.ran[id] = false;
    console.warn('[peruser] patch ' + id + ' failed:', e);
    reg.lastError = String(e && e.message || e);
  }
})();`;
}

/** Code that runs the stored cleanup for a patch (if any) and forgets the run. */
export function cleanupScript(patchId) {
  return `(() => {
  const reg = globalThis.${REGISTRY};
  const id = ${JSON.stringify(patchId)};
  if (!reg) return false;
  const fn = reg.cleanups[id];
  delete reg.cleanups[id];
  delete reg.ran[id];
  if (typeof fn !== 'function') return false;
  try { fn(); return true; } catch (e) { console.warn('[peruser] cleanup for ' + id + ' failed:', e); return false; }
})();`;
}

/** Chrome match pattern for a scope (query strings cannot be expressed; see scopeGuard). */
export function matchPatternFor(scope) {
  const u = new URL(scope.origin);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const base = `${u.protocol}//${host}`;
  if (scope.type === 'origin') return `${base}/*`;
  const path = scope.path.split('?')[0] || '/';
  return scope.type === 'prefix' ? `${base}${path}*` : `${base}${path}`;
}

/** JS expression evaluated in the page that is true only inside the scope. */
export function scopeGuard(scope) {
  const origin = JSON.stringify(scope.origin);
  if (scope.type === 'origin') return `location.origin === ${origin}`;
  const norm = `(location.pathname.replace(/\\/+$/, '') || '/')`;
  if (scope.type === 'prefix') {
    const p = JSON.stringify(scope.path.replace(/\/+$/, '') || '/');
    return `location.origin === ${origin} && (${p} === '/' || ${norm} === ${p} || ${norm}.startsWith(${p} + '/'))`;
  }
  return `location.origin === ${origin} && ${norm} + location.search === ${JSON.stringify(scope.path)}`;
}

/** Saved patches with JavaScript that should run on `url` (respecting view, enabled, risk). */
export function jsPatchesFor(catalog, url) {
  return selectPatches(catalog, url).filter(hasJs);
}

/** Every saved JS patch that should be registered, across all sites. */
export function allActiveJsPatches(catalog) {
  return Object.values(catalog.patches || {}).filter((p) => hasJs(p) && p.scope && p.enabled !== false && (p.risk !== 'high' || p.acknowledgedRisk) && catalog.activeViews?.[p.scope.origin] === p.viewId);
}
