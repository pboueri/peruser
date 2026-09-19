// Patch schema, validation and CSS sanitising.
//
// A patch is what the model produces and what we persist:
// {
//   id, name, summary,
//   scope: { type, origin, path },
//   css: string,
//   rules: [ { action, selector, name?, value?, text?, className?, target?, position? } ],
//   intentionallyHidden: [selector],
//   enabled, history, createdAt, updatedAt
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

const MAX_CSS_CHARS = 60_000;
const MAX_RULES = 80;

/** JSON schema shared by the providers' structured-output modes. */
export const PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'summary', 'css', 'rules', 'intentionallyHidden', 'notes'],
  properties: {
    name: { type: 'string', description: 'Short name for the patch (3-6 words).' },
    summary: {
      type: 'string',
      description: 'One or two sentences telling the user what the patch changes.',
    },
    css: {
      type: 'string',
      description: 'CSS to inject. Empty string if none. May use !important.',
    },
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
          name: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Attribute name for setAttribute / removeAttribute; CSS property list is not needed here.',
          },
          value: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Attribute value (setAttribute), form value (setValue) or inline CSS declarations (style).',
          },
          text: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'New text content for setText.' },
          className: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Class for addClass / removeClass.' },
          target: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Selector of the reference element for move.',
          },
          position: {
            anyOf: [{ type: 'string', enum: MOVE_POSITIONS }, { type: 'null' }],
            description: 'Where to place the element relative to target for move.',
          },
        },
      },
    },
    intentionallyHidden: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Selectors of interactive elements the user explicitly asked to hide or remove. Anything else that stops working is treated as a bug.',
    },
    notes: {
      type: 'string',
      description: 'Anything the user should know: assumptions, risks, what you could not do. Empty string if none.',
    },
  },
};

/**
 * Check CSS for constructs we refuse to inject. Returns a list of problems
 * (empty when the CSS is acceptable). Syntax checking happens in the page
 * where CSSStyleSheet is available (see patcher.js).
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
    const target = m[2].trim();
    if (!/^data:(image|font)\//i.test(target) && !/^#/.test(target)) {
      problems.push(`external url() is not allowed: ${target.slice(0, 60)}`);
    }
  }
  return problems;
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Normalise and validate a raw patch object (usually from the model).
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
      case 'setAttribute': {
        const name = str(r.name).trim();
        if (!name) return errors.push(`rule ${i}: setAttribute needs a name`);
        if (/^on/i.test(name) || name.toLowerCase() === 'srcdoc') return errors.push(`rule ${i}: attribute "${name}" is not allowed`);
        if (name.toLowerCase() === 'href' || name.toLowerCase() === 'src' || name.toLowerCase() === 'action') {
          if (/^\s*javascript:/i.test(str(r.value))) return errors.push(`rule ${i}: javascript: URLs are not allowed`);
        }
        rule.name = name;
        rule.value = str(r.value);
        break;
      }
      case 'removeAttribute': {
        const name = str(r.name).trim();
        if (!name) return errors.push(`rule ${i}: removeAttribute needs a name`);
        rule.name = name;
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
      case 'hide':
      case 'autofocus':
        break;
    }
    rules.push(rule);
  });

  const intentionallyHidden = (Array.isArray(raw.intentionallyHidden) ? raw.intentionallyHidden : [])
    .map((s) => str(s).trim())
    .filter(Boolean);
  // Every `hide` rule is by definition intentional.
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

export function newPatchId() {
  const rnd = globalThis.crypto?.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `p_${Date.now().toString(36)}_${rnd}`;
}

/** Merge model output into a persisted patch record. */
export function toRecord(validated, { id, scope, history = [], existing = null }) {
  const now = Date.now();
  return {
    id: id || existing?.id || newPatchId(),
    name: validated.name,
    summary: validated.summary,
    notes: validated.notes,
    scope: scope || existing?.scope,
    css: validated.css,
    rules: validated.rules,
    intentionallyHidden: validated.intentionallyHidden,
    enabled: existing ? existing.enabled !== false : true,
    history,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
