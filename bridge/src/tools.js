// The browser tools the agent can call. Every tool runs in the live tab
// through ctx.callTab(type, payload); `finish` ends the run.
//
// Definitions are shared by the MCP stdio server (Claude Code / Codex) and
// the fake harness, so all harnesses see the same contract.

import { z } from 'zod';
import { MSG } from '../../src/lib/protocol.js';
import { RULE_ACTIONS, MOVE_POSITIONS, RISK_LEVELS, validatePatch, normalizeFinish } from '../../src/lib/patch.js';

const ruleSchema = z.object({
  action: z.enum(RULE_ACTIONS),
  selector: z.string().describe('CSS selector for the element(s) to change'),
  name: z.string().nullable().optional().describe('attribute name (setAttribute / removeAttribute)'),
  value: z.string().nullable().optional().describe('attribute value, form value (setValue) or inline CSS declarations (style)'),
  text: z.string().nullable().optional().describe('new text content (setText)'),
  className: z.string().nullable().optional().describe('class name (addClass / removeClass)'),
  target: z.string().nullable().optional().describe('reference element selector (move)'),
  position: z.enum(MOVE_POSITIONS).nullable().optional().describe('where to place the element relative to target (move)'),
});

export const patchSchema = z.object({
  name: z.string().describe('short name, 3-6 words'),
  summary: z.string().describe('one or two sentences for the user'),
  css: z.string().describe('CSS to inject; empty string if none; !important is allowed'),
  rules: z.array(ruleSchema).describe('declarative DOM changes applied after the CSS'),
  intentionallyHidden: z.array(z.string()).describe('selectors of interactive elements the user explicitly asked to hide'),
  notes: z.string().describe('assumptions and limitations; empty string if none'),
});

export const TOOL_DEFS = [
  {
    name: 'page_outline',
    description:
      'Structure of the current page: title, URL, landmarks, forms with their fields (names, types, labels; never values), clickable elements, headings, a tag tree, computed theme, volatility score and which attributes are protected. Call this first.',
    input: z.object({}),
    readOnly: true,
    async run(_input, ctx) {
      return ctx.callTab(MSG.OUTLINE, {});
    },
  },
  {
    name: 'inspect',
    description: 'Look closely at what a CSS selector matches: count, sanitised outer HTML, computed styles, protected attributes and the enclosing form of the first few matches.',
    input: z.object({ selector: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    readOnly: true,
    async run(input, ctx) {
      return ctx.callTab(MSG.INSPECT, { selector: input.selector, limit: input.limit ?? 5 });
    },
  },
  {
    name: 'preview_patch',
    description:
      'Validate a patch and apply it to the page as a live preview (replacing any previous preview). Returns validation errors, per-rule match counts and problems. The user sees the preview immediately.',
    input: z.object({ patch: patchSchema }),
    async run(input, ctx) {
      const v = validatePatch(input.patch);
      if (!v.ok) return { ok: false, errors: v.errors };
      const res = await ctx.callTab(MSG.PREVIEW, { patch: v.patch });
      return { ok: true, ...res };
    },
  },
  {
    name: 'verify',
    description:
      'Run the verification suite against the current preview: links, buttons and fields still work; forms submit the same data; CSS parses; every selector matched; no protected attribute touched; no horizontal overflow. You must call this before finish when you have a patch.',
    input: z.object({}),
    async run(_input, ctx) {
      return ctx.callTab(MSG.VERIFY, {});
    },
  },
  {
    name: 'clear_preview',
    description: 'Remove the current preview from the page.',
    input: z.object({}),
    async run(_input, ctx) {
      return ctx.callTab(MSG.CLEAR_PREVIEW, {});
    },
  },
  {
    name: 'finish',
    description:
      'End the run and report to the user. Provide the final patch (the one you previewed and verified) or null if you are not making changes; a risk level; concrete warnings; and anything you declined with the reason and an alternative. The message is shown to the user verbatim.',
    input: z.object({
      message: z.string().describe('what you tell the user, plain language'),
      patch: patchSchema.nullable(),
      risk: z.enum(RISK_LEVELS),
      warnings: z.array(z.string()),
      declined: z.array(z.object({ request: z.string(), reason: z.string(), alternative: z.string() })),
    }),
    async run(input, ctx) {
      const result = normalizeFinish(input);
      if (input.patch && !result.patch) return { ok: false, errors: result.errors, hint: 'fix the patch and call finish again' };
      ctx.finish(result);
      return { ok: true };
    },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

export function toolByName(name) {
  return TOOL_DEFS.find((t) => t.name === name) || null;
}

/** Call a tool by name with a context. Throws on unknown tool or invalid input. */
export async function runTool(name, input, ctx) {
  const tool = toolByName(name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const parsed = tool.input.safeParse(input ?? {});
  if (!parsed.success) throw new Error(`invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return tool.run(parsed.data, ctx);
}
