// A stand-in for the extension's service worker + content script: connects
// to a bridge over WebSocket and answers tool calls with a PageRuntime on
// a jsdom page.

import { MSG, createRequestChannel } from '../../src/lib/protocol.js';
import { PageRuntime } from '../../src/lib/runtime-core.js';
import { styleOnlyMeasure } from '../../src/lib/verify.js';
import { dom } from './dom.js';

export async function connectFakeExtension(url, { html = '<form><input name="q"><button id="go">Go</button></form><p class="promo">buy</p>', tabs = null } = {}) {
  const ws = new WebSocket(url);
  const pages = tabs || { 1: dom(html) };
  const runtimes = {};
  for (const [tabId, { doc, win }] of Object.entries(pages)) runtimes[tabId] = new PageRuntime({ doc, win, measure: styleOnlyMeasure(win) });
  const channel = createRequestChannel((f) => ws.send(JSON.stringify(f)), { timeoutMs: 5000 });
  const events = [];
  const catalogs = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data));
    if (channel.handle(frame)) return;
    if (frame.type === MSG.TOOL_CALL) {
      const rt = runtimes[frame.tabId];
      try {
        if (!rt) throw new Error(`no tab ${frame.tabId}`);
        const result = rt.handle({ type: frame.kind, ...frame.payload });
        ws.send(JSON.stringify({ id: frame.id, type: MSG.TOOL_RESULT, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: frame.id, type: MSG.ERROR, error: e.message }));
      }
      return;
    }
    if (frame.type === MSG.AGENT_EVENT) events.push(frame);
    if (frame.type === MSG.CATALOG) catalogs.push(frame);
    for (const w of waiters.splice(0)) w(frame);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const request = (frame) => channel.request(frame);
  const hello = await request({ type: MSG.HELLO, role: 'extension' });
  return {
    ws,
    hello,
    events,
    catalogs,
    runtimes,
    pages,
    request,
    closed,
    raw: (text) => ws.send(text),
    /** Resolve when an agent event matching pred arrives (or already did). */
    waitFor(pred, timeoutMs = 5000) {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for event')), timeoutMs);
        const check = () => {
          const f = events.find(pred);
          if (f) {
            clearTimeout(timer);
            resolve(f);
          } else waiters.push(check);
        };
        waiters.push(check);
      });
    },
    waitForFrame(pred, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
        const check = (frame) => {
          if (pred(frame)) {
            clearTimeout(timer);
            resolve(frame);
          } else waiters.push(check);
        };
        waiters.push(check);
      });
    },
    close: () => ws.close(),
  };
}
