import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './helpers/dom.js';
import { applyPatch, countMatches, ATTRS } from '../src/lib/patcher.js';

const PAGE = `
<form id="f"><input id="q" name="q" value="old" style="color: blue !important;"><button id="s">Go</button></form>
<div id="a" class="one">A</div><div id="b" class="two">B</div>
<p class="promo">buy</p><p class="promo">now</p>
<span id="t" title="tt">text</span>`;

test('applyPatch applies every action and undo restores the page', () => {
  const { doc } = dom(PAGE);
  const before = doc.body.innerHTML;
  const events = [];
  doc.getElementById('q').addEventListener('input', () => events.push('input'));
  doc.getElementById('q').addEventListener('change', () => events.push('change'));
  const patch = {
    id: 'p1',
    css: '.promo{color:red}',
    rules: [
      { action: 'hide', selector: '.promo' },
      { action: 'setAttribute', selector: '#t', name: 'title', value: 'new' },
      { action: 'removeAttribute', selector: '#t', name: 'title' },
      { action: 'setAttribute', selector: '#t', name: 'aria-label', value: 'x' },
      { action: 'removeAttribute', selector: '#t', name: 'missing' },
      { action: 'setText', selector: '#t', text: 'changed' },
      { action: 'setValue', selector: '#q', value: 'new' },
      { action: 'addClass', selector: '#a', className: 'one' },
      { action: 'addClass', selector: '#a', className: 'added' },
      { action: 'removeClass', selector: '#b', className: 'two' },
      { action: 'removeClass', selector: '#b', className: 'nothere' },
      { action: 'style', selector: '#q', value: 'color: red; font-size: 20px !important; junk; :novalue' },
      { action: 'autofocus', selector: '#q' },
      { action: 'move', selector: '#b', target: '#a', position: 'before' },
    ],
  };
  const h = applyPatch(doc, patch);
  assert.deepEqual(h.problems, []);
  assert.equal(doc.querySelector(`style[${ATTRS.STYLE_ATTR}="p1"]`).textContent, '.promo{color:red}');
  assert.equal(h.styleElement.textContent, '.promo{color:red}');
  assert.equal(doc.querySelector('.promo').style.getPropertyPriority('display'), 'important');
  assert.equal(doc.getElementById('t').getAttribute('title'), null);
  assert.equal(doc.getElementById('t').textContent, 'changed');
  assert.equal(doc.getElementById('q').value, 'new');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(doc.getElementById('a').className, 'one added');
  assert.equal(doc.getElementById('b').className, '');
  assert.equal(doc.getElementById('q').style.getPropertyValue('font-size'), '20px');
  assert.equal(doc.getElementById('q').style.getPropertyPriority('font-size'), 'important');
  assert.equal(doc.activeElement, doc.getElementById('q'));
  assert.equal(doc.getElementById('b').nextElementSibling.id, 'a');
  assert.equal(h.matchCounts[0].matched, 2);
  assert.equal(h.matchCounts[0].applied, 2);

  // idempotent reapply
  h.reapply();
  assert.equal(h.matchCounts[0].applied, 2);
  assert.equal(doc.querySelectorAll(`style[${ATTRS.STYLE_ATTR}="p1"]`).length, 1);
  // a new element matching a rule gets patched on reapply
  const p = doc.createElement('p');
  p.className = 'promo';
  doc.body.append(p);
  h.reapply();
  assert.equal(p.style.display, 'none');
  assert.equal(h.matchCounts[0].applied, 3);
  // style element restored if the page removed it, and content refreshed
  h.styleElement.remove();
  h.reapply();
  assert.ok(doc.querySelector(`style[${ATTRS.STYLE_ATTR}="p1"]`));
  patch.css = '.promo{color:green}';
  h.reapply();
  assert.equal(h.styleElement.textContent, '.promo{color:green}');

  p.remove();
  h.undo();
  assert.equal(doc.body.innerHTML, before);
  assert.equal(h.styleElement, null);
  assert.equal(doc.getElementById('q').value, 'old');
  assert.deepEqual(events, ['input', 'change', 'input', 'change']);
});

test('undo survives elements that vanished', () => {
  const { doc } = dom(PAGE);
  const h = applyPatch(doc, { id: 'x', css: '', rules: [{ action: 'setText', selector: '#t', text: 'z' }] });
  const t = doc.getElementById('t');
  Object.defineProperty(t, 'textContent', {
    set() {
      throw new Error('gone');
    },
  });
  h.undo();
  assert.equal(doc.querySelector(`style[${ATTRS.STYLE_ATTR}="x"]`), null);
});

test('problems are reported, not thrown', () => {
  const { doc } = dom(PAGE);
  const h = applyPatch(doc, {
    id: 'p2',
    css: '   ',
    rules: [
      { action: 'hide', selector: '<<bad' },
      { action: 'setValue', selector: '#a', value: 'x' },
      { action: 'move', selector: '#a', target: '<<', position: 'after' },
      { action: 'move', selector: '#a', target: '#missing', position: 'after' },
      { action: 'move', selector: '#a', target: '#a', position: 'append' },
      { action: 'move', selector: 'body', target: '#a', position: 'append' },
      { action: 'move', selector: '#a', target: '#f', position: 'append' },
      { action: 'move', selector: '#q', target: '#a', position: 'before' },
      { action: 'move', selector: '#a', target: 'html', position: 'after' },
      { action: 'bogus', selector: '#a' },
    ],
  });
  assert.equal(h.styleElement, null);
  assert.equal(h.problems.length, 10);
  assert.match(h.problems[0], /invalid selector/);
  assert.match(h.problems[1], /not a form control/);
  assert.match(h.problems[2], /invalid target/);
  assert.match(h.problems[3], /not found/);
  assert.match(h.problems[4], /cannot move/);
  assert.match(h.problems[5], /cannot move/);
  assert.match(h.problems[6], /change which form/);
  assert.match(h.problems[7], /change which form/);
  assert.match(h.problems[8], /cannot move/);
  assert.match(h.problems[9], /unknown action/);
  assert.equal(doc.getElementById('a').parentElement.tagName, 'BODY');
  h.undo();
});

test('move positions and undo when siblings moved', () => {
  const { doc } = dom('<div id="r"><i id="x"></i><i id="y"></i><b id="z"></b></div>');
  const h = applyPatch(doc, {
    id: 'm',
    rules: [
      { action: 'move', selector: '#z', target: '#x', position: 'after' },
      { action: 'move', selector: '#y', target: '#r', position: 'prepend' },
      { action: 'move', selector: '#x', target: '#r', position: 'append' },
    ],
  });
  assert.deepEqual(Array.from(doc.getElementById('r').children).map((e) => e.id), ['y', 'z', 'x']);
  doc.getElementById('z').remove();
  h.undo();
  assert.deepEqual(Array.from(doc.getElementById('r').children).map((e) => e.id), ['x', 'y']);
});

test('setValue falls back when no native setter exists, hide restores inline display', () => {
  const { doc } = dom('<div id="d" style="display:flex">x</div>');
  const fake = { value: 'a', getAttribute: () => null, setAttribute() {}, dispatchEvent() {}, matches: () => true };
  const proto = Object.getPrototypeOf(fake);
  const origQSA = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (s) => (s === 'fake' ? [fake] : origQSA(s));
  const h = applyPatch(doc, { id: 'v', rules: [{ action: 'setValue', selector: 'fake', value: 'b' }, { action: 'hide', selector: '#d' }] });
  assert.equal(fake.value, 'b');
  assert.equal(doc.getElementById('d').style.display, 'none');
  h.undo();
  assert.equal(fake.value, 'a');
  assert.equal(doc.getElementById('d').style.display, 'flex');
  assert.equal(Object.getPrototypeOf(fake), proto);
});

test('countMatches', () => {
  const { doc } = dom(PAGE);
  const c = countMatches(doc, { rules: [{ action: 'hide', selector: '.promo' }, { action: 'hide', selector: '<<' }] });
  assert.equal(c[0].matched, 2);
  assert.equal(c[1].matched, 0);
  assert.ok(c[1].error);
  assert.deepEqual(countMatches(doc, {}), []);
});

test('default id is preview; css goes on documentElement when head is missing', () => {
  const { doc } = dom(PAGE);
  doc.head.remove();
  const h = applyPatch(doc, { css: 'a{}' });
  assert.equal(h.id, 'preview');
  assert.equal(h.styleElement.parentNode, doc.documentElement);
  h.undo();
});
