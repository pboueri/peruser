import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFS, TOOL_NAMES, toolByName, runTool } from '../../bridge/src/tools.js';
import { MSG } from '../../src/lib/protocol.js';

function ctx() {
  const calls = [];
  const finished = [];
  return {
    calls,
    finished,
    callTab: async (kind, payload) => {
      calls.push([kind, payload]);
      return { kind, echoed: payload };
    },
    finish: (r) => finished.push(r),
  };
}

test('tool registry', () => {
  assert.deepEqual(TOOL_NAMES, ['page_outline', 'inspect', 'preview_patch', 'verify', 'clear_preview', 'finish']);
  assert.equal(toolByName('inspect').readOnly, true);
  assert.equal(toolByName('nope'), null);
  assert.equal(TOOL_DEFS.length, 6);
});

test('runTool validates input and proxies to the tab', async () => {
  const c = ctx();
  await assert.rejects(runTool('nope', {}, c), /unknown tool/);
  await assert.rejects(runTool('inspect', {}, c), /invalid input for inspect: selector/);
  await assert.rejects(runTool('inspect', 'text', c), /invalid input for inspect: \(root\)/);
  await assert.rejects(runTool('inspect', { selector: 'a', limit: 99 }, c), /limit/);
  assert.deepEqual(await runTool('page_outline', undefined, c), { kind: MSG.OUTLINE, echoed: {} });
  assert.deepEqual(await runTool('inspect', { selector: 'a' }, c), { kind: MSG.INSPECT, echoed: { selector: 'a', limit: 5 } });
  assert.deepEqual(await runTool('inspect', { selector: 'a', limit: 2 }, c), { kind: MSG.INSPECT, echoed: { selector: 'a', limit: 2 } });
  assert.deepEqual(await runTool('verify', {}, c), { kind: MSG.VERIFY, echoed: {} });
  assert.deepEqual(await runTool('clear_preview', {}, c), { kind: MSG.CLEAR_PREVIEW, echoed: {} });
});

test('preview_patch validates the patch before applying', async () => {
  const c = ctx();
  const good = { name: 'n', summary: 's', css: 'a{}', rules: [{ action: 'hide', selector: '.x' }], intentionallyHidden: [], notes: '' };
  const r = await runTool('preview_patch', { patch: good }, c);
  assert.equal(r.ok, true);
  assert.equal(r.kind, MSG.PREVIEW);
  assert.deepEqual(r.echoed.patch.intentionallyHidden, ['.x']);
  const js = await runTool('preview_patch', { patch: { ...good, js: 'document.title="x"' } }, c);
  assert.equal(js.ok, false);
  assert.match(js.errors[0], /JavaScript patches are not allowed/);
  const jsOk = await runTool('preview_patch', { patch: { ...good, js: 'document.title="x"' } }, { ...c, allowJs: true });
  assert.equal(jsOk.ok, true);
  const bad = await runTool('preview_patch', { patch: { ...good, rules: [{ action: 'setAttribute', selector: 'a', name: 'name', value: 'x' }] } }, c);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /protected/);
  assert.equal(c.calls.length, 2);
  await assert.rejects(runTool('preview_patch', { patch: { ...good, rules: [{ action: 'explode', selector: 'a' }] } }, c), /invalid input/);
});

test('finish normalises and records the result', async () => {
  const c = ctx();
  const base = { message: 'ok', patch: null, risk: 'low', warnings: [], declined: [] };
  assert.deepEqual(await runTool('finish', base, c), { ok: true });
  assert.equal(c.finished.length, 1);
  assert.equal(c.finished[0].patch, null);
  const withPatch = { ...base, patch: { name: 'n', summary: 's', css: 'a{}', rules: [], intentionallyHidden: [], notes: '' } };
  assert.deepEqual(await runTool('finish', withPatch, c), { ok: true });
  assert.equal(c.finished[1].patch.css, 'a{}');
  const broken = { ...base, patch: { name: 'n', summary: 's', css: '@import x;', rules: [], intentionallyHidden: [], notes: '' } };
  const r = await runTool('finish', broken, c);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /@import/);
  assert.equal(c.finished.length, 2);
  await assert.rejects(runTool('finish', { ...base, risk: 'extreme' }, c), /risk/);
  const jsPatch = { name: 'n', summary: 's', css: '', js: 'x()', rules: [], intentionallyHidden: [], notes: '' };
  assert.match((await runTool('finish', { ...base, patch: jsPatch }, c)).errors[0], /not allowed/);
  assert.deepEqual(await runTool('finish', { ...base, patch: jsPatch }, { ...c, allowJs: true }), { ok: true });
  assert.equal(c.finished.at(-1).risk, 'medium');
  assert.deepEqual(await runTool('finish', { ...base, risk: 'high', patch: jsPatch }, { ...c, allowJs: true }), { ok: true });
  assert.equal(c.finished.at(-1).risk, 'high');
});
