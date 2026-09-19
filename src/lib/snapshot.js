// Page outline for the agent, element inspection, and volatility scoring.
// Everything here is pure DOM: it takes a document and returns JSON.
// Input values and long text never leave the page.

import { isProtectedAttribute } from './patch.js';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'svg', 'path', 'br', 'wbr']);
const LANDMARK_SELECTOR = 'header, nav, main, aside, footer, form, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="search"], [role="dialog"]';
const FIELD_SELECTOR = 'input, select, textarea, button, [contenteditable=""], [contenteditable="true"]';
const CLICKABLE_SELECTOR = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary';

export const GENERATED_CLASS_RE =
  /^(css-[a-z0-9]{4,}|sc-[a-zA-Z0-9]{4,}|jss\d+|emotion-[a-z0-9]+|[A-Za-z0-9]+_[A-Za-z0-9]+__[A-Za-z0-9]{4,}|[A-Za-z]+_[A-Za-z0-9]{5,}|_[a-z0-9]{5,}|[a-z]{1,3}-[0-9a-f]{5,}|[A-Za-z]*[0-9a-f]{6,}|[A-Za-z]+-[A-Za-z0-9]{6,}--[A-Za-z0-9]+)$/;

export function isGeneratedClass(cls) {
  if (!cls || cls.length > 40) return true;
  return GENERATED_CLASS_RE.test(cls);
}

export function text(el, max = 60) {
  const raw = (el?.textContent || '').replace(/\s+/g, ' ').trim();
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}

function escapeIdent(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

function stableClasses(el) {
  return Array.from(el.classList).filter((c) => !isGeneratedClass(c) && !c.startsWith('peruser-'));
}

function isUnique(doc, selector, el) {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** A selector that identifies `el` and survives re-renders where possible. */
export function cssPath(el, doc = el?.ownerDocument) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return tag;

  const id = el.getAttribute('id');
  if (id && !/\d{3,}|[:.]/.test(id)) {
    const s = `#${escapeIdent(id)}`;
    if (isUnique(doc, s, el)) return s;
  }
  for (const attr of ['name', 'data-testid', 'data-test', 'data-qa', 'aria-label']) {
    const v = el.getAttribute(attr);
    if (v && v.length < 80) {
      const s = `${tag}[${attr}="${v.replace(/["\\]/g, '\\$&')}"]`;
      if (isUnique(doc, s, el)) return s;
    }
  }
  const classes = stableClasses(el);
  let own = tag + classes.slice(0, 3).map((c) => '.' + escapeIdent(c)).join('');
  if (isUnique(doc, own, el)) return own;

  const parent = el.parentElement;
  if (!parent) return own;
  const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (siblings.length > 1) own += `:nth-of-type(${siblings.indexOf(el) + 1})`;
  const parentPath = cssPath(parent, doc);
  const combined = `${parentPath} > ${own}`;
  return combined;
}

function labelFor(el, doc) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, 60);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((n) => text(n, 40));
    if (parts.length) return parts.join(' ');
  }
  const id = el.getAttribute('id');
  if (id) {
    const lab = Array.from(doc.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === id);
    if (lab) return text(lab, 60);
  }
  const wrapping = el.closest('label');
  if (wrapping) return text(wrapping, 60);
  return '';
}

/** Which attributes on this element the server / scripts depend on. */
export function protectedAttributesOf(el) {
  return Array.from(el.attributes)
    .map((a) => a.name)
    .filter((n) => isProtectedAttribute(n))
    .sort();
}

function describeField(el, doc) {
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag === 'button' ? (el.getAttribute('type') || 'submit').toLowerCase() : tag;
  const d = {
    selector: cssPath(el, doc),
    tag,
    type,
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    label: labelFor(el, doc),
    placeholder: el.getAttribute('placeholder') || '',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
    submitted: !!el.getAttribute('name') && type !== 'button' && type !== 'submit' && type !== 'reset',
    protectedAttributes: protectedAttributesOf(el),
  };
  if (type === 'submit' || type === 'button' || tag === 'button') d.text = text(el, 40);
  if (tag === 'select') d.optionCount = el.querySelectorAll('option').length;
  if (type === 'hidden') d.note = 'hidden field: server token or state; never change';
  return d;
}

export function describeForms(doc) {
  const forms = Array.from(doc.querySelectorAll('form')).slice(0, 20).map((form) => ({
    selector: cssPath(form, doc),
    id: form.getAttribute('id') || '',
    name: form.getAttribute('name') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    hasAction: form.hasAttribute('action'),
    fields: Array.from(form.querySelectorAll(FIELD_SELECTOR)).slice(0, 60).map((f) => describeField(f, doc)),
  }));
  const loose = Array.from(doc.querySelectorAll(FIELD_SELECTOR))
    .filter((f) => !f.closest('form'))
    .slice(0, 40)
    .map((f) => describeField(f, doc));
  return { forms, looseFields: loose };
}

export function describeClickables(doc, limit = 80) {
  const seen = new Set();
  const out = [];
  for (const el of doc.querySelectorAll(CLICKABLE_SELECTOR)) {
    if (out.length >= limit) break;
    const t = text(el, 40) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const key = el.tagName + '|' + t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ selector: cssPath(el, doc), tag: el.tagName.toLowerCase(), text: t, inForm: !!el.closest('form') });
  }
  return out;
}

export function describeHeadings(doc, limit = 30) {
  return Array.from(doc.querySelectorAll('h1, h2, h3'))
    .slice(0, limit)
    .map((h) => ({ tag: h.tagName.toLowerCase(), text: text(h, 80), selector: cssPath(h, doc) }));
}

export function describeLandmarks(doc) {
  return Array.from(doc.querySelectorAll(LANDMARK_SELECTOR))
    .slice(0, 30)
    .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', selector: cssPath(el, doc), text: text(el, 50) }));
}

/** Indented tag tree, capped in depth and node count. */
export function describeTree(doc, { maxDepth = 7, maxNodes = 350 } = {}) {
  const lines = [];
  let count = 0;
  let truncated = false;
  const walk = (el, depth) => {
    if (count >= maxNodes) {
      truncated = true;
      return;
    }
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    count++;
    const id = el.getAttribute('id');
    const classes = stableClasses(el).slice(0, 3);
    const gen = (el.classList?.length || 0) - stableClasses(el).length;
    let line = '  '.repeat(depth) + tag;
    if (id) line += '#' + id;
    if (classes.length) line += '.' + classes.join('.');
    if (gen) line += ` (+${gen} generated classes)`;
    const role = el.getAttribute('role');
    if (role) line += ` [role=${role}]`;
    if (el.shadowRoot) line += ' [shadow]';
    const kids = el.children.length;
    const t = kids === 0 ? text(el, 40) : '';
    if (t) line += ` "${t}"`;
    if (kids > 0 && depth >= maxDepth) line += ` … ${kids} children`;
    lines.push(line);
    if (depth < maxDepth) for (const c of el.children) walk(c, depth + 1);
  };
  if (doc.body) walk(doc.body, 0);
  return { lines, truncated, nodeCount: count };
}

export function detectFrameworks(doc) {
  const found = [];
  const has = (sel) => !!doc.querySelector(sel);
  if (has('#__next, #__NEXT_DATA__, script#__NEXT_DATA__')) found.push('next');
  if (has('[data-reactroot], [data-reactid]') || Array.from(doc.scripts).some((s) => /react(-dom)?(\.production)?(\.min)?\.js/.test(s.src))) found.push('react');
  if (has('[ng-version], [ng-app], .ng-scope')) found.push('angular');
  if (has('[data-v-app], #app[data-v-], [data-server-rendered]') || Array.from(doc.querySelectorAll('[class]')).some((e) => Array.from(e.attributes).some((a) => a.name.startsWith('data-v-')))) found.push('vue');
  if (Array.from(doc.querySelectorAll('[class]')).slice(0, 300).some((e) => Array.from(e.classList).some((c) => /^svelte-/.test(c)))) found.push('svelte');
  if (has('[data-turbo], [data-turbolinks], [data-controller]')) found.push('hotwire');
  if (has('[data-ember-action], .ember-view')) found.push('ember');
  if (has('[wire\\:id]')) found.push('livewire');
  return found;
}

export function countShadowRoots(doc, limit = 2000) {
  let n = 0;
  let seen = 0;
  for (const el of doc.querySelectorAll('*')) {
    if (seen++ > limit) break;
    if (el.shadowRoot) n++;
  }
  return n;
}

export function generatedClassRatio(doc, limit = 600) {
  let total = 0;
  let gen = 0;
  for (const el of Array.from(doc.querySelectorAll('[class]')).slice(0, limit)) {
    for (const c of el.classList) {
      total++;
      if (isGeneratedClass(c)) gen++;
    }
  }
  return total ? gen / total : 0;
}

/**
 * 0 (static page) .. 1 (re-renders itself constantly, generated names).
 * `mutationsPerSecond` is measured by the runtime over the last few seconds.
 */
export function volatilityScore({ frameworks = [], mutationsPerSecond = 0, shadowRoots = 0, generatedRatio = 0, canvasHeavy = false } = {}) {
  let score = 0;
  const reasons = [];
  if (frameworks.length) {
    score += 0.3;
    reasons.push(`built with ${frameworks.join(', ')}, which re-renders the DOM from state`);
  }
  if (mutationsPerSecond >= 20) {
    score += 0.35;
    reasons.push(`the DOM changes about ${Math.round(mutationsPerSecond)} times per second while idle`);
  } else if (mutationsPerSecond >= 3) {
    score += 0.15;
    reasons.push(`the DOM keeps changing while idle (${Math.round(mutationsPerSecond)}/s)`);
  }
  if (generatedRatio >= 0.5) {
    score += 0.3;
    reasons.push(`${Math.round(generatedRatio * 100)}% of class names look generated and will change on the next deploy`);
  } else if (generatedRatio >= 0.2) {
    score += 0.15;
    reasons.push(`${Math.round(generatedRatio * 100)}% of class names look generated`);
  }
  if (shadowRoots > 0) {
    score += 0.2;
    reasons.push(`${shadowRoots} shadow DOM root${shadowRoots === 1 ? '' : 's'}: CSS cannot reach inside them`);
  }
  if (canvasHeavy) {
    score += 0.4;
    reasons.push('the content is drawn on a canvas, not built from elements');
  }
  score = Math.min(1, score);
  return { score: Math.round(score * 100) / 100, volatile: score >= 0.6, reasons };
}

export function describeTheme(doc, win) {
  if (!win?.getComputedStyle || !doc.body) return {};
  const pick = (el, props) => {
    const cs = win.getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p) || '';
    return out;
  };
  const body = pick(doc.body, ['font-family', 'font-size', 'line-height', 'color', 'background-color']);
  const link = doc.querySelector('a[href]');
  const theme = { body };
  if (link) theme.link = pick(link, ['color']);
  const button = doc.querySelector('button, [type="submit"]');
  if (button) theme.button = pick(button, ['background-color', 'color', 'border-radius', 'font-size']);
  return theme;
}

/**
 * Build the outline the agent sees. `runtime` carries measurements only
 * the live page knows (mutation rate, viewport, applied patches).
 */
export function buildOutline(doc, win, runtime = {}) {
  const url = runtime.url || doc.location.href;
  const frameworks = detectFrameworks(doc);
  const shadowRoots = countShadowRoots(doc);
  const generatedRatio = generatedClassRatio(doc);
  const canvasCount = doc.querySelectorAll('canvas').length;
  const canvasHeavy = canvasCount > 0 && doc.querySelectorAll('p, li, td, input, button, a').length < 10;
  const volatility = volatilityScore({
    frameworks,
    mutationsPerSecond: runtime.mutationsPerSecond || 0,
    shadowRoots,
    generatedRatio,
    canvasHeavy,
  });
  const tree = describeTree(doc);
  return {
    url,
    title: doc.title.slice(0, 120),
    lang: doc.documentElement?.getAttribute('lang') || '',
    viewport: runtime.viewport || null,
    volatility,
    frameworks,
    landmarks: describeLandmarks(doc),
    ...describeForms(doc),
    clickables: describeClickables(doc),
    headings: describeHeadings(doc),
    theme: describeTheme(doc, win),
    tree: tree.lines.join('\n'),
    treeTruncated: tree.truncated,
    appliedPatches: runtime.appliedPatches || [],
    protectedAttributesNote:
      'Attributes marked protected (name, id, type, for, form, action, method, data-*, aria wiring, href, src, on*) are used by the server or page scripts. Never set or remove them; hide or restyle instead.',
  };
}

/** Detailed look at what a selector matches, for the `inspect` tool. */
export function inspectSelector(doc, win, selector, { limit = 5 } = {}) {
  let nodes;
  try {
    nodes = Array.from(doc.querySelectorAll(selector));
  } catch (e) {
    return { selector, error: `invalid selector: ${e.message}`, count: 0, matches: [] };
  }
  const matches = nodes.slice(0, limit).map((el) => {
    const clone = el.cloneNode(true);
    const fields = Array.from(clone.querySelectorAll('input, textarea'));
    if (/^(input|textarea)$/i.test(clone.tagName)) fields.push(clone);
    for (const f of fields) {
      f.removeAttribute('value');
      f.textContent = '';
    }
    let html = clone.outerHTML;
    if (html.length > 800) html = html.slice(0, 800) + '…';
    const m = {
      selector: cssPath(el, doc),
      tag: el.tagName.toLowerCase(),
      html,
      text: text(el, 120),
      protectedAttributes: protectedAttributesOf(el),
      inForm: el.closest('form') ? cssPath(el.closest('form'), doc) : null,
      childCount: el.children.length,
    };
    if (win?.getComputedStyle) {
      const cs = win.getComputedStyle(el);
      m.computed = {};
      for (const p of ['display', 'position', 'width', 'height', 'font-size', 'color', 'background-color', 'visibility', 'pointer-events', 'z-index']) {
        m.computed[p] = cs.getPropertyValue(p) || '';
      }
    }
    return m;
  });
  return { selector, count: nodes.length, matches };
}
