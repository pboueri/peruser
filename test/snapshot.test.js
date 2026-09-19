import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom } from './helpers/dom.js';
import * as Snap from '../src/lib/snapshot.js';

const PAGE = `
<header id="top"><nav><a href="/">Home</a><a href="/about">About</a><a href="/again">Home</a><button aria-label="AL"></button><button title="TT"></button><button class="peruser-x"></button></nav></header>
<main>
  <h1>Welcome</h1><h2 class="css-1abc23 sub">Sub</h2>
  <form id="login" method="post" action="/login" data-track="x">
    <label for="user">User name</label><input id="user" name="user" type="text" placeholder="you" required>
    <label>Password <input name="pw" type="password"></label>
    <input type="hidden" name="csrf" value="tok">
    <select name="role"><option>a</option><option>b</option></select>
    <input type="checkbox" name="remember" aria-label="Remember me">
    <span id="lbl">Labelled</span><input name="x" aria-labelledby="lbl missing">
    <button type="submit">Sign in</button>
    <button type="button" class="btn">Help</button>
  </form>
  <input name="loose" title="t">
  <div role="dialog" class="modal"><button class="btn btn">Close</button></div>
  <ul><li>one</li><li>two</li><li>three</li></ul>
  <div id="123456">numeric id</div>
  <div class="a.b">dotted</div>
  <div data-testid="hero" class="sc-abcd1234 hero">Hero</div>
  <p data-testid="dup">dup1</p><p data-testid="dup">dup2</p>
  <canvas></canvas>
  <script>var x=1</script><style>.x{}</style><svg><path d="M0"/></svg>
</main>
<footer>Foot</footer>`;

test('cssPath prefers ids, stable attributes and classes', () => {
  const { doc } = dom(PAGE);
  assert.equal(Snap.cssPath(doc.body), 'body');
  assert.equal(Snap.cssPath(doc.documentElement), 'html');
  assert.equal(Snap.cssPath(doc.querySelector('#user')), '#user');
  assert.equal(Snap.cssPath(doc.querySelector('[name=pw]')), 'input[name="pw"]');
  assert.equal(Snap.cssPath(doc.querySelector('[data-testid=hero]')), 'div[data-testid="hero"]');
  assert.equal(Snap.cssPath(doc.querySelector('.modal .btn')), 'div.modal > button.btn');
  assert.equal(Snap.cssPath(doc.querySelectorAll('li')[1]), 'ul > li:nth-of-type(2)');
  assert.match(Snap.cssPath(doc.getElementById('123456')), /^main > div:nth-of-type/);
  assert.match(Snap.cssPath(doc.querySelectorAll('[data-testid=dup]')[1]), /p:nth-of-type\(2\)/);
  assert.equal(Snap.cssPath(null), '');
  assert.equal(Snap.cssPath(doc.createTextNode('x')), '');
  const detached = doc.createElement('div');
  assert.equal(Snap.cssPath(detached, doc), 'div');
  const { doc: d2 } = dom('<div id="only">x</div><span id="1a">y</span>');
  assert.equal(Snap.cssPath(d2.querySelector('div')), '#only');
  assert.equal(Snap.cssPath(d2.querySelector('span')), 'span');
});

test('cssPath escapes identifiers with and without CSS.escape', () => {
  const { doc } = dom('<div id="a:b">x</div><p class="c.d">y</p>');
  assert.equal(Snap.cssPath(doc.querySelector('p')), 'p.c\\.d');
  globalThis.CSS = { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
  assert.equal(Snap.cssPath(doc.querySelector('p')), 'p.c\\.d');
  delete globalThis.CSS;
});

test('generated class detection and text', () => {
  assert.equal(Snap.isGeneratedClass('css-1abc23'), true);
  assert.equal(Snap.isGeneratedClass('sc-abcd1234'), true);
  assert.equal(Snap.isGeneratedClass('Button_root__3kd9s'), true);
  assert.equal(Snap.isGeneratedClass('btn'), false);
  assert.equal(Snap.isGeneratedClass('x'.repeat(41)), true);
  assert.equal(Snap.isGeneratedClass(''), true);
  const { doc } = dom('<p>  hello   world  this is a long sentence for truncation </p>');
  assert.equal(Snap.text(doc.querySelector('p'), 12), 'hello world…');
  assert.equal(Snap.text(null), '');
});

test('forms, clickables, headings, landmarks, tree', () => {
  const { doc } = dom(PAGE);
  const { forms, looseFields } = Snap.describeForms(doc);
  assert.equal(forms.length, 1);
  const f = forms[0];
  assert.equal(f.method, 'post');
  assert.equal(f.hasAction, true);
  const user = f.fields.find((x) => x.name === 'user');
  assert.equal(user.label, 'User name');
  assert.equal(user.required, true);
  assert.equal(user.submitted, true);
  assert.deepEqual(user.protectedAttributes, ['id', 'name', 'type']);
  assert.equal(f.fields.find((x) => x.name === 'pw').label, 'Password');
  assert.match(f.fields.find((x) => x.name === 'csrf').note, /hidden/);
  assert.equal(f.fields.find((x) => x.name === 'role').optionCount, 2);
  assert.equal(f.fields.find((x) => x.name === 'remember').label, 'Remember me');
  assert.equal(f.fields.find((x) => x.name === 'x').label, 'Labelled');
  const submit = f.fields.find((x) => x.type === 'submit');
  assert.equal(submit.text, 'Sign in');
  assert.equal(submit.submitted, false);
  assert.equal(looseFields.length, 5);
  assert.equal(looseFields.find((x) => x.name === 'loose').label, '');
  assert.equal(looseFields.at(-1).type, 'submit');

  const clicks = Snap.describeClickables(doc);
  assert.ok(clicks.find((c) => c.text === 'Home'));
  assert.equal(clicks.filter((c) => c.text === 'Close').length, 1);
  assert.equal(clicks.filter((c) => c.text === 'Home').length, 1);
  assert.ok(clicks.find((c) => c.text === 'AL'));
  assert.ok(clicks.find((c) => c.text === 'TT'));
  assert.ok(clicks.find((c) => c.text === '' && c.tag === 'button'));
  const bare = Snap.describeForms(dom('<form><input></form>').doc).forms[0];
  assert.deepEqual([bare.id, bare.name, bare.method, bare.hasAction], ['', '', 'get', false]);
  assert.equal(clicks.find((c) => c.text === 'Sign in').inForm, true);
  assert.equal(Snap.describeClickables(doc, 1).length, 1);

  const hs = Snap.describeHeadings(doc);
  assert.equal(hs[0].text, 'Welcome');
  const lm = Snap.describeLandmarks(doc);
  assert.ok(lm.find((l) => l.role === 'dialog'));

  const tree = Snap.describeTree(doc, { maxDepth: 2, maxNodes: 12 });
  assert.equal(tree.truncated, true);
  assert.equal(tree.nodeCount, 12);
  assert.ok(tree.lines.some((l) => /children/.test(l)));
  const full = Snap.describeTree(doc);
  assert.ok(full.lines.some((l) => /\+1 generated classes/.test(l)));
  assert.ok(full.lines.some((l) => /\[role=dialog\]/.test(l)));
  assert.ok(!full.lines.some((l) => /^ *script/.test(l)));
  const { doc: empty } = dom('');
  empty.body.remove();
  assert.deepEqual(Snap.describeTree(empty).lines, []);
});

test('labelledby with no resolvable ids falls back', () => {
  const { doc } = dom('<input aria-labelledby="nope" name="q">');
  assert.equal(Snap.describeForms(doc).looseFields[0].label, '');
});

test('framework detection, shadow roots, generated ratio, volatility', () => {
  const { doc } = dom('<div id="__next"><div data-reactroot></div></div><div ng-version="1"></div><div data-v-app></div><div class="svelte-x1"></div><div data-turbo="true"></div><div class="ember-view"></div><div wire:id="1"></div><span class="p" data-v-123></span>');
  assert.deepEqual(Snap.detectFrameworks(doc), ['next', 'react', 'angular', 'vue', 'svelte', 'hotwire', 'ember', 'livewire']);
  const { doc: d2 } = dom('<script src="/static/react-dom.production.min.js"></script><div class="a"></div>');
  assert.deepEqual(Snap.detectFrameworks(d2), ['react']);
  const { doc: d3 } = dom('<div class="css-a1b2c3 x"></div><div class="css-d4e5f6"></div><div class="btn"></div>');
  assert.equal(Snap.generatedClassRatio(d3), 0.5);
  assert.equal(Snap.generatedClassRatio(dom('').doc), 0);
  const { doc: d4 } = dom('<div id="host"></div>');
  d4.getElementById('host').attachShadow({ mode: 'open' });
  assert.equal(Snap.countShadowRoots(d4), 1);
  assert.equal(Snap.countShadowRoots(d4, 0), 0);
  assert.ok(Snap.describeTree(d4).lines.some((l) => l.includes('[shadow]')));

  const calm = Snap.volatilityScore({});
  assert.equal(calm.score, 0);
  assert.equal(calm.volatile, false);
  const wild = Snap.volatilityScore({ frameworks: ['react'], mutationsPerSecond: 25, shadowRoots: 2, generatedRatio: 0.7, canvasHeavy: true });
  assert.equal(wild.score, 1);
  assert.equal(wild.volatile, true);
  assert.equal(wild.reasons.length, 5);
  const mid = Snap.volatilityScore({ mutationsPerSecond: 5, generatedRatio: 0.3, shadowRoots: 1 });
  assert.equal(mid.score, 0.5);
  assert.match(mid.reasons.join(), /keeps changing/);
  assert.match(mid.reasons.join(), /30% of class names look generated(,|$)/);
  assert.match(mid.reasons.join(), /1 shadow DOM root:/);
});

test('theme, outline and inspect', () => {
  const { doc, win } = dom(PAGE + '<style>body{font-size:14px}</style>');
  const theme = Snap.describeTheme(doc, win);
  assert.equal(theme.body['font-size'], '14px');
  assert.ok(theme.link);
  assert.ok(theme.button);
  assert.deepEqual(Snap.describeTheme(doc, null), {});
  assert.deepEqual(Snap.describeTheme({ body: null }, win), {});

  const outline = Snap.buildOutline(doc, win, { url: 'https://x.test/p', mutationsPerSecond: 30, viewport: { w: 1, h: 2 }, appliedPatches: ['p1'] });
  assert.equal(outline.url, 'https://x.test/p');
  assert.equal(outline.title, 'T');
  assert.equal(outline.volatility.volatile, false);
  assert.equal(outline.forms.length, 1);
  assert.ok(outline.tree.includes('main'));
  assert.deepEqual(outline.appliedPatches, ['p1']);
  const o2 = Snap.buildOutline(doc, win);
  assert.equal(o2.url, 'https://example.test/page');
  assert.equal(o2.viewport, null);
  assert.deepEqual(o2.appliedPatches, []);
  const { doc: canvasDoc, win: cw } = dom('<canvas></canvas>');
  assert.match(Snap.buildOutline(canvasDoc, cw).volatility.reasons.join(), /canvas/);
  const { doc: noBody } = dom('');
  noBody.body.remove();
  assert.equal(Snap.buildOutline(noBody, null).tree, '');

  const ins = Snap.inspectSelector(doc, win, '#login');
  assert.equal(ins.count, 1);
  const m = ins.matches[0];
  assert.ok(!m.html.includes('tok'), 'hidden value stripped');
  assert.deepEqual(m.protectedAttributes, ['action', 'data-track', 'id', 'method']);
  assert.equal(m.computed.display, 'block');
  assert.equal(m.inForm, '#login');
  const ins2 = Snap.inspectSelector(doc, null, 'input[name="user"]');
  assert.equal(ins2.matches[0].computed, undefined);
  assert.ok(!ins2.matches[0].html.includes('value='));
  assert.match(Snap.inspectSelector(doc, win, '<<').error, /invalid selector/);
  assert.equal(Snap.inspectSelector(doc, win, 'li', { limit: 2 }).matches.length, 2);
  const big = doc.createElement('div');
  big.textContent = 'x'.repeat(2000);
  doc.body.append(big);
  assert.ok(Snap.inspectSelector(doc, win, 'div:last-child').matches[0].html.endsWith('…'));
  const { doc: d5 } = dom('<textarea name="n">secret</textarea>');
  assert.ok(!Snap.inspectSelector(d5, null, 'textarea').matches[0].html.includes('secret'));
});
