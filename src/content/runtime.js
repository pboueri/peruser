// Page-side runtime: applies the active view's patches, answers the
// worker's tool requests, survives SPA navigation and re-renders, and
// shows small toasts for hotkeys.

import { PageRuntime } from '../lib/runtime-core.js';
import { getCatalog, getSettings, selectPatches, KEYS } from '../lib/storage.js';
import { MSG } from '../lib/protocol.js';

const rt = new PageRuntime({ doc: document, win: window });
let currentUrl = location.href;
let refreshQueued = false;

async function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  await Promise.resolve();
  refreshQueued = false;
  try {
    const [catalog, settings] = await Promise.all([getCatalog(), getSettings()]);
    const list = settings.globalEnabled ? selectPatches(catalog, location.href) : [];
    rt.setPatches(list);
    syncJs();
  } catch (e) {
    console.warn('[peruser] refresh failed', e);
  }
}

/** Ask the worker to run / clean up JavaScript patches for this page. */
function syncJs() {
  chrome.runtime.sendMessage({ type: 'js.sync', url: location.href, enabled: rt.enabled }).catch(() => {});
}

// ---- toasts -----------------------------------------------------------------

let toastHost = null;
function toast(text) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.setAttribute('data-peruser-ui', '');
    const root = toastHost.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; pointer-events: none; }
      .t { font: 13px/1.4 system-ui, sans-serif; color: #fff; background: rgba(20, 20, 24, 0.92); padding: 8px 12px; border-radius: 8px;
           box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: 0; transform: translateY(6px); transition: opacity .15s, transform .15s; max-width: 320px; }
      .t.show { opacity: 1; transform: none; }
    </style><div class="t"></div>`;
    toastHost._el = root.querySelector('.t');
    (document.body || document.documentElement).appendChild(toastHost);
  }
  const el = toastHost._el;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastHost._timer);
  toastHost._timer = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---- messaging -----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === MSG.TOAST) {
      toast(msg.text);
      sendResponse({ ok: true });
      return false;
    }
    const result = rt.handle(msg);
    if (msg.type === MSG.TOGGLE) {
      toast(result.enabled ? 'Peruser: patches on' : 'Peruser: patches off (original page)');
      syncJs();
    }
    sendResponse({ ok: true, result });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.PATCHES] || changes[KEYS.VIEWS] || changes[KEYS.ACTIVE_VIEWS] || changes[KEYS.SETTINGS]) refresh();
});

// ---- resilience --------------------------------------------------------------------

let reapplyTimer = null;
const observer = new MutationObserver((records) => {
  let own = 0;
  for (const r of records) if (r.target?.closest?.('[data-peruser-ui]') || r.target.nodeName === 'STYLE') own++;
  if (own === records.length) return;
  rt.noteMutations(records.length - own);
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    refresh();
  }
  // throttle, not debounce: a page that mutates constantly must still get re-patched
  if (!reapplyTimer) {
    reapplyTimer = setTimeout(() => {
      reapplyTimer = null;
      rt.reapplyAll();
    }, 60);
  }
});

function start() {
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  window.addEventListener('popstate', () => setTimeout(refresh, 0));
  setInterval(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      refresh();
    }
  }, 750);
  refresh();
}

if (document.documentElement) start();
else document.addEventListener('DOMContentLoaded', start, { once: true });
