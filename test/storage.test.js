import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeArea } from './helpers/dom.js';
import * as S from '../src/lib/storage.js';

const origin = 'https://a.test';
const mk = (id, viewId, extra = {}) => ({ id, viewId, scope: { type: 'origin', origin }, css: 'a{}', rules: [], createdAt: 1, ...extra });

test('settings round trip', async () => {
  const a = fakeArea();
  assert.deepEqual(await S.getSettings(a), S.DEFAULT_SETTINGS);
  const next = await S.saveSettings({ harness: 'codex' }, a);
  assert.equal(next.harness, 'codex');
  assert.equal((await S.getSettings(a)).harness, 'codex');
});

test('promise-style area and errors', async () => {
  const a = fakeArea({ promise: true });
  await S.saveSettings({ model: 'x' }, a);
  assert.equal((await S.getSettings(a)).model, 'x');
  const bad = fakeArea({ promise: true, failWith: new Error('nope') });
  await assert.rejects(S.getSettings(bad), /nope/);
  await assert.rejects(S.set({ a: 1 }, bad), /nope/);
  const badCb = fakeArea({ failWith: new Error('cb fail') });
  await assert.rejects(S.getSettings(badCb), /cb fail/);
  await assert.rejects(S.set({ a: 1 }, badCb), /cb fail/);
  await assert.rejects(S.get(['x'], null), /not available/);
  globalThis.chrome = { storage: { local: fakeArea() } };
  await S.saveSettings({ model: 'g' });
  assert.equal((await S.getSettings()).model, 'g');
  delete globalThis.chrome;
});

test('catalog CRUD', async () => {
  const a = fakeArea();
  assert.deepEqual(await S.getCatalog(a), { patches: {}, views: {}, activeViews: {} });
  await S.saveView({ id: 'v1', origin, name: 'Focus', createdAt: 1 }, a);
  await S.savePatch(mk('p1', 'v1'), a);
  await S.savePatch(mk('p2', 'v1', { updatedAt: 7 }), a);
  await assert.rejects(S.savePatch({}, a), /needs an id/);
  await assert.rejects(S.saveView({}, a), /needs an id/);
  let c = await S.getCatalog(a);
  assert.equal(Object.keys(c.patches).length, 2);
  assert.equal(c.patches.p2.updatedAt, 7);
  assert.equal(await S.updatePatch('nope', {}, a), null);
  assert.equal((await S.updatePatch('p1', { enabled: false }, a)).enabled, false);
  await S.deletePatch('p2', a);
  assert.deepEqual(Object.keys((await S.getCatalog(a)).patches), ['p1']);

  await S.setActiveView(origin, 'v1', a);
  assert.equal((await S.getCatalog(a)).activeViews[origin], 'v1');
  await S.setActiveView(origin, null, a);
  assert.equal((await S.getCatalog(a)).activeViews[origin], undefined);
  await S.setActiveView(origin, 'v1', a);
  await S.deleteView('v1', a);
  c = await S.getCatalog(a);
  assert.deepEqual(c, { patches: {}, views: {}, activeViews: {} });
  await S.deleteView('missing', a);

  await S.setCatalog({ patches: { p9: mk('p9', 'v9') }, views: { v9: { id: 'v9', origin } } }, a);
  assert.equal((await S.getCatalog(a)).patches.p9.id, 'p9');
  await S.setCatalog(null, a);
  assert.deepEqual(await S.getCatalog(a), { patches: {}, views: {}, activeViews: {} });
  await S.set({ patches: 'junk', views: 3, activeViews: null }, a);
  assert.deepEqual(await S.getCatalog(a), { patches: {}, views: {}, activeViews: {} });
});

test('acknowledgements', async () => {
  const a = fakeArea();
  assert.deepEqual(await S.getAcks(a), {});
  await S.acknowledge(origin, 'volatility', a);
  const acks = await S.getAcks(a);
  assert.equal(typeof acks[origin].volatility, 'number');
  await S.set({ acks: 'junk' }, a);
  assert.deepEqual(await S.getAcks(a), {});
});

test('selectPatches picks the active view, scope, enabled and risk', async () => {
  const catalog = {
    views: { v1: { id: 'v1', origin, name: 'A', createdAt: 1 }, v2: { id: 'v2', origin, name: 'B', createdAt: 2 }, v3: { id: 'v3', origin, name: 'C' } },
    activeViews: { [origin]: 'v1' },
    patches: {
      p1: mk('p1', 'v1', { createdAt: 2 }),
      p2: mk('p2', 'v1', { scope: { type: 'exact', origin, path: '/x' }, createdAt: 1 }),
      p3: mk('p3', 'v2'),
      p4: mk('p4', 'v1', { enabled: false }),
      p5: mk('p5', 'v1', { risk: 'high' }),
      p6: mk('p6', 'v1', { risk: 'high', acknowledgedRisk: true, createdAt: 3 }),
      p7: null,
      p8: mk('p8', 'v1', { scope: null }),
      p10: mk('p10', 'v1', { createdAt: undefined, updatedAt: 5 }),
      p11: mk('p11', 'v1', { createdAt: undefined, updatedAt: 4 }),
    },
  };
  assert.deepEqual(S.selectPatches(catalog, 'https://a.test/x').map((p) => p.id), ['p10', 'p11', 'p1', 'p6', 'p2']);
  assert.deepEqual(S.selectPatches(catalog, 'https://a.test/y').map((p) => p.id), ['p10', 'p11', 'p1', 'p6']);
  assert.deepEqual(S.selectPatches({ activeViews: { [origin]: 'v1' } }, 'https://a.test/y'), []);
  assert.deepEqual(S.selectPatches(catalog, 'https://a.test/y', { includeDisabled: true }).map((p) => p.id), ['p10', 'p11', 'p4', 'p1', 'p6']);
  assert.deepEqual(S.selectPatches(catalog, 'https://a.test/y', { viewId: 'v2' }).map((p) => p.id), ['p3']);
  assert.deepEqual(S.selectPatches(catalog, 'https://a.test/y', { viewId: null }), []);
  assert.deepEqual(S.selectPatches({ ...catalog, activeViews: {} }, 'https://a.test/y'), []);
  assert.deepEqual(S.selectPatches({ patches: {} }, 'https://a.test/y'), []);
  assert.deepEqual(S.selectPatches(catalog, 'junk'), []);

  const a = fakeArea();
  await S.setCatalog(catalog, a);
  assert.deepEqual((await S.patchesForUrl('https://a.test/x', {}, a)).map((p) => p.id), ['p10', 'p11', 'p1', 'p6', 'p2']);

  const s = S.siteSummary(catalog, 'https://a.test/q');
  assert.equal(s.origin, origin);
  assert.deepEqual(s.views.map((v) => v.id), ['v3', 'v1', 'v2']);
  assert.equal(s.patches.length, 8);
  assert.deepEqual(s.patches.slice(0, 2).map((p) => p.id), ['p10', 'p11']);
  assert.equal(s.activeViewId, 'v1');
  assert.equal(S.siteSummary({}, 'junk').origin, null);
  assert.equal(S.siteSummary({ activeViews: {} }, 'https://a.test/').activeViewId, null);
  assert.equal(S.siteSummary({}, 'https://a.test/').activeViewId, null);
  assert.equal(S.siteSummary({}, 'junk').activeViewId, null);
});

test('export / import / clear', async () => {
  const a = fakeArea();
  await S.saveView({ id: 'v1', origin, name: 'A', createdAt: 1 }, a);
  await S.savePatch(mk('p1', 'v1'), a);
  await S.setActiveView(origin, 'v1', a);
  const data = await S.exportAll(a);
  assert.equal(data.format, 'peruser-export');
  assert.equal(Object.keys(data.patches).length, 1);

  const b = fakeArea();
  await assert.rejects(S.importAll({ format: 'x' }, {}, b), /Not a Peruser export/);
  assert.equal(await S.importAll({ ...data, patches: { ...data.patches, bad: { id: 'bad' }, worse: null }, views: { ...data.views, junk: null } }, {}, b), 1);
  assert.equal((await S.getCatalog(b)).activeViews[origin], 'v1');
  await S.savePatch(mk('p2', 'v1'), b);
  assert.equal(await S.importAll({ format: 'peruser-export', patches: {} }, { replace: true }, b), 0);
  assert.deepEqual(await S.getCatalog(b), { patches: {}, views: {}, activeViews: {} });
  await S.savePatch(mk('p3', 'v1'), b);
  await S.clearAll(b);
  assert.deepEqual((await S.getCatalog(b)).patches, {});
});
