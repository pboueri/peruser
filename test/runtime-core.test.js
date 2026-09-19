import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './helpers/dom.js';
import { PageRuntime } from '../src/lib/runtime-core.js';
import { styleOnlyMeasure } from '../src/lib/verify.js';
import { MSG } from '../src/lib/protocol.js';

const PAGE = '<form><input name="q"><button id="go">Go</button></form><p class="promo">buy</p><a href="/" id="home">Home</a>';

function make(html = PAGE) {
  const { doc, win } = dom(html);
  let t = 1000;
  const rt = new PageRuntime({ doc, win, measure: styleOnlyMeasure(win), now: () => t });
  return { doc, win, rt, tick: (ms) => (t += ms) };
}

test('mutation rate', () => {
  const { rt, tick } = make();
  assert.equal(rt.mutationsPerSecond(), 0);
  rt.noteMutations(30);
  assert.equal(rt.mutationsPerSecond(), 10);
  tick(6000);
  rt.noteMutations();
  assert.equal(rt.mutationTimes.length, 1);
  rt.noteMutations(6000);
  assert.equal(rt.mutationTimes.length, 5000);
});

test('outline, inspect and status', () => {
  const { rt } = make();
  const o = rt.outline();
  assert.equal(o.url, 'https://example.test/page');
  assert.equal(o.viewport.width, 1024);
  assert.deepEqual(o.appliedPatches, []);
  assert.equal(rt.inspect('#go').count, 1);
  assert.equal(rt.inspect('#go', 1).matches.length, 1);
  assert.deepEqual(rt.status(), { enabled: true, applied: [], preview: null, url: 'https://example.test/page' });
});

test('preview, verify, clear', () => {
  const { rt, doc } = make();
  assert.equal(rt.verifyPreview().ok, false);
  const r = rt.previewPatch({ name: 'p', css: '.promo{color:red}', rules: [{ action: 'hide', selector: '.promo' }], intentionallyHidden: ['.promo'] });
  assert.equal(r.matchCounts[0].matched, 1);
  assert.equal(doc.querySelector('.promo').style.display, 'none');
  assert.equal(rt.status().preview, 'p');
  assert.equal(rt.verifyPreview().ok, true);
  // a second preview replaces the first
  rt.previewPatch({ name: 'p2', css: '', rules: [{ action: 'style', selector: '#go', value: 'display:none' }], intentionallyHidden: [] });
  assert.equal(doc.querySelector('.promo').style.display, '');
  const report = rt.verifyPreview();
  assert.equal(report.ok, false);
  assert.match(report.summary, /interactive/);
  assert.deepEqual(rt.clearPreview(), { cleared: true });
  assert.deepEqual(rt.clearPreview(), { cleared: false });
  assert.equal(doc.getElementById('go').style.display, '');
});

test('saved patches reconcile, reapply, toggle', () => {
  const { rt, doc } = make();
  const p1 = { id: 'p1', name: 'one', updatedAt: 1, css: '', rules: [{ action: 'hide', selector: '.promo' }] };
  const p2 = { id: 'p2', name: 'two', updatedAt: 1, css: 'a{color:red}', rules: [] };
  assert.deepEqual(rt.setPatches([p1, p2]).applied, ['p1', 'p2']);
  assert.equal(doc.querySelector('.promo').style.display, 'none');
  assert.deepEqual(rt.outline().appliedPatches, ['one', 'two']);
  // unchanged patches stay, changed ones are re-applied, missing ones undone
  const p1b = { ...p1, updatedAt: 2, rules: [{ action: 'setText', selector: '.promo', text: 'x' }] };
  assert.deepEqual(rt.setPatches([p1b]).applied, ['p1']);
  assert.deepEqual(rt.setPatches([p1b]).applied, ['p1']);
  assert.equal(doc.querySelector('.promo').style.display, '');
  assert.equal(doc.querySelector('.promo').textContent, 'x');
  assert.equal(doc.querySelector('style[data-peruser-patch="p2"]'), null);
  // new matching elements get patched on reapply, preview included
  rt.previewPatch({ name: 'pv', css: '', rules: [{ action: 'addClass', selector: 'p', className: 'seen' }] });
  const p = doc.createElement('p');
  p.className = 'promo';
  doc.body.append(p);
  rt.reapplyAll();
  assert.equal(p.textContent, 'x');
  assert.ok(p.classList.contains('seen'));
  rt.clearPreview();
  // toggle off undoes everything and remembers; toggle on restores
  assert.equal(rt.toggle().enabled, false);
  assert.deepEqual(rt.status().applied, []);
  assert.equal(doc.querySelector('.promo').textContent, 'buy');
  assert.deepEqual(rt.setPatches([p1b]).applied, []);
  assert.equal(rt.setEnabled(false).enabled, false);
  assert.equal(rt.setEnabled(true).enabled, true);
  assert.deepEqual(rt.status().applied, ['p1']);
  assert.equal(doc.querySelector('.promo').textContent, 'x');
  // disabling also clears a preview
  rt.previewPatch({ name: 'pv', css: 'b{}', rules: [] });
  rt.setEnabled(false);
  assert.equal(rt.status().preview, null);
});

test('message dispatch', () => {
  const { rt } = make();
  assert.deepEqual(rt.handle({ type: MSG.PING }), { pong: true });
  assert.equal(rt.handle({ type: MSG.STATUS }).enabled, true);
  assert.equal(rt.handle({ type: MSG.OUTLINE }).title, 'T');
  assert.equal(rt.handle({ type: MSG.INSPECT, selector: 'a' }).count, 1);
  assert.equal(rt.handle({ type: MSG.PREVIEW, patch: { name: 'x', css: 'a{}', rules: [] } }).problems.length, 0);
  assert.equal(rt.handle({ type: MSG.VERIFY }).ok, true);
  assert.deepEqual(rt.handle({ type: MSG.CLEAR_PREVIEW }), { cleared: true });
  assert.deepEqual(rt.handle({ type: MSG.REFRESH }).applied, []);
  assert.equal(rt.handle({ type: MSG.TOGGLE }).enabled, false);
  assert.equal(rt.handle({ type: MSG.TOGGLE, enabled: true }).enabled, true);
  assert.throws(() => rt.handle({ type: 'nope' }), /unknown message nope/);
  assert.throws(() => rt.handle(null), /unknown message undefined/);
});

test('default measure is the browser one', () => {
  const { doc, win } = dom(PAGE);
  const rt = new PageRuntime({ doc, win });
  assert.equal(typeof rt.measure.isCovered, 'function');
});
