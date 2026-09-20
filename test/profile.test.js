import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, parseProfile, formatProfile, profileForPrompt, isEmptyProfile, DEFAULT_PROFILE } from '../src/lib/profile.js';

test('format and parse round-trip', () => {
  const p = { presets: ['larger-text', 'hide-promos'], notes: 'I use a screen magnifier.\nNo yellow.' };
  const md = formatProfile(p);
  assert.match(md, /^# My preferences/);
  assert.match(md, /- \[x\] Larger text/);
  assert.match(md, /- \[ \] High contrast/);
  assert.deepEqual(parseProfile(md), p);
  assert.deepEqual(parseProfile(formatProfile()), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile(formatProfile({ notes: 'only notes' })), { presets: [], notes: 'only notes' });
  assert.deepEqual(parseProfile(''), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile(null), DEFAULT_PROFILE);
});

test('hand-written profiles are tolerated', () => {
  const md = `# whatever
- [X] larger-text
- [x] Larger text
- [x] Something custom I typed
- [ ] Nothing
Plain line before notes
## Notes
first
second`;
  const p = parseProfile(md);
  assert.deepEqual(p.presets, ['larger-text']);
  assert.equal(p.notes, 'Something custom I typed\nPlain line before notes\nfirst\nsecond');
});

test('prompt text and emptiness', () => {
  assert.equal(profileForPrompt(DEFAULT_PROFILE), '');
  assert.equal(profileForPrompt(null), '');
  const t = profileForPrompt({ presets: ['dark'], notes: 'be gentle' });
  assert.match(t, /Prefer dark: Dark backgrounds/);
  assert.match(t, /In their own words: be gentle/);
  assert.match(profileForPrompt({ presets: [], notes: 'x' }), /In their own words/);
  assert.equal(isEmptyProfile(DEFAULT_PROFILE), true);
  assert.equal(isEmptyProfile(null), true);
  assert.equal(isEmptyProfile({ presets: ['focus'] }), false);
  assert.equal(isEmptyProfile({ presets: [], notes: ' x ' }), false);
  assert.equal(PRESETS.length, 10);
});
