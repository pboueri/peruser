import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeView, viewsForOrigin, nextView, viewName, patchesInView, newViewId, ORIGINAL } from '../src/lib/views.js';

test('makeView and newViewId', () => {
  const v = makeView('https://a.test', '  Focus  ');
  assert.equal(v.origin, 'https://a.test');
  assert.equal(v.name, 'Focus');
  assert.match(v.id, /^v_/);
  assert.equal(makeView('https://a.test', '').name, 'View');
  assert.equal(makeView('https://a.test', '   ').name, 'View');
  const saved = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  assert.match(newViewId(), /^v_/);
  Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
});

test('cycling views', () => {
  const views = {
    b: { id: 'b', origin: 'https://a.test', name: 'B', createdAt: 2 },
    a: { id: 'a', origin: 'https://a.test', name: 'A', createdAt: 1 },
    z: { id: 'z', origin: 'https://other.test', name: 'Z', createdAt: 0 },
    same1: { id: 'same1', origin: 'https://s.test', name: 'S1', createdAt: 5 },
    same0: { id: 'same0', origin: 'https://s.test', name: 'S0', createdAt: 5 },
    nodate: { id: 'nodate', origin: 'https://n.test', name: 'N' },
    nodate2: { id: 'nodate2', origin: 'https://n.test', name: 'N2' },
  };
  assert.deepEqual(viewsForOrigin(views, 'https://a.test').map((v) => v.id), ['a', 'b']);
  assert.deepEqual(viewsForOrigin(views, 'https://s.test').map((v) => v.id), ['same0', 'same1']);
  assert.deepEqual(viewsForOrigin(undefined, 'https://a.test'), []);
  assert.deepEqual(viewsForOrigin(views, 'https://n.test').map((v) => v.id), ['nodate', 'nodate2']);
  assert.equal(nextView(views, 'https://a.test', ORIGINAL), 'a');
  assert.equal(nextView(views, 'https://a.test', 'a'), 'b');
  assert.equal(nextView(views, 'https://a.test', 'b'), ORIGINAL);
  assert.equal(nextView(views, 'https://a.test', 'missing'), ORIGINAL);
  assert.equal(nextView(views, 'https://none.test', 'a'), ORIGINAL);
  assert.equal(viewName(views, null), 'Original');
  assert.equal(viewName(views, 'a'), 'A');
  assert.equal(viewName(views, 'nope'), 'Unknown view');
  assert.equal(viewName(undefined, 'nope'), 'Unknown view');
});

test('patchesInView', () => {
  const patches = { p1: { id: 'p1', viewId: 'a' }, p2: { id: 'p2', viewId: 'b' }, p3: null };
  assert.deepEqual(patchesInView(patches, 'a').map((p) => p.id), ['p1']);
  assert.deepEqual(patchesInView(patches, null), []);
  assert.deepEqual(patchesInView(undefined, 'a'), []);
});
