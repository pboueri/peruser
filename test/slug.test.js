import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, siteSlug, uniqueSlug } from '../src/lib/slug.js';

test('slugify', () => {
  assert.equal(slugify('  Big Text & Focus!  '), 'big-text-focus');
  assert.equal(slugify('Crème brûlée'), 'creme-brulee');
  assert.equal(slugify(''), 'item');
  assert.equal(slugify(null, { fallback: 'x' }), 'x');
  assert.equal(slugify('a'.repeat(100), { max: 10 }), 'aaaaaaaaaa');
  assert.equal(slugify('abc-def-ghi', { max: 4 }), 'abc');
});

test('siteSlug', () => {
  assert.equal(siteSlug('https://mail.google.com'), 'mail.google.com');
  assert.equal(siteSlug('http://localhost:3000'), 'localhost_3000');
  assert.equal(siteSlug('file://'), 'file');
  assert.equal(siteSlug('not a url'), 'not-a-url');
});

test('uniqueSlug', () => {
  assert.equal(uniqueSlug('a', []), 'a');
  assert.equal(uniqueSlug('a', ['a']), 'a-2');
  assert.equal(uniqueSlug('a', ['a', 'a-2']), 'a-3');
});
