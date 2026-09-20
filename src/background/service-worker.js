// Service worker: side panel wiring, hotkeys, the bridge connection, and
// routing between panel, bridge and content scripts.

import { MSG, createRequestChannel } from '../lib/protocol.js';
import * as store from '../lib/storage.js';
import { nextView, viewName } from '../lib/views.js';
import { hasJs } from '../lib/patch.js';
import { jsPatchesFor } from '../lib/jspatch.js';
import { runPatchJs, cleanupPatchJs, syncRegistrations, injectForNavigation, jsStatus } from './js-runner.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- bridge client ----------------------------------------------------------------

const bridge = {
  ws: null,
  channel: null,
  hello: null,
  connected: false,
  attempt: 0,
  timer: null,
  runs: new Map(), // runId -> events[]
};

function panelBroadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function connectBridge() {
  clearTimeout(bridge.timer);
  if (bridge.ws) {
    try {
      bridge.ws.close();
    } catch {}
  }
  const { bridgePort } = await store.getSettings();
  const url = `ws://127.0.0.1:${bridgePort}`;
  const ws = new WebSocket(url);
  bridge.ws = ws;
  bridge.channel = createRequestChannel((f) => ws.send(JSON.stringify(f)), { timeoutMs: 20 * 60 * 1000 });
  ws.onopen = async () => {
    bridge.attempt = 0;
    try {
      const hello = await bridge.channel.request({ type: MSG.HELLO, role: 'extension' });
      bridge.hello = hello;
      bridge.connected = true;
      await store.setCatalog(hello.catalog);
      panelBroadcast({ type: MSG.BRIDGE_STATUS_EVENT, status: bridgeStatus() });
    } catch (e) {
      console.warn('[peruser] hello failed', e);
      ws.close();
    }
  };
  ws.onmessage = async (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (bridge.channel.handle(frame)) return;
    if (frame.type === MSG.CATALOG) {
      await store.setCatalog(frame.catalog);
      bridge.hello = { ...bridge.hello, problems: frame.problems };
      panelBroadcast({ type: MSG.CATALOG_UPDATED, problems: frame.problems });
    } else if (frame.type === MSG.AGENT_EVENT) {
      const list = bridge.runs.get(frame.runId) || [];
      list.push(frame.event);
      bridge.runs.set(frame.runId, list);
      panelBroadcast({ type: MSG.AGENT_EVENT, runId: frame.runId, event: frame.event });
    } else if (frame.type === MSG.TOOL_CALL) {
      let reply;
      try {
        const res = await toolCall(frame.tabId, frame.kind, frame.payload);
        reply = { id: frame.id, type: MSG.TOOL_RESULT, result: res };
      } catch (e) {
        reply = { id: frame.id, type: MSG.ERROR, error: e.message };
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    }
  };
  ws.onclose = () => {
    if (bridge.ws !== ws) return;
    bridge.connected = false;
    bridge.channel.rejectAll('bridge disconnected');
    panelBroadcast({ type: MSG.BRIDGE_STATUS_EVENT, status: bridgeStatus() });
    const delay = Math.min(10_000, 500 * 2 ** Math.min(bridge.attempt++, 5));
    bridge.timer = setTimeout(connectBridge, delay);
  };
  ws.onerror = () => {};
}

function bridgeStatus() {
  return { connected: bridge.connected, hello: bridge.connected ? bridge.hello : null };
}

async function bridgeRequest(frame) {
  if (!bridge.connected) throw new Error('The bridge is not running. Start it with: npx peruser-bridge');
  return bridge.channel.request(frame);
}

// keep the worker (and the socket) alive while connected
chrome.alarms?.create?.('peruser-keepalive', { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm?.addListener((a) => {
  if (a.name === 'peruser-keepalive' && bridge.connected) bridge.channel.request({ type: MSG.PING }).catch(() => {});
});
setInterval(() => {
  if (bridge.connected) bridge.channel.request({ type: MSG.PING }).catch(() => {});
}, 20_000);

connectBridge();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[store.KEYS.SETTINGS]) {
    const before = changes[store.KEYS.SETTINGS].oldValue?.bridgePort;
    const after = changes[store.KEYS.SETTINGS].newValue?.bridgePort;
    if (before !== after) connectBridge();
  }
  if (changes[store.KEYS.SETTINGS] || changes[store.KEYS.PATCHES] || changes[store.KEYS.ACTIVE_VIEWS] || changes[store.KEYS.VIEWS]) syncJs();
});
syncJs();

// ---- tool calls that may involve JavaScript --------------------------------------------

async function toolCall(tabId, kind, payload) {
  const res = await sendToTab(tabId, { type: kind, ...payload });
  if (kind === MSG.PREVIEW && hasJs(payload.patch)) {
    const settings = await store.getSettings();
    if (!settings.allowJs) return { ...res, js: { ok: false, error: 'JavaScript patches are disabled in the options' } };
    await cleanupPatchJs(tabId, 'preview');
    res.js = await runPatchJs(tabId, { id: 'preview', js: payload.patch.js });
    if (!res.js.ok) res.problems = [...(res.problems || []), `js: ${res.js.error}`];
  } else if (kind === MSG.PREVIEW || kind === MSG.CLEAR_PREVIEW) {
    await cleanupPatchJs(tabId, 'preview');
  }
  return res;
}

/** Make the JS patches running in a tab match what should run there. */
async function reconcileTabJs(tabId, url, { enabled = true } = {}) {
  const [catalog, settings] = await Promise.all([store.getCatalog(), store.getSettings()]);
  const wanted = enabled && settings.allowJs ? jsPatchesFor(catalog, url) : [];
  const wantedIds = new Set(wanted.map((p) => p.id));
  let ran = [];
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => Object.keys((globalThis.__peruserScripts || { ran: {} }).ran) });
    ran = res?.result || [];
  } catch {
    /* not injectable */
  }
  const results = [];
  for (const id of ran) if (id !== 'preview' && !wantedIds.has(id)) results.push({ id, cleaned: await cleanupPatchJs(tabId, id) });
  for (const p of wanted) results.push({ id: p.id, ...(await runPatchJs(tabId, p)) });
  return results;
}

async function syncJs() {
  try {
    const [catalog, settings] = await Promise.all([store.getCatalog(), store.getSettings()]);
    await syncRegistrations(catalog, settings);
  } catch (e) {
    console.warn('[peruser] user script sync failed', e);
  }
}

chrome.webNavigation?.onDOMContentLoaded?.addListener(async (d) => {
  if (d.frameId !== 0 || !/^(https?|file):/.test(d.url)) return;
  const [catalog, settings] = await Promise.all([store.getCatalog(), store.getSettings()]);
  injectForNavigation(d.tabId, d.url, catalog, settings).catch(() => {});
});

// ---- tabs ----------------------------------------------------------------------------

async function sendToTab(tabId, msg) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    throw new Error(`Peruser is not running in that tab (reload the page): ${e.message}`);
  }
  if (!res) throw new Error('no response from the page');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function cycleView(url, tabId) {
  const origin = new URL(url).origin;
  const catalog = await store.getCatalog();
  const next = nextView(catalog.views, origin, catalog.activeViews[origin] ?? null);
  await setActiveView(origin, next);
  const name = viewName(catalog.views, next);
  if (tabId != null) sendToTab(tabId, { type: MSG.TOAST, text: `Peruser view: ${name}` }).catch(() => {});
  return { viewId: next, name };
}

async function setActiveView(origin, viewId) {
  if (bridge.connected) await bridgeRequest({ type: MSG.SET_ACTIVE_VIEW, origin, viewId });
  else await store.setActiveView(origin, viewId);
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) return;
  if (command === 'toggle-patches') sendToTab(tab.id, { type: MSG.TOGGLE }).catch(() => {});
  if (command === 'cycle-view') cycleView(tab.url, tab.id).catch(() => {});
});

// ---- messages from the panel / options ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const ownPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!ownPage && msg?.type !== 'js.sync') return false; // content scripts only ever ask for a JS sync
  (async () => {
    switch (msg?.type) {
      case 'js.sync':
        return reconcileTabJs(ownPage ? msg.tabId : sender.tab.id, msg.url, { enabled: msg.enabled !== false });
      case 'js.status':
        return jsStatus(await store.getSettings());
      case MSG.BRIDGE_STATUS:
        return bridgeStatus();
      case MSG.BRIDGE_REQUEST:
        return bridgeRequest(msg.frame);
      case 'tab.send':
        return sendToTab(msg.tabId, msg.message);
      case 'tab.active':
        return activeTab();
      case MSG.CYCLE_VIEW:
        return cycleView(msg.url, msg.tabId);
      case MSG.SET_ACTIVE_VIEW:
        return setActiveView(msg.origin, msg.viewId);
      case 'run.events':
        return bridge.runs.get(msg.runId) || [];
      case 'bridge.reconnect':
        await connectBridge();
        return bridgeStatus();
      default:
        throw new Error(`unknown message ${msg?.type}`);
    }
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
