import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, userPrompt } from '../../bridge/src/prompt.js';

test('systemPrompt names the page, tools and rules', () => {
  const s = systemPrompt({ url: 'https://a.test/x', harness: 'claude' });
  assert.match(s, /https:\/\/a\.test\/x/);
  for (const t of ['page_outline', 'inspect', 'preview_patch', 'verify', 'clear_preview', 'finish']) assert.match(s, new RegExp(t));
  assert.match(s, /protected attributes/);
  assert.match(s, /Harness: claude/);
  assert.match(s, /JavaScript is not available/);
  const js = systemPrompt({ url: 'https://a.test', harness: 'codex', allowJs: true });
  assert.match(js, /Return a function that undoes/);
  assert.match(js, /plus optional JavaScript/);
});

test('userPrompt includes history, existing patch and volatility', () => {
  assert.equal(userPrompt({ request: 'hide ads' }), 'Request: hide ads');
  assert.match(userPrompt({ request: 'x', profile: 'PROFILE TEXT' }), /^PROFILE TEXT\n\nRequest: x$/);
  assert.match(userPrompt({ request: 'x', existingPatch: { name: 'n', css: '', rules: [], intentionallyHidden: [] } }), /"js": ""/);
  const p = userPrompt({
    request: 'bigger',
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    existingPatch: { name: 'n', css: 'a{}', rules: [], intentionallyHidden: [] },
    volatility: { volatile: true, score: 0.8, reasons: ['react', 'busy'] },
  });
  assert.match(p, /User: hi/);
  assert.match(p, /You: hello/);
  assert.match(p, /refining an existing patch/);
  assert.match(p, /"css": "a\{\}"/);
  assert.match(p, /volatile \(score 0\.8\)/);
  assert.match(p, /Warn the user/);
  assert.match(p, /Request: bigger$/);
  const ack = userPrompt({ request: 'x', volatility: { volatile: true, score: 1, reasons: [] }, acknowledged: true });
  assert.match(ack, /has acknowledged/);
  const calm = userPrompt({ request: 'x', volatility: { volatile: false } });
  assert.equal(calm, 'Request: x');
  const long = userPrompt({ request: 'x', history: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` })) });
  assert.ok(!long.includes('m3'));
  assert.ok(long.includes('m11'));
});
