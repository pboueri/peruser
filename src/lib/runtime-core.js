// The page-side runtime, free of chrome.* APIs so it can run under jsdom.
// The content script wires it to messaging, storage and observers.

import { buildOutline, inspectSelector } from './snapshot.js';
import { applyPatch } from './patcher.js';
import { captureBaseline, verify, browserMeasure } from './verify.js';
import { MSG } from './protocol.js';

const PREVIEW_ID = 'preview';

export class PageRuntime {
  constructor({ doc, win, measure = null, now = Date.now } = {}) {
    this.doc = doc;
    this.win = win;
    this.measure = measure || browserMeasure(win);
    this.now = now;
    this.applied = new Map(); // patchId -> { handle, updatedAt }
    this.enabled = true;
    this.desired = []; // last list given to setPatches
    this.preview = null; // { handle, baseline, patch }
    this.mutationTimes = [];
  }

  // ---- measurements ------------------------------------------------------------

  noteMutations(count = 1) {
    const t = this.now();
    for (let i = 0; i < count; i++) this.mutationTimes.push(t);
    const cutoff = t - 5000;
    while (this.mutationTimes.length && this.mutationTimes[0] < cutoff) this.mutationTimes.shift();
    if (this.mutationTimes.length > 5000) this.mutationTimes.splice(0, this.mutationTimes.length - 5000);
  }

  mutationsPerSecond(windowMs = 3000) {
    const t = this.now();
    const n = this.mutationTimes.filter((x) => x >= t - windowMs).length;
    return n / (windowMs / 1000);
  }

  status() {
    return {
      enabled: this.enabled,
      applied: [...this.applied.keys()],
      preview: this.preview ? this.preview.patch.name : null,
      url: this.doc.location.href,
    };
  }

  // ---- tools --------------------------------------------------------------------

  outline() {
    return buildOutline(this.doc, this.win, {
      url: this.doc.location.href,
      mutationsPerSecond: this.mutationsPerSecond(),
      viewport: { width: this.win.innerWidth, height: this.win.innerHeight },
      appliedPatches: [...this.applied.values()].map((a) => a.name),
    });
  }

  inspect(selector, limit) {
    return inspectSelector(this.doc, this.win, selector, { limit });
  }

  previewPatch(patch) {
    this.clearPreview();
    const baseline = captureBaseline(this.doc, this.measure);
    const handle = applyPatch(this.doc, patch, { id: PREVIEW_ID });
    this.preview = { handle, baseline, patch };
    return { matchCounts: Object.values(handle.matchCounts), problems: handle.problems };
  }

  verifyPreview() {
    if (!this.preview) return { ok: false, checks: [], summary: 'there is no preview to verify; call preview_patch first' };
    const { handle, baseline, patch } = this.preview;
    handle.reapply();
    return verify({ doc: this.doc, win: this.win, baseline, patch, measure: this.measure, matchCounts: handle.matchCounts });
  }

  clearPreview() {
    if (!this.preview) return { cleared: false };
    this.preview.handle.undo();
    this.preview = null;
    return { cleared: true };
  }

  // ---- saved patches --------------------------------------------------------------

  /** Reconcile what is applied with the list the extension wants applied. */
  setPatches(list) {
    this.desired = list;
    if (!this.enabled) return this.status();
    const wanted = new Map(list.map((p) => [p.id, p]));
    for (const [id, entry] of this.applied) {
      const p = wanted.get(id);
      if (!p || p.updatedAt !== entry.updatedAt) {
        entry.handle.undo();
        this.applied.delete(id);
      }
    }
    for (const p of list) {
      if (this.applied.has(p.id)) continue;
      const handle = applyPatch(this.doc, p, { id: p.id });
      this.applied.set(p.id, { handle, updatedAt: p.updatedAt, name: p.name });
    }
    return this.status();
  }

  /** Re-run idempotent rules after the page mutated. */
  reapplyAll() {
    for (const entry of this.applied.values()) entry.handle.reapply();
    if (this.preview) this.preview.handle.reapply();
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return this.status();
    this.enabled = enabled;
    if (!enabled) {
      for (const entry of this.applied.values()) entry.handle.undo();
      this.applied.clear();
      this.clearPreview();
    } else {
      this.setPatches(this.desired);
    }
    return this.status();
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  // ---- message dispatch --------------------------------------------------------------

  /** Handle a message from the worker / panel. Returns a result or throws. */
  handle(msg) {
    switch (msg?.type) {
      case MSG.PING:
        return { pong: true };
      case MSG.STATUS:
        return this.status();
      case MSG.OUTLINE:
        return this.outline();
      case MSG.INSPECT:
        return this.inspect(msg.selector, msg.limit);
      case MSG.PREVIEW:
        return this.previewPatch(msg.patch);
      case MSG.VERIFY:
        return this.verifyPreview();
      case MSG.CLEAR_PREVIEW:
        return this.clearPreview();
      case MSG.REFRESH:
        return this.setPatches(msg.patches || []);
      case MSG.TOGGLE:
        return typeof msg.enabled === 'boolean' ? this.setEnabled(msg.enabled) : this.toggle();
      default:
        throw new Error(`unknown message ${msg?.type}`);
    }
  }
}
