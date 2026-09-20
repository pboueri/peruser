import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './helpers/dom.js';
import { applyPatch } from '../src/lib/patcher.js';
import * as V from '../src/lib/verify.js';

const PAGE = `
<nav><a href="/">Home</a><a href="/x" id="promo">Promo</a></nav>
<form id="f"><input name="q" value="1"><input type="hidden" name="csrf" value="t"><select name="s"><option value="a" selected>a</option></select><button id="go">Go</button></form>
<form id="g"><input name="z" value="9"><button>Z</button></form>
<div role="button" tabindex="0" id="rb">rb</div><div tabindex="-1">skip</div>
<button disabled id="dis">d</button>`;

function run(doc, win, patch, measure = V.styleOnlyMeasure(win)) {
  const baseline = V.captureBaseline(doc, measure);
  const h = applyPatch(doc, patch);
  const report = V.verify({ doc, win, baseline, patch, measure, matchCounts: h.matchCounts });
  return { h, report, baseline };
}

const check = (report, name) => report.checks.find((c) => c.name === name);

test('a harmless patch passes every check', () => {
  const { doc, win } = dom(PAGE);
  const { report } = run(doc, win, { id: 'p', css: 'nav{background:pink}', rules: [{ action: 'style', selector: '#go', value: 'font-size:20px' }] });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.summary, 'all checks passed');
  assert.equal(check(report, 'css').skipped, true);
});

test('hiding an unlisted interactive element fails; listing it passes', () => {
  const { doc, win } = dom(PAGE);
  let r = run(doc, win, { id: 'p', css: '', rules: [{ action: 'style', selector: '#promo', value: 'display:none' }], intentionallyHidden: [] });
  assert.equal(r.report.ok, false);
  assert.match(check(r.report, 'interactive').details[0], /Promo.*no longer visible/);
  assert.match(r.report.summary, /1 check failed: interactive/);
  r.h.undo();
  r = run(doc, win, { id: 'p', css: '', rules: [{ action: 'hide', selector: '#promo' }], intentionallyHidden: ['#promo'] });
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
  r.h.undo();
  // hiding an ancestor listed as intentional covers descendants; invalid selectors in the list are ignored
  r = run(doc, win, { id: 'p', css: '', rules: [{ action: 'hide', selector: 'nav' }], intentionallyHidden: ['<<', 'nav'] });
  assert.equal(check(r.report, 'interactive').ok, true);
});

test('removed elements, disabled elements and covered elements are reported', () => {
  const { doc, win } = dom(PAGE);
  const measure = { ...V.styleOnlyMeasure(win), isCovered: (el) => el.id === 'rb' };
  const baseline = V.captureBaseline(doc, measure);
  doc.getElementById('promo').remove();
  doc.getElementById('go').setAttribute('disabled', '');
  doc.getElementById('g').remove();
  const report = V.verify({ doc, win, baseline, patch: { rules: [] }, measure });
  const d = check(report, 'interactive').details.join('\n');
  assert.match(d, /Promo.*was removed/);
  assert.match(d, /Go.*became disabled/);
  assert.match(d, /rb.*covered/);
  assert.match(check(report, 'forms').details.join(), /form #g was removed/);
  const r2 = V.verify({ doc, win, baseline, patch: { rules: [], intentionallyHidden: ['#promo', '#g'] }, measure });
  assert.ok(!check(r2, 'interactive').details.join().includes('Promo'));
  assert.ok(!check(r2, 'forms').details.join().includes('#g'));
  const r3 = V.verify({ doc, win, baseline, patch: { rules: [] }, measure: { ...measure, isVisible: () => true, isCovered: () => false } });
  assert.match(check(r3, 'interactive').details.join(), /aria-disabled|became disabled/);
});

test('elements replaced by a re-render are matched up with their replacement', () => {
  const { doc, win } = dom('<div id="root"><a href="/x" id="lnk">Go</a><button id="b">B</button></div>');
  const measure = V.styleOnlyMeasure(win);
  const baseline = V.captureBaseline(doc, measure);
  // the page re-renders: same ids and text, new nodes
  doc.getElementById('root').innerHTML = '<a href="/x" id="lnk">Go</a><button id="b" style="display:none">B</button>';
  const report = V.verify({ doc, win, baseline, patch: { rules: [] }, measure });
  const d = check(report, 'interactive').details;
  assert.equal(d.length, 1);
  assert.match(d[0], /button "B".*no longer visible/);
  // replacement with different text does not count
  doc.getElementById('root').innerHTML = '<a href="/x" id="lnk">Other</a><button id="b">B</button>';
  const r2 = V.verify({ doc, win, baseline, patch: { rules: [] }, measure });
  assert.match(check(r2, 'interactive').details[0], /a "Go".*was removed/);
  // intentionally hidden replacement is fine; invalid baseline selectors are tolerated
  doc.getElementById('root').innerHTML = '<a href="/x" id="lnk">Go</a><button id="b" style="display:none">B</button>';
  const r3 = V.verify({ doc, win, baseline, patch: { rules: [], intentionallyHidden: ['#b'] }, measure });
  assert.equal(check(r3, 'interactive').ok, true);
  const weird = { ...baseline, interactive: baseline.interactive.map((i) => ({ ...i, selector: '<<' })) };
  doc.getElementById('root').innerHTML = '';
  const r4 = V.verify({ doc, win, baseline: weird, patch: { rules: [] }, measure });
  assert.equal(check(r4, 'interactive').details.length, 2);
});

test('aria-disabled counts as disabled', () => {
  const { doc, win } = dom(PAGE);
  const measure = V.styleOnlyMeasure(win);
  const baseline = V.captureBaseline(doc, measure);
  doc.getElementById('go').setAttribute('aria-disabled', 'true');
  const report = V.verify({ doc, win, baseline, patch: { rules: [] }, measure });
  assert.match(check(report, 'interactive').details.join(), /became disabled/);
});

test('form payload changes are caught unless made by setValue', () => {
  const { doc, win } = dom(PAGE);
  let r = run(doc, win, { id: 'p', rules: [{ action: 'setValue', selector: 'input[name="q"]', value: '2' }] });
  assert.equal(check(r.report, 'forms').ok, true);
  r.h.undo();
  r = run(doc, win, { id: 'p', rules: [{ action: 'setValue', selector: '<<', value: '2' }, { action: 'setAttribute', selector: 'select', name: 'disabled', value: '' }] });
  assert.equal(check(r.report, 'forms').ok, false);
  assert.match(check(r.report, 'forms').details[0], /different data/);
  r.h.undo();
  const measure = V.styleOnlyMeasure(win);
  const baseline = V.captureBaseline(doc, measure);
  doc.querySelector('input[name="csrf"]').remove();
  const report = V.verify({ doc, win, baseline, patch: { rules: [] }, measure });
  assert.match(check(report, 'forms').details.join('|'), /lost 1 control/);
});

test('selectors, protected attributes, css and layout checks', () => {
  const { doc, win } = dom(PAGE);
  const measure = { ...V.styleOnlyMeasure(win), scrollWidth: () => 1200, viewportWidth: () => 1000 };
  const baseline = { ...V.captureBaseline(doc, measure), scrollWidth: 900, viewportWidth: 1000 };
  const patch = {
    css: 'a{',
    rules: [
      { action: 'hide', selector: '.nothing' },
      { action: 'hide', selector: '<<' },
      { action: 'setAttribute', selector: 'a', name: 'name', value: 'x' },
      { action: 'removeAttribute', selector: 'a', name: 'data-y' },
    ],
  };
  const fakeWin = {
    CSSStyleSheet: class {
      replaceSync(css) {
        if (css.includes('{') && !css.includes('}')) throw new Error('unbalanced');
        this.cssRules = css.includes('none') ? [] : [1];
      }
    },
  };
  fakeWin.CSSStyleSheet.prototype.replaceSync = fakeWin.CSSStyleSheet.prototype.replaceSync;
  const report = V.verify({ doc, win: fakeWin, baseline, patch, measure });
  assert.equal(report.ok, false);
  assert.match(check(report, 'selectors').details.join('|'), /matches nothing/);
  assert.match(check(report, 'selectors').details.join('|'), /invalid selector/);
  assert.equal(check(report, 'protected').details.length, 2);
  assert.deepEqual(check(report, 'css').details, ['unbalanced']);
  assert.match(check(report, 'layout').details[0], /scrolls horizontally/);
  assert.match(report.summary, /4 checks failed/);
  assert.deepEqual(V.cssParseErrors(fakeWin, 'x { none }'), ['no rules parsed: check braces and selectors']);
  assert.deepEqual(V.cssParseErrors(fakeWin, 'x { ok }'), []);
  assert.deepEqual(V.cssParseErrors(fakeWin, '   '), []);
  assert.equal(V.cssParseErrors(win, 'a{}'), null);
  assert.equal(V.cssParseErrors({}, 'a{}'), null);
  const noOverflow = V.verify({ doc, win, baseline: { ...baseline, scrollWidth: 1200 }, patch: { rules: [] }, measure });
  assert.equal(check(noOverflow, 'layout').ok, true);
});

test('styleOnlyMeasure handles detached and transparent elements', () => {
  const { doc, win } = dom('<a id="o" href="/" style="opacity:0">x</a>');
  const m = V.styleOnlyMeasure(win);
  assert.equal(m.isVisible(doc.getElementById('o')), false);
  assert.equal(m.isVisible(doc.createElement('a')), false);
});

test('elements without text and patches without rules', () => {
  const { doc, win } = dom('<a id="e" href="/"></a>');
  const measure = V.styleOnlyMeasure(win);
  const baseline = V.captureBaseline(doc, measure);
  doc.getElementById('e').style.display = 'none';
  const report = V.verify({ doc, win, baseline, patch: {}, measure });
  assert.deepEqual(check(report, 'interactive').details, ['a (#e) is no longer visible or clickable']);
  assert.equal(check(report, 'selectors').ok, true);
  assert.equal(check(report, 'protected').ok, true);
  const fakeWin = { CSSStyleSheet: class { replaceSync() { this.cssRules = []; } } };
  assert.deepEqual(V.cssParseErrors(fakeWin, 'nobraces'), []);
});

test('collectFormPayloads tolerates unserialisable forms and files', () => {
  const { doc, win } = dom('<form id="f"><input name="a" value="1"><input type="file" name="up"></form>');
  const forms = V.collectFormPayloads(doc);
  assert.deepEqual(forms[0].entries, [['a', '1'], ['up', '[file ]']]);
  const orig = win.FormData;
  win.FormData = class {
    constructor() {
      throw new Error('nope');
    }
  };
  assert.deepEqual(V.collectFormPayloads(doc)[0].entries, []);
  win.FormData = orig;
  const noWin = { querySelectorAll: () => [], defaultView: null };
  assert.deepEqual(V.collectFormPayloads(noWin), []);
});

test('browserMeasure uses layout information', () => {
  const { doc, win } = dom('<a id="a" href="/">x</a><button id="b">y</button><div id="c" style="opacity:0">z</div><div id="d" style="pointer-events:none">w</div><div id="e" style="visibility:hidden"></div>');
  const m = V.browserMeasure(win);
  const rect = (w, h, left = 10, top = 10) => () => ({ width: w, height: h, left, top });
  const a = doc.getElementById('a');
  a.getBoundingClientRect = rect(0, 0);
  assert.equal(m.isVisible(a), false);
  a.getBoundingClientRect = rect(10, 10);
  assert.equal(m.isVisible(a), true);
  assert.equal(m.isVisible(doc.getElementById('c')), false);
  assert.equal(m.isVisible(doc.getElementById('d')), false);
  assert.equal(m.isVisible(doc.getElementById('e')), false);
  const detached = doc.createElement('a');
  assert.equal(m.isVisible(detached), false);

  const b = doc.getElementById('b');
  b.getBoundingClientRect = rect(10, 10, 10, 10);
  win.innerWidth = 500;
  win.innerHeight = 500;
  doc.elementFromPoint = () => b;
  assert.equal(m.isCovered(b), false);
  doc.elementFromPoint = () => a;
  assert.equal(m.isCovered(b), true);
  doc.elementFromPoint = () => null;
  assert.equal(m.isCovered(b), false);
  doc.elementFromPoint = () => doc.body;
  assert.equal(m.isCovered(b), false);
  b.getBoundingClientRect = rect(10, 10, 5000, 10);
  doc.elementFromPoint = () => a;
  assert.equal(m.isCovered(b), false);
  assert.equal(typeof m.scrollWidth(), 'number');
  assert.equal(m.viewportWidth(), 500);
});

test('collectInteractive caps and labels', () => {
  const html = Array.from({ length: 405 }, (_, i) => `<button>b${i}</button>`).join('') + '<input name="nm"><input placeholder="ph"><a href="/" aria-label="al"></a>';
  const { doc, win } = dom(html);
  const items = V.collectInteractive(doc, V.styleOnlyMeasure(win));
  assert.equal(items.length, 400);
  const { doc: d2, win: w2 } = dom('<input name="nm"><input placeholder="ph"><a href="/" aria-label="al"></a><a href="/"></a>');
  const labels = V.collectInteractive(d2, V.styleOnlyMeasure(w2)).map((i) => i.text);
  assert.deepEqual(labels, ['nm', 'ph', 'al', '']);
});
