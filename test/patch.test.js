import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePatch,
  cssProblems,
  isProtectedAttribute,
  normalizeFinish,
  toRecord,
  newPatchId,
  PATCH_JSON_SCHEMA,
  FINISH_JSON_SCHEMA,
} from '../src/lib/patch.js';

test('cssProblems', () => {
  assert.deepEqual(cssProblems('a { color: red }'), []);
  assert.deepEqual(cssProblems(42), ['css must be a string']);
  assert.match(cssProblems('@import url(x.css);')[0], /@import/);
  assert.match(cssProblems('a{behavior:url(x.htc)}').join(), /legacy/);
  assert.match(cssProblems('a{background:url(https://evil.test/x.png)}')[0], /external url/);
  assert.deepEqual(cssProblems('a{background:url("data:image/png;base64,AAAA")} b{fill:url(#grad)}'), []);
  assert.match(cssProblems('x'.repeat(60_001))[0], /longer/);
});

test('isProtectedAttribute', () => {
  for (const n of ['name', 'ID', 'data-x', 'onclick', 'href', 'aria-controls']) assert.equal(isProtectedAttribute(n), true, n);
  for (const n of ['class', 'title', 'placeholder', 'aria-label', '', null]) assert.equal(isProtectedAttribute(n), false, String(n));
});

test('validatePatch accepts a good patch and normalises it', () => {
  const v = validatePatch({
    name: ' Big inputs ',
    summary: 'bigger',
    css: 'input{font-size:18px}',
    notes: null,
    rules: [
      { action: 'hide', selector: '.promo' },
      { action: 'setAttribute', selector: 'input', name: 'placeholder', value: 'Type here' },
      { action: 'removeAttribute', selector: 'input', name: 'title' },
      { action: 'setText', selector: 'h1', text: 'Hi' },
      { action: 'setValue', selector: '#q', value: 'x' },
      { action: 'addClass', selector: 'body', className: 'wide' },
      { action: 'removeClass', selector: 'body', className: 'narrow' },
      { action: 'style', selector: 'p', value: 'color: red' },
      { action: 'autofocus', selector: '#q' },
      { action: 'move', selector: '#a', target: '#b', position: 'after' },
    ],
    intentionallyHidden: ['.other', ''],
  });
  assert.equal(v.ok, true, v.errors.join());
  assert.equal(v.patch.name, 'Big inputs');
  assert.equal(v.patch.notes, '');
  assert.equal(v.patch.rules.length, 10);
  assert.deepEqual(v.patch.intentionallyHidden, ['.other', '.promo']);
  assert.deepEqual(v.patch.rules[1], { action: 'setAttribute', selector: 'input', name: 'placeholder', value: 'Type here' });
  assert.deepEqual(v.patch.rules[9], { action: 'move', selector: '#a', target: '#b', position: 'after' });
});

test('validatePatch rejects bad input', () => {
  assert.equal(validatePatch(null).ok, false);
  assert.equal(validatePatch('x').ok, false);
  const errs = (raw) => validatePatch(raw).errors.join('\n');
  assert.match(errs({ css: '', rules: [] }), /changes nothing/);
  assert.match(errs({ css: 'a{}', rules: ['x'] }), /rule 0 is not an object/);
  assert.match(errs({ css: 'a{}', rules: [{ action: 'nope', selector: 'a' }] }), /unknown action/);
  assert.match(errs({ css: 'a{}', rules: [{ action: 'hide', selector: ' ' }] }), /missing selector/);
  assert.match(errs({ rules: [{ action: 'setAttribute', selector: 'a' }] }), /needs a name/);
  assert.match(errs({ rules: [{ action: 'setAttribute', selector: 'a', name: 'name', value: 'x' }] }), /protected/);
  assert.match(errs({ rules: [{ action: 'removeAttribute', selector: 'a', name: 'data-id' }] }), /protected/);
  assert.match(errs({ rules: [{ action: 'setAttribute', selector: 'a', name: 'title', value: ' javascript:alert(1)' }] }), /javascript:/);
  assert.match(errs({ rules: [{ action: 'addClass', selector: 'a' }] }), /needs a className/);
  assert.match(errs({ rules: [{ action: 'style', selector: 'a' }] }), /needs a value/);
  assert.match(errs({ rules: [{ action: 'style', selector: 'a', value: 'background:url(http://x/y.png)' }] }), /external url/);
  assert.match(errs({ rules: [{ action: 'move', selector: 'a' }] }), /needs a target/);
  assert.match(errs({ rules: [{ action: 'move', selector: 'a', target: 'b', position: 'inside' }] }), /needs a position/);
  assert.match(errs({ rules: Array.from({ length: 81 }, () => ({ action: 'hide', selector: 'a' })) }), /too many rules/);
  assert.equal(validatePatch({ name: 'x'.repeat(100), css: 'a{}', rules: 'notarray' }).patch.name.length, 80);
  assert.equal(validatePatch({ css: 'a{}' }).patch.name, 'Untitled patch');
});

test('normalizeFinish', () => {
  const f = normalizeFinish({
    message: ' done ',
    risk: 'high',
    warnings: ['w', 3, null],
    declined: [{ request: 'r', reason: 'x', alternative: 'y' }, 'junk'],
    patch: { css: 'a{}', rules: [] },
  });
  assert.equal(f.message, 'done');
  assert.equal(f.risk, 'high');
  assert.deepEqual(f.warnings, ['w', '3']);
  assert.deepEqual(f.declined, [{ request: 'r', reason: 'x', alternative: 'y' }]);
  assert.equal(f.patch.css, 'a{}');
  assert.deepEqual(f.errors, []);

  const bad = normalizeFinish({ patch: { css: '@import x;', rules: [] }, risk: 'silly' });
  assert.equal(bad.patch, null);
  assert.equal(bad.risk, 'medium');
  assert.ok(bad.errors.length);
  assert.equal(bad.message, 'No changes were made.');
  assert.equal(normalizeFinish({ patch: { css: 'a{}', summary: 'sum' } }).message, 'sum');
  assert.equal(normalizeFinish(null).message, 'No changes were made.');
});

test('toRecord and newPatchId', () => {
  const v = validatePatch({ name: 'n', summary: 's', css: 'a{}', rules: [] }).patch;
  const rec = toRecord(v, { scope: { type: 'origin', origin: 'https://a.test' }, viewId: 'v1', risk: 'high', warnings: ['w'] });
  assert.match(rec.id, /^p_/);
  assert.equal(rec.enabled, true);
  assert.equal(rec.acknowledgedRisk, false);
  assert.equal(rec.viewId, 'v1');
  const existing = { ...rec, enabled: false, createdAt: 5 };
  const rec2 = toRecord(v, { existing });
  assert.equal(rec2.id, rec.id);
  assert.equal(rec2.enabled, false);
  assert.equal(rec2.createdAt, 5);
  assert.equal(rec2.acknowledgedRisk, true);
  assert.equal(rec2.viewId, 'v1');
  const rec3 = toRecord(v, {});
  assert.equal(rec3.viewId, null);
  assert.equal(rec3.scope, undefined);
  const saved = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  assert.match(newPatchId(), /^p_/);
  Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
  assert.equal(PATCH_JSON_SCHEMA.type, 'object');
  assert.ok(FINISH_JSON_SCHEMA.required.includes('patch'));
});
