import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { wrapUserScript, cleanupScript, matchPatternFor, scopeGuard, jsPatchesFor, allActiveJsPatches, REGISTRY } from '../src/lib/jspatch.js';

function sandbox(location) {
  const ctx = { console: { warn() {} }, location, calls: [] };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

test('wrapUserScript runs once, keeps the cleanup, tolerates errors and guards', () => {
  const ctx = sandbox({ origin: 'https://a.test', pathname: '/', search: '' });
  const code = wrapUserScript('p1', 'calls.push("run"); return () => calls.push("clean");');
  vm.runInContext(code, ctx);
  vm.runInContext(code, ctx);
  assert.deepEqual(ctx.calls, ['run']);
  assert.equal(vm.runInContext(cleanupScript('p1'), ctx), true);
  assert.deepEqual(ctx.calls, ['run', 'clean']);
  assert.equal(vm.runInContext(cleanupScript('p1'), ctx), false);
  vm.runInContext(code, ctx); // can run again after cleanup
  assert.deepEqual(ctx.calls, ['run', 'clean', 'run']);

  vm.runInContext(wrapUserScript('bad', 'throw new Error("boom")'), ctx);
  assert.equal(ctx[REGISTRY].lastError, 'boom');
  assert.equal(ctx[REGISTRY].ran.bad, false);
  vm.runInContext(wrapUserScript('nocleanup', 'calls.push("x")'), ctx);
  assert.equal(vm.runInContext(cleanupScript('nocleanup'), ctx), false);
  vm.runInContext(wrapUserScript('badclean', 'return () => { throw new Error("no") }'), ctx);
  assert.equal(vm.runInContext(cleanupScript('badclean'), ctx), false);
  vm.runInContext(wrapUserScript('guarded', 'calls.push("guarded")', { guard: 'location.pathname === "/other"' }), ctx);
  assert.ok(!ctx.calls.includes('guarded'));
  const fresh = sandbox({});
  assert.equal(vm.runInContext(cleanupScript('none'), fresh), false);
  assert.equal(vm.runInContext(wrapUserScript('throws-nonerror', 'throw "str"'), fresh), undefined);
  assert.equal(fresh[REGISTRY].lastError, 'str');
});

test('match patterns and guards per scope', () => {
  const origin = 'https://app.example.com:8443';
  assert.equal(matchPatternFor({ type: 'origin', origin }), 'https://app.example.com:8443/*');
  assert.equal(matchPatternFor({ type: 'prefix', origin: 'https://a.test', path: '/docs' }), 'https://a.test/docs*');
  assert.equal(matchPatternFor({ type: 'exact', origin: 'https://a.test', path: '/p?q=1' }), 'https://a.test/p');
  assert.equal(matchPatternFor({ type: 'exact', origin: 'https://a.test', path: '' }), 'https://a.test/');

  const run = (scope, loc) => vm.runInContext(scopeGuard(scope), sandbox(loc));
  assert.equal(run({ type: 'origin', origin: 'https://a.test' }, { origin: 'https://a.test', pathname: '/x', search: '' }), true);
  assert.equal(run({ type: 'origin', origin: 'https://a.test' }, { origin: 'https://b.test', pathname: '/x', search: '' }), false);
  const prefix = { type: 'prefix', origin: 'https://a.test', path: '/docs/' };
  assert.equal(run(prefix, { origin: 'https://a.test', pathname: '/docs', search: '' }), true);
  assert.equal(run(prefix, { origin: 'https://a.test', pathname: '/docs/a/', search: '' }), true);
  assert.equal(run(prefix, { origin: 'https://a.test', pathname: '/docsx', search: '' }), false);
  assert.equal(run({ type: 'prefix', origin: 'https://a.test', path: '/' }, { origin: 'https://a.test', pathname: '/any', search: '' }), true);
  const exact = { type: 'exact', origin: 'https://a.test', path: '/p?q=1' };
  assert.equal(run(exact, { origin: 'https://a.test', pathname: '/p/', search: '?q=1' }), true);
  assert.equal(run(exact, { origin: 'https://a.test', pathname: '/p', search: '?q=2' }), false);
  assert.equal(run({ type: 'exact', origin: 'https://a.test', path: '/' }, { origin: 'https://a.test', pathname: '', search: '' }), true);
});

test('selecting js patches', () => {
  const origin = 'https://a.test';
  const mk = (id, extra) => ({ id, viewId: 'v1', scope: { type: 'origin', origin }, css: '', js: 'x()', rules: [], enabled: true, ...extra });
  const catalog = {
    activeViews: { [origin]: 'v1', 'https://b.test': 'v2' },
    patches: {
      a: mk('a'),
      b: mk('b', { js: '' }),
      c: mk('c', { enabled: false }),
      d: mk('d', { risk: 'high' }),
      e: mk('e', { risk: 'high', acknowledgedRisk: true }),
      f: mk('f', { viewId: 'v9' }),
      g: mk('g', { scope: { type: 'origin', origin: 'https://b.test' }, viewId: 'v2' }),
      h: mk('h', { scope: null }),
    },
  };
  assert.deepEqual(jsPatchesFor(catalog, 'https://a.test/x').map((p) => p.id), ['a', 'e']);
  assert.deepEqual(allActiveJsPatches(catalog).map((p) => p.id), ['a', 'e', 'g']);
  assert.deepEqual(allActiveJsPatches({}), []);
});
