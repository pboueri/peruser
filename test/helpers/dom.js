import { JSDOM } from 'jsdom';

export function dom(html, { url = 'https://example.test/page' } = {}) {
  const d = new JSDOM(`<!doctype html><html><head><title>T</title></head><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  return { win: d.window, doc: d.window.document, jsdom: d };
}

/** In-memory stand-in for chrome.storage.local (callback + promise styles). */
export function fakeArea({ promise = false, failWith = null } = {}) {
  const data = {};
  const area = {
    data,
    get(keys, cb) {
      const pick = () => {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      };
      if (promise) return failWith ? Promise.reject(failWith) : Promise.resolve(pick());
      if (failWith) globalThis.chrome = { runtime: { lastError: { message: failWith.message } } };
      cb(pick());
      if (failWith) delete globalThis.chrome;
    },
    set(obj, cb) {
      Object.assign(data, structuredClone(obj));
      if (promise) return failWith ? Promise.reject(failWith) : Promise.resolve();
      if (failWith) globalThis.chrome = { runtime: { lastError: { message: failWith.message } } };
      cb();
      if (failWith) delete globalThis.chrome;
    },
  };
  return area;
}
