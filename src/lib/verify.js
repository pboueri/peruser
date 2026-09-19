// Verification suite: proves a patch left the page working.
//
//   const baseline = captureBaseline(doc, measure)   // before the patch
//   ... apply patch ...
//   const report = verify({ doc, win, baseline, patch, measure })
//
// `measure` abstracts layout so the suite runs under jsdom (no layout) and
// in a real browser (layout + hit testing).

import { isProtectedAttribute } from './patch.js';
import { cssPath, text } from './snapshot.js';

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const MAX_INTERACTIVE = 400;

/** Layout-aware measurement for a real browser window. */
export function browserMeasure(win) {
  return {
    isVisible(el) {
      if (!el.isConnected) return false;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
      if (cs.pointerEvents === 'none') return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      // Ancestors with display:none make the rect zero-size already; check
      // clipping via overflow hidden + zero size is enough for our purpose.
      return true;
    },
    isCovered(el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) return false; // off-screen: unknown, assume fine
      const top = win.document.elementFromPoint(x, y);
      if (!top) return false;
      return top !== el && !el.contains(top) && !top.contains(el);
    },
    scrollWidth() {
      return win.document.documentElement.scrollWidth;
    },
    viewportWidth() {
      return win.innerWidth;
    },
  };
}

/** Measurement that only looks at computed styles (jsdom-safe). */
export function styleOnlyMeasure(win) {
  return {
    isVisible(el) {
      if (!el.isConnected) return false;
      let node = el;
      while (node && node.nodeType === 1) {
        const cs = win.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (node === el && (cs.pointerEvents === 'none' || parseFloat(cs.opacity || '1') === 0)) return false;
        node = node.parentElement;
      }
      return true;
    },
    isCovered() {
      return false;
    },
    scrollWidth() {
      return 0;
    },
    viewportWidth() {
      return 0;
    },
  };
}

export function collectInteractive(doc, measure) {
  const out = [];
  for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (out.length >= MAX_INTERACTIVE) break;
    out.push({
      el,
      selector: cssPath(el, doc),
      tag: el.tagName.toLowerCase(),
      text: text(el, 40) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
      visible: measure.isVisible(el),
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
    });
  }
  return out;
}

export function collectFormPayloads(doc) {
  const win = doc.defaultView;
  const FD = win?.FormData || globalThis.FormData;
  return Array.from(doc.querySelectorAll('form')).map((form) => {
    const entries = [];
    try {
      for (const [k, v] of new FD(form)) entries.push([k, typeof v === 'string' ? v : `[file ${v.name || ''}]`]);
    } catch {
      /* form not serialisable (detached, etc.) */
    }
    return { form, selector: cssPath(form, doc), entries, controls: form.elements.length };
  });
}

export function captureBaseline(doc, measure) {
  return {
    interactive: collectInteractive(doc, measure),
    forms: collectFormPayloads(doc),
    scrollWidth: measure.scrollWidth(),
    viewportWidth: measure.viewportWidth(),
  };
}

function matchesAny(el, selectors) {
  for (const s of selectors) {
    try {
      if (el.matches(s) || (el.closest && el.closest(s))) return true;
    } catch {
      /* invalid selector */
    }
  }
  return false;
}

/** Parse CSS with the browser's engine. Returns [] when it cannot be checked. */
export function cssParseErrors(win, css) {
  if (!css || !css.trim()) return [];
  const Sheet = win?.CSSStyleSheet;
  if (!Sheet || typeof Sheet.prototype?.replaceSync !== 'function') return null; // unsupported here
  try {
    const sheet = new Sheet();
    sheet.replaceSync(css);
    const declared = (css.match(/\{/g) || []).length;
    const parsed = sheet.cssRules.length;
    if (parsed === 0 && declared > 0) return ['no rules parsed: check braces and selectors'];
    return [];
  } catch (e) {
    return [e.message];
  }
}

function entriesDiffer(a, b, ignoreKeys) {
  const norm = (entries) =>
    entries
      .filter(([k]) => !ignoreKeys.has(k))
      .map(([k, v]) => `${k}=${v}`)
      .sort();
  const x = norm(a);
  const y = norm(b);
  if (x.length !== y.length) return true;
  return x.some((v, i) => v !== y[i]);
}

/**
 * Run every check. Returns
 * { ok, checks: [{ name, ok, skipped?, details: [string] }], summary }
 */
export function verify({ doc, win, baseline, patch, measure, matchCounts = null }) {
  const checks = [];
  const intentionally = patch.intentionallyHidden || [];

  // 1. interactive elements still usable
  {
    const details = [];
    for (const item of baseline.interactive) {
      if (!item.visible || item.disabled) continue;
      const el = item.el;
      const label = `${item.tag}${item.text ? ` "${item.text}"` : ''} (${item.selector})`;
      if (!el.isConnected) {
        if (!matchesAny(el, intentionally)) details.push(`${label} was removed from the page`);
        continue;
      }
      if (matchesAny(el, intentionally)) continue;
      if (!measure.isVisible(el)) details.push(`${label} is no longer visible or clickable`);
      else if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') details.push(`${label} became disabled`);
      else if (measure.isCovered(el)) details.push(`${label} is covered by another element`);
    }
    checks.push({ name: 'interactive', title: 'Links, buttons and fields still work', ok: details.length === 0, details });
  }

  // 2. forms still submit the same payload
  {
    const details = [];
    const valueSelectors = (patch.rules || []).filter((r) => r.action === 'setValue').map((r) => r.selector);
    const now = collectFormPayloads(doc);
    for (const before of baseline.forms) {
      const after = now.find((f) => f.form === before.form);
      if (!after) {
        if (!matchesAny(before.form, intentionally)) details.push(`form ${before.selector} was removed`);
        continue;
      }
      const ignore = new Set();
      for (const sel of valueSelectors) {
        try {
          for (const el of before.form.querySelectorAll(sel)) if (el.name) ignore.add(el.name);
        } catch {
          /* invalid selector, reported elsewhere */
        }
      }
      if (entriesDiffer(before.entries, after.entries, ignore)) {
        details.push(`form ${before.selector} would now submit different data`);
      }
      if (after.controls < before.controls) details.push(`form ${before.selector} lost ${before.controls - after.controls} control(s)`);
    }
    checks.push({ name: 'forms', title: 'Forms submit the same data', ok: details.length === 0, details });
  }

  // 3. css parses
  {
    const errs = cssParseErrors(win, patch.css);
    checks.push({ name: 'css', title: 'CSS is valid', ok: !errs || errs.length === 0, skipped: errs === null, details: errs || [] });
  }

  // 4. every selector matched something
  {
    const details = [];
    const counts =
      matchCounts ||
      (patch.rules || []).map((r, i) => {
        try {
          return { index: i, selector: r.selector, action: r.action, matched: doc.querySelectorAll(r.selector).length };
        } catch (e) {
          return { index: i, selector: r.selector, action: r.action, matched: 0, error: e.message };
        }
      });
    for (const c of Object.values(counts)) {
      if (c.error) details.push(`rule ${c.action} "${c.selector}": invalid selector`);
      else if (c.matched === 0) details.push(`rule ${c.action} "${c.selector}" matches nothing on this page`);
    }
    checks.push({ name: 'selectors', title: 'Every rule found its target', ok: details.length === 0, details });
  }

  // 5. no protected attribute touched (belt and braces)
  {
    const details = [];
    for (const r of patch.rules || []) {
      if ((r.action === 'setAttribute' || r.action === 'removeAttribute') && isProtectedAttribute(r.name)) {
        details.push(`rule ${r.action} "${r.name}" on "${r.selector}" touches a protected attribute`);
      }
    }
    checks.push({ name: 'protected', title: 'No server-side contract changed', ok: details.length === 0, details });
  }

  // 6. layout did not overflow horizontally
  {
    const details = [];
    const vw = measure.viewportWidth();
    const sw = measure.scrollWidth();
    if (vw > 0 && baseline.scrollWidth <= baseline.viewportWidth && sw > vw + 1) {
      details.push(`the page now scrolls horizontally (${sw}px wide in a ${vw}px window)`);
    }
    checks.push({ name: 'layout', title: 'No horizontal overflow introduced', ok: details.length === 0, details });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks: checks.map(({ name, title, ok, skipped, details }) => ({ name, title, ok, skipped: !!skipped, details })),
    summary: failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map((c) => c.name).join(', ')}` : 'all checks passed',
  };
}
