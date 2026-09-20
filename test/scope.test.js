import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeScope, scopeMatches, describeScope, scopeRank, SCOPE_TYPES } from '../src/lib/scope.js';

test('makeScope builds each scope type', () => {
  const url = 'https://app.example.com:8443/docs/guide/?q=1#top';
  assert.deepEqual(makeScope('origin', url), { type: 'origin', origin: 'https://app.example.com:8443' });
  assert.deepEqual(makeScope('prefix', url), { type: 'prefix', origin: 'https://app.example.com:8443', path: '/docs/guide' });
  assert.deepEqual(makeScope('exact', url), { type: 'exact', origin: 'https://app.example.com:8443', path: '/docs/guide?q=1' });
  assert.deepEqual(makeScope('prefix', 'https://x.test'), { type: 'prefix', origin: 'https://x.test', path: '/' });
  assert.throws(() => makeScope('origin', 'not a url'), /Invalid URL/);
  assert.throws(() => makeScope('nope', 'https://x.test'), /Unknown scope type/);
});

test('scopeMatches', () => {
  const origin = makeScope('origin', 'https://a.test/x');
  assert.equal(scopeMatches(origin, 'https://a.test/other?y=2'), true);
  assert.equal(scopeMatches(origin, 'https://b.test/x'), false);
  assert.equal(scopeMatches(origin, 'garbage'), false);
  assert.equal(scopeMatches(null, 'https://a.test'), false);

  const prefix = makeScope('prefix', 'https://a.test/docs/');
  assert.equal(scopeMatches(prefix, 'https://a.test/docs'), true);
  assert.equal(scopeMatches(prefix, 'https://a.test/docs/a/b'), true);
  assert.equal(scopeMatches(prefix, 'https://a.test/docsx'), false);
  assert.equal(scopeMatches(makeScope('prefix', 'https://a.test/'), 'https://a.test/anything'), true);

  const exact = makeScope('exact', 'https://a.test/p?q=1#h');
  assert.equal(scopeMatches(exact, 'https://a.test/p?q=1'), true);
  assert.equal(scopeMatches(exact, 'https://a.test/p/?q=1#other'), true);
  assert.equal(scopeMatches(exact, 'https://a.test/p?q=2'), false);

  assert.equal(scopeMatches({ type: 'weird', origin: 'https://a.test' }, 'https://a.test/'), false);
  // hand-edited scopes without a leading slash or with an empty path still work
  assert.equal(scopeMatches({ type: 'prefix', origin: 'https://a.test', path: 'docs' }, 'https://a.test/docs/x'), true);
  assert.equal(scopeMatches({ type: 'prefix', origin: 'https://a.test', path: '' }, 'https://a.test/anything'), true);
});

test('describeScope and scopeRank', () => {
  assert.equal(describeScope(null), '');
  assert.equal(describeScope(makeScope('origin', 'https://a.test/x')), 'all of a.test');
  assert.equal(describeScope(makeScope('prefix', 'https://a.test/docs')), 'a.test/docs/…');
  assert.equal(describeScope(makeScope('prefix', 'https://a.test/')), 'a.test/');
  assert.equal(describeScope(makeScope('exact', 'https://a.test/p?x=1')), 'a.test/p?x=1');
  assert.equal(describeScope({ type: 'other', origin: 'https://a.test' }), 'a.test');
  assert.deepEqual(SCOPE_TYPES.map((t) => scopeRank({ type: t })), [0, 1, 2]);
  assert.equal(scopeRank(undefined), 0);
});
