// Patch schema, validation, protected attributes and CSS sanitising.
//
// A patch is what the agent produces and what we persist:
// {
//   id, name, summary, notes, viewId,
//   scope: { type, origin, path },
//   css: string,
//   rules: [ { action, selector, name?, value?, text?, className?, target?, position? } ],
//   intentionallyHidden: [selector],
//   risk: 'low' | 'medium' | 'high', warnings: [string],
//   enabled, acknowledgedRisk, history, createdAt, updatedAt
// }

export const RULE_ACTIONS = [
  'hide',
  'setAttribute',
  'removeAttribute',
  'setText',
  'setValue',
  'addClass',
  'removeClass',
  'style',
  'autofocus',
  'move',
];

export const MOVE_POSITIONS = ['before', 'after', 'prepend', 'append'];
export const RISK_LEVELS = ['low', 'medium', 'high'];

/**
 * Attributes the server or the page's own scripts depend on. Rules may not
 * set or remove them: changing them silently changes what gets submitted or
 * breaks script wiring while the page still *looks* fine.
 */
export const PROTECTED_ATTRIBUTES = [
  'name',
  'id',
  'type',
  'for',
  'form',
  'action',
  'method',
  'enctype',
  'target',
  'href',
  'src',
  'srcdoc',
  'aria-controls',
  'aria-owns',
  'aria-labelledby',
  'aria-describedby',
];

export function isProtectedAttribute(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n.startsWith('on') || n.startsWith('data-')) return true;
  return PROTECTED_ATTRIBUTES.includes(n);
}

const MAX_CSS_CHARS = 60_000;
const MAX_RULES = 80;

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/** JSON schema for the patch object the agent hands to `finish`. */
export const PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'summary', 'css', 'rules', 'intentionallyHidden', 'notes'],
  properties: {
    name: { type: 'string', description: 'Short name for the patch (3-6 words).' },
    summary: { type: 'string', description: 'One or two sentences telling the user what the patch changes.' },
    css: { type: 'string', description: 'CSS to inject. Empty string if none. May use !important.' },
    rules: {
      type: 'array',
      description: 'Declarative DOM changes, applied in order after the CSS.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'selector', 'name', 'value', 'text', 'className', 'target', 'position'],
        properties: {
          action: { type: 'string', enum: RULE_ACTIONS },
          selector: { type: 'string', description: 'CSS selector for the element(s) to change.' },
          name: nullable({ type: 'string' }),
          value: nullable({ type: 'string' }),
          text: nullable({ type: 'string' }),
          className: nullable({ type: 'string' }),
          target: nullable({ type: 'string' }),
          position: nullable({ type: 'string', enum: MOVE_POSITIONS }),
        },
      },
    },
    intentionallyHidden: {
      type: 'array',
      items: { type: 'string' },
      description: 'Selectors of interactive elements the user explicitly asked to hide. Anything else that stops working is a bug.',
    },
    notes: { type: 'string', description: 'Assumptions, limitations, what you could not do. Empty string if none.' },
  },
};

/** JSON schema for the agent's structured final answer. */
export const FINISH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'patch', 'risk', 'warnings', 'declined'],
  properties: {
    message: { type: 'string', description: 'What you tell the user. Plain language, no markdown headers.' },
    patch: nullable(PATCH_JSON_SCHEMA),
    risk: { type: 'string', enum: RISK_LEVELS },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Concrete ways this patch could break or drift.' },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['request', 'reason', 'alternative'],
        properties: { request: { type: 'string' }, reason: { type: 'string' }, alternative: { type: 'string' } },
      },
      description: 'Parts of the request you refused because they would break the page, with what you suggest instead.',
    },
  },
};

/**
 * Check CSS for constructs we refuse to inject. Returns a list of problems
 * (empty when the CSS is acceptable). Syntax checking happens in the page
 * where CSSStyleSheet is available (see verify.js).
 */
export function cssProblems(css) {
  const problems = [];
  if (typeof css !== 'string') return ['css must be a string'];
  if (css.length > MAX_CSS_CHARS) problems.push(`css is longer than ${MAX_CSS_CHARS} characters`);
  if (/@import\b/i.test(css)) problems.push('@import is not allowed');
  if (/-moz-binding|behavior\s*:|expression\s*\(/i.test(css)) problems.push('legacy script-bearing CSS is not allowed');
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = urlRe.exec(css))) {
    const t = m[2].trim();
    if (!/^data:(image|font)\//i.test(t) && !t.startsWith('#')) problems.push(`external url() is not allowed: ${t.slice(0, 60)}`);
  }
  return problems;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Normalise and validate a raw patch object (usually from the agent).
 * Returns { ok, patch, errors }.
 */
export function validatePatch(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, patch: null, errors: ['patch is not an object'] };

  const css = str(raw.css);
  errors.push(...cssProblems(css));

  const rules = [];
  const rawRules = Array.isArray(raw.rules) ? raw.rules : [];
  if (rawRules.length > MAX_RULES) errors.push(`too many rules (${rawRules.length} > ${MAX_RULES})`);
  rawRules.slice(0, MAX_RULES).forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`rule ${i} is not an object`);
    if (!RULE_ACTIONS.includes(r.action)) return errors.push(`rule ${i}: unknown action "${r.action}"`);
    const selector = str(r.selector).trim();
    if (!selector) return errors.push(`rule ${i}: missing selector`);
    const rule = { action: r.action, selector };
    switch (r.action) {
      case 'setAttribute':
      case 'removeAttribute': {
        const name = str(r.name).trim();
        if (!name) return errors.push(`rule ${i}: ${r.action} needs a name`);
        if (isProtectedAttribute(name)) {
          return errors.push(`rule ${i}: "${name}" is protected (the server or page scripts depend on it)`);
        }
        rule.name = name;
        if (r.action === 'setAttribute') {
          const value = str(r.value);
          if (/^\s*javascript:/i.test(value)) return errors.push(`rule ${i}: javascript: URLs are not allowed`);
          rule.value = value;
        }
        break;
      }
      case 'setText':
        rule.text = str(r.text);
        break;
      case 'setValue':
        rule.value = str(r.value);
        break;
      case 'addClass':
      case 'removeClass': {
        const cn = str(r.className).trim();
        if (!cn) return errors.push(`rule ${i}: ${r.action} needs a className`);
        rule.className = cn;
        break;
      }
      case 'style': {
        const value = str(r.value).trim();
        if (!value) return errors.push(`rule ${i}: style needs a value`);
        const problems = cssProblems(value);
        if (problems.length) return errors.push(`rule ${i}: ${problems.join('; ')}`);
        rule.value = value;
        break;
      }
      case 'move': {
        const target = str(r.target).trim();
        if (!target) return errors.push(`rule ${i}: move needs a target`);
        if (!MOVE_POSITIONS.includes(r.position)) return errors.push(`rule ${i}: move needs a position`);
        rule.target = target;
        rule.position = r.position;
        break;
      }
      default:
        // hide, autofocus
        break;
    }
    rules.push(rule);
  });

  const intentionallyHidden = (Array.isArray(raw.intentionallyHidden) ? raw.intentionallyHidden : [])
    .map((s) => str(s).trim())
    .filter(Boolean);
  for (const r of rules) if (r.action === 'hide' && !intentionallyHidden.includes(r.selector)) intentionallyHidden.push(r.selector);

  const patch = {
    name: str(raw.name).trim().slice(0, 80) || 'Untitled patch',
    summary: str(raw.summary).trim().slice(0, 600),
    notes: str(raw.notes).trim().slice(0, 1000),
    css,
    rules,
    intentionallyHidden,
  };
  if (!patch.css.trim() && patch.rules.length === 0) errors.push('patch changes nothing (no css and no rules)');
  return { ok: errors.length === 0, patch, errors };
}

/** Normalise the agent's structured final answer. */
export function normalizeFinish(raw) {
  const out = {
    message: str(raw?.message).trim(),
    risk: RISK_LEVELS.includes(raw?.risk) ? raw.risk : 'medium',
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).map(str).filter(Boolean),
    declined: (Array.isArray(raw?.declined) ? raw.declined : [])
      .filter((d) => d && typeof d === 'object')
      .map((d) => ({ request: str(d.request), reason: str(d.reason), alternative: str(d.alternative) })),
    patch: null,
    errors: [],
  };
  if (raw?.patch) {
    const v = validatePatch(raw.patch);
    out.patch = v.ok ? v.patch : null;
    out.errors = v.errors;
  }
  if (!out.message) out.message = out.patch ? out.patch.summary : 'No changes were made.';
  return out;
}

export function newPatchId() {
  const rnd = globalThis.crypto?.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `p_${Date.now().toString(36)}_${rnd}`;
}

/** Merge a validated patch and finish metadata into a persisted record. */
export function toRecord(validated, { id, scope, viewId, risk = 'low', warnings = [], history = [], existing = null } = {}) {
  const now = Date.now();
  return {
    id: id || existing?.id || newPatchId(),
    name: validated.name,
    summary: validated.summary,
    notes: validated.notes,
    viewId: viewId ?? existing?.viewId ?? null,
    scope: scope || existing?.scope,
    css: validated.css,
    rules: validated.rules,
    intentionallyHidden: validated.intentionallyHidden,
    risk,
    warnings,
    enabled: existing ? existing.enabled !== false : true,
    acknowledgedRisk: risk === 'high' ? false : true,
    history,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
