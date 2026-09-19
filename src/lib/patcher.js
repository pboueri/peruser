// Applies and undoes patches on a live document. Every change records how to
// reverse it, and `reapply()` is idempotent so a MutationObserver can call
// it whenever the page re-renders.

const STYLE_ATTR = 'data-peruser-patch';
const MARK_ATTR = 'data-peruser-applied';

function closestForm(el) {
  return el.closest('form');
}

function parseDeclarations(cssText) {
  const out = [];
  for (const part of String(cssText).split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (!prop || !value) continue;
    let priority = '';
    const m = value.match(/\s*!important$/i);
    if (m) {
      priority = 'important';
      value = value.slice(0, m.index).trim();
    }
    out.push({ prop, value, priority });
  }
  return out;
}

function setNativeValue(el, value) {
  let proto = Object.getPrototypeOf(el);
  let desc = null;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, 'value');
    proto = Object.getPrototypeOf(proto);
  }
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

function dispatchInput(el, doc) {
  const Ev = doc.defaultView.Event;
  el.dispatchEvent(new Ev('input', { bubbles: true }));
  el.dispatchEvent(new Ev('change', { bubbles: true }));
}

function cleanupStyle(el) {
  if (el.getAttribute && el.getAttribute('style') === '') el.removeAttribute('style');
}

function markKey(patchId, i) {
  return `${patchId}:${i}`;
}

function alreadyApplied(el, key) {
  const v = el.getAttribute(MARK_ATTR);
  return !!v && v.split(' ').includes(key);
}

function mark(el, key) {
  const v = el.getAttribute(MARK_ATTR);
  el.setAttribute(MARK_ATTR, v ? `${v} ${key}` : key);
}

function unmark(el, key) {
  const v = el.getAttribute(MARK_ATTR);
  if (!v) return;
  const rest = v.split(' ').filter((k) => k !== key);
  if (rest.length) el.setAttribute(MARK_ATTR, rest.join(' '));
  else el.removeAttribute(MARK_ATTR);
}

/**
 * Apply one rule to every element it matches that is not yet marked.
 * Returns { matched, applied, error } and pushes undo closures.
 */
function applyRule(doc, rule, key, undos, problems) {
  let nodes;
  try {
    nodes = Array.from(doc.querySelectorAll(rule.selector));
  } catch (e) {
    problems.push(`invalid selector "${rule.selector}": ${e.message}`);
    return { matched: 0, applied: 0 };
  }
  let applied = 0;
  for (const el of nodes) {
    if (alreadyApplied(el, key)) continue;
    let undo = null;
    switch (rule.action) {
      case 'hide': {
        const prev = el.style.getPropertyValue('display');
        const prio = el.style.getPropertyPriority('display');
        el.style.setProperty('display', 'none', 'important');
        undo = () => {
          prev ? el.style.setProperty('display', prev, prio) : el.style.removeProperty('display');
          cleanupStyle(el);
        };
        break;
      }
      case 'setAttribute': {
        const had = el.hasAttribute(rule.name);
        const prev = el.getAttribute(rule.name);
        el.setAttribute(rule.name, rule.value);
        undo = () => (had ? el.setAttribute(rule.name, prev) : el.removeAttribute(rule.name));
        break;
      }
      case 'removeAttribute': {
        const had = el.hasAttribute(rule.name);
        const prev = el.getAttribute(rule.name);
        el.removeAttribute(rule.name);
        undo = () => had && el.setAttribute(rule.name, prev);
        break;
      }
      case 'setText': {
        const prev = el.textContent;
        el.textContent = rule.text;
        undo = () => (el.textContent = prev);
        break;
      }
      case 'setValue': {
        if (!('value' in el)) {
          problems.push(`setValue: "${rule.selector}" is not a form control`);
          continue;
        }
        const prev = el.value;
        setNativeValue(el, rule.value);
        dispatchInput(el, doc);
        undo = () => {
          setNativeValue(el, prev);
          dispatchInput(el, doc);
        };
        break;
      }
      case 'addClass': {
        const had = el.classList.contains(rule.className);
        el.classList.add(rule.className);
        undo = () => !had && el.classList.remove(rule.className);
        break;
      }
      case 'removeClass': {
        const had = el.classList.contains(rule.className);
        el.classList.remove(rule.className);
        undo = () => had && el.classList.add(rule.className);
        break;
      }
      case 'style': {
        const decls = parseDeclarations(rule.value);
        const prevs = decls.map((d) => ({ d, value: el.style.getPropertyValue(d.prop), priority: el.style.getPropertyPriority(d.prop) }));
        for (const d of decls) el.style.setProperty(d.prop, d.value, d.priority);
        undo = () => {
          for (const p of prevs) p.value ? el.style.setProperty(p.d.prop, p.value, p.priority) : el.style.removeProperty(p.d.prop);
          cleanupStyle(el);
        };
        break;
      }
      case 'autofocus': {
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        undo = () => {};
        break;
      }
      case 'move': {
        let target;
        try {
          target = doc.querySelector(rule.target);
        } catch (e) {
          problems.push(`invalid target "${rule.target}": ${e.message}`);
          continue;
        }
        if (!target) {
          problems.push(`move: target "${rule.target}" not found`);
          continue;
        }
        const destParent = rule.position === 'before' || rule.position === 'after' ? target.parentNode : target;
        if (!destParent || destParent.nodeType !== 1 || target === el || el.contains(target)) {
          problems.push(`move: cannot move "${rule.selector}" relative to "${rule.target}"`);
          continue;
        }
        if (closestForm(el) !== closestForm(destParent)) {
          problems.push(`move: "${rule.selector}" would change which form it belongs to; refused`);
          continue;
        }
        const prevParent = el.parentNode;
        const prevNext = el.nextSibling;
        if (rule.position === 'before') target.before(el);
        else if (rule.position === 'after') target.after(el);
        else if (rule.position === 'prepend') target.prepend(el);
        else target.append(el);
        undo = () => {
          // If the page itself removed the element (or its old home) meanwhile, leave it be.
          if (!el.isConnected || !prevParent || !prevParent.isConnected) return;
          prevParent.insertBefore(el, prevNext && prevNext.parentNode === prevParent ? prevNext : null);
        };
        break;
      }
      default:
        problems.push(`unknown action ${rule.action}`);
        continue;
    }
    mark(el, key);
    undos.push(() => {
      unmark(el, key);
      undo();
    });
    applied++;
  }
  return { matched: nodes.length, applied };
}

function ensureStyle(doc, id, css) {
  let style = doc.querySelector(`style[${STYLE_ATTR}="${id}"]`);
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute(STYLE_ATTR, id);
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
  } else if (style.textContent !== css) {
    style.textContent = css;
  }
  return style;
}

/**
 * Apply a patch. Returns a handle:
 *   { id, matchCounts, problems, reapply(), undo() }
 */
export function applyPatch(doc, patch, { id = patch.id || 'preview' } = {}) {
  const undos = [];
  const problems = [];
  const matchCounts = {};
  const rules = patch.rules || [];
  let style = null;

  const run = () => {
    if (patch.css && patch.css.trim()) style = ensureStyle(doc, id, patch.css);
    rules.forEach((rule, i) => {
      const r = applyRule(doc, rule, markKey(id, i), undos, problems);
      const prev = matchCounts[i] || { matched: 0, applied: 0 };
      matchCounts[i] = { selector: rule.selector, action: rule.action, matched: Math.max(prev.matched, r.matched), applied: prev.applied + r.applied };
    });
  };
  run();

  return {
    id,
    matchCounts,
    problems,
    get styleElement() {
      return style;
    },
    reapply() {
      run();
    },
    undo() {
      while (undos.length) {
        try {
          undos.pop()();
        } catch {
          /* element gone; nothing to restore */
        }
      }
      const s = doc.querySelector(`style[${STYLE_ATTR}="${id}"]`);
      if (s) s.remove();
      style = null;
    },
  };
}

/** Selector match counts for a patch without applying it. */
export function countMatches(doc, patch) {
  return (patch.rules || []).map((rule, i) => {
    try {
      return { index: i, selector: rule.selector, action: rule.action, matched: doc.querySelectorAll(rule.selector).length };
    } catch (e) {
      return { index: i, selector: rule.selector, action: rule.action, matched: 0, error: e.message };
    }
  });
}

export const ATTRS = { STYLE_ATTR, MARK_ATTR };
