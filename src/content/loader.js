// Classic content script (document_start). It only loads the ES-module
// runtime; everything else lives there.
(() => {
  if (globalThis.__peruserLoaded) return;
  globalThis.__peruserLoaded = true;
  import(chrome.runtime.getURL('src/content/runtime.js')).catch((e) => console.warn('[peruser] failed to load runtime', e));
})();
