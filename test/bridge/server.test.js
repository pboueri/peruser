import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../bridge/src/store.js';
import { Bridge } from '../../bridge/src/server.js';
import { createHarnesses } from '../../bridge/src/harness/index.js';
import { MSG } from '../../src/lib/protocol.js';
import { connectFakeExtension } from '../helpers/fakeExtension.js';
import { tmpDir, rm, wait, until } from '../helpers/tmp.js';

const origin = 'https://example.test';

async function setup({ harnesses, runTimeoutMs } = {}) {
  const root = await tmpDir();
  const store = await new Store({ root }).init();
  const logs = [];
  const bridge = new Bridge({
    store,
    harnesses: harnesses || createHarnesses({ includeFake: true, spawnSync: () => ({ status: 1 }) }),
    log: (m) => logs.push(m),
    mcpCommand: { command: 'node', args: ['mcp.js'] },
    runTimeoutMs,
  });
  await bridge.start();
  return {
    bridge,
    store,
    logs,
    async close() {
      await bridge.stop();
      store.close();
      await rm(root);
    },
  };
}

function stubHarness(name, impl) {
  return { get: (n) => (n === name ? { name, label: name, command: null, run: impl } : null), available: () => [{ name, label: name, available: true }], names: () => [name] };
}

test('hello, catalog CRUD and pushes', async () => {
  const env = await setup();
  try {
    const ext = await connectFakeExtension(env.bridge.url);
    assert.equal(ext.hello.type, MSG.OK);
    assert.equal(ext.hello.version, '0.1.0');
    assert.ok(ext.hello.harnesses.find((h) => h.name === 'fake' && h.available));
    assert.equal(ext.hello.harnesses.find((h) => h.name === 'claude').available, false);
    assert.deepEqual(ext.hello.catalog.patches, {});
    assert.match(ext.hello.catalog.profile, /My preferences/);
    assert.match(env.logs.join('\n'), /extension connected/);

    const v = await ext.request({ type: MSG.SAVE_VIEW, view: { id: 'v1', origin, name: 'Focus' } });
    assert.equal(v.view.name, 'Focus');
    const p = await ext.request({ type: MSG.SAVE_PATCH, patch: { id: 'p1', viewId: 'v1', name: 'P', scope: { type: 'origin', origin }, css: 'a{}', rules: [] } });
    assert.equal(p.patch.id, 'p1');
    assert.ok(p.path.endsWith('/p'));
    const a = await ext.request({ type: MSG.SET_ACTIVE_VIEW, origin, viewId: 'v1' });
    assert.deepEqual(a.activeViews, { [origin]: 'v1' });
    assert.deepEqual((await ext.request({ type: MSG.SET_ACTIVE_VIEW, origin })).activeViews, {});
    await ext.request({ type: MSG.SET_ACTIVE_VIEW, origin, viewId: 'v1' });
    const cat = await ext.request({ type: MSG.CATALOG });
    assert.equal(Object.keys(cat.catalog.patches).length, 1);
    assert.equal((await ext.request({ type: MSG.DELETE_PATCH, patchId: 'p1' })).deleted, true);
    assert.equal((await ext.request({ type: MSG.DELETE_VIEW, viewId: 'v1' })).deleted, true);
    await until(() => ext.catalogs.length >= 5);
    assert.equal((await ext.request({ type: MSG.PING })).pong, true);
    assert.deepEqual((await ext.request({ type: MSG.SAVE_PROFILE, profile: { presets: ['focus'], notes: 'n' } })).profile, { presets: ['focus'], notes: 'n' });
    await assert.rejects(ext.request({ type: 'bogus' }), /unknown message type bogus/);
    await assert.rejects(ext.request({ type: MSG.SAVE_PATCH, patch: {} }), /needs id/);
    ext.raw('not json');
    const err = await ext.waitForFrame((f) => f.type === MSG.ERROR);
    assert.equal(err.error, 'invalid JSON');
    ext.close();
    await until(() => env.bridge.extension === null);
    assert.match(env.logs.join('\n'), /extension disconnected/);
  } finally {
    await env.close();
  }
});

test('a second extension connection replaces the first', async () => {
  const env = await setup();
  try {
    const first = await connectFakeExtension(env.bridge.url);
    const second = await connectFakeExtension(env.bridge.url);
    assert.equal(await first.closed, 4000);
    assert.ok(env.bridge.extension);
    assert.equal(env.bridge.extension.role, 'extension');
    second.close();
  } finally {
    await env.close();
  }
});

test('a fake-harness run drives the tools and finishes with a verified patch', async () => {
  const env = await setup();
  try {
    const ext = await connectFakeExtension(env.bridge.url);
    const { runId } = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'hide .promo\ncss p{color:red}' });
    assert.match(runId, /^run/);
    const done = await ext.waitFor((e) => e.runId === runId && e.event.kind === 'done');
    assert.equal(done.event.ok, true);
    const kinds = ext.events.filter((e) => e.runId === runId).map((e) => e.event.kind);
    assert.deepEqual(kinds, ['status', 'assistant', 'tool_call', 'tool_result', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'finish', 'tool_result', 'done']);
    const finish = ext.events.find((e) => e.event.kind === 'finish').event.result;
    assert.equal(finish.patch.rules[0].action, 'hide');
    assert.match(finish.message, /Verification passed/);
    // preview stays on the page until the panel saves or discards it
    assert.equal(ext.runtimes[1].status().preview, 'Fake patch');
    // a run on a tab the extension does not know fails cleanly
    const r2 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 9, url: 'https://example.test/', prompt: 'hide .promo' });
    const d2 = await ext.waitFor((e) => e.runId === r2.runId && e.event.kind === 'done');
    assert.equal(d2.event.ok, false);
    const errEv = ext.events.find((e) => e.runId === r2.runId && e.event.kind === 'tool_error');
    assert.match(errEv.event.error, /no tab 9/);
    assert.match(ext.events.find((e) => e.runId === r2.runId && e.event.kind === 'error').event.error, /no tab 9/);
    // verification failure path and no-patch path
    const r3 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'break' });
    const f3 = await ext.waitFor((e) => e.runId === r3.runId && e.event.kind === 'finish');
    assert.equal(f3.event.result.patch, null);
    assert.match(f3.event.result.message, /verification failed/);
    assert.equal(f3.event.result.risk, 'high');
    const r4 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'refuse change the field name\nnopatch' });
    const f4 = await ext.waitFor((e) => e.runId === r4.runId && e.event.kind === 'finish');
    assert.equal(f4.event.result.declined.length, 1);
    const r5 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'attr input name=zzz' });
    const f5 = await ext.waitFor((e) => e.runId === r5.runId && e.event.kind === 'finish');
    assert.match(f5.event.result.message, /rejected/);
    // JavaScript is refused unless the run allows it; allowed runs bump risk to medium
    const r7 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'js document.title="j"' });
    const f7 = await ext.waitFor((e) => e.runId === r7.runId && e.event.kind === 'finish');
    assert.match(f7.event.result.message, /not allowed/);
    const r8 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'js document.title="j"', allowJs: true });
    const f8 = await ext.waitFor((e) => e.runId === r8.runId && e.event.kind === 'finish');
    assert.equal(f8.event.result.patch.js.trim(), 'document.title="j"');
    assert.equal(f8.event.result.risk, 'medium');
    // the profile reaches the harness through the prompt
    await ext.request({ type: MSG.SAVE_PROFILE, profile: { presets: ['larger-text', 'hide-promos'], notes: 'gentle' } });
    const r9 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'tailor' });
    const f9 = await ext.waitFor((e) => e.runId === r9.runId && e.event.kind === 'finish');
    assert.match(f9.event.result.patch.css, /font-size:20px/);
    assert.deepEqual(f9.event.result.patch.intentionallyHidden, ['.promo']);
    assert.match(f9.event.result.patch.notes, /gentle/);
    const r6 = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'fail' });
    const d6 = await ext.waitFor((e) => e.runId === r6.runId && e.event.kind === 'done');
    assert.equal(d6.event.ok, false);
    assert.match(ext.events.find((e) => e.runId === r6.runId && e.event.kind === 'error').event.error, /fake harness failure/);
    ext.close();
  } finally {
    await env.close();
  }
});

test('start validation, cancel, timeout and stopping without finish', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const harness = stubHarness('slow', async ({ signal, onEvent, callTool }) => {
    calls.push('started');
    onEvent({ kind: 'assistant', text: 'working' });
    await callTool('page_outline', {});
    await Promise.race([gate, new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))]);
    return { lastText: 'I gave up' };
  });
  const env = await setup({ harnesses: harness, runTimeoutMs: 300 });
  try {
    const ext = await connectFakeExtension(env.bridge.url);
    await assert.rejects(ext.request({ type: MSG.AGENT_START, harness: 'nope', tabId: 1, url: 'u', prompt: 'p' }), /unknown harness nope/);
    await assert.rejects(ext.request({ type: MSG.AGENT_START, harness: 'slow', tabId: 1, url: 'u' }), /needs prompt/);
    assert.equal((await ext.request({ type: MSG.AGENT_CANCEL, runId: 'nope' })).cancelled, false);

    const { runId } = await ext.request({ type: MSG.AGENT_START, harness: 'slow', tabId: 1, url: 'https://example.test/', prompt: 'x' });
    await ext.waitFor((e) => e.runId === runId && e.event.kind === 'tool_result');
    assert.equal((await ext.request({ type: MSG.AGENT_CANCEL, runId })).cancelled, true);
    const done = await ext.waitFor((e) => e.runId === runId && e.event.kind === 'done');
    assert.equal(done.event.ok, false);
    assert.match(ext.events.find((e) => e.runId === runId && e.event.kind === 'error').event.error, /cancelled by user/);
    assert.equal((await ext.request({ type: MSG.AGENT_CANCEL, runId })).cancelled, false);
    // tool calls after the run finished are refused
    const run = env.bridge.runs.get(runId);
    await assert.rejects(env.bridge.executeTool(run, 'page_outline', {}), /already finished/);

    const second = await ext.request({ type: MSG.AGENT_START, harness: 'slow', tabId: 1, url: 'https://example.test/', prompt: 'x' });
    const d2 = await ext.waitFor((e) => e.runId === second.runId && e.event.kind === 'done', 3000);
    assert.equal(d2.event.ok, false);
    assert.match(ext.events.find((e) => e.runId === second.runId && e.event.kind === 'error').event.error, /timed out/);

    // harness returns normally without calling finish
    const env2 = await setup({ harnesses: stubHarness('quiet', async () => ({ lastText: 'bye' })) });
    try {
      const ext2 = await connectFakeExtension(env2.bridge.url);
      const r = await ext2.request({ type: MSG.AGENT_START, harness: 'quiet', tabId: 1, url: 'https://example.test/', prompt: 'x' });
      await ext2.waitFor((e) => e.runId === r.runId && e.event.kind === 'done');
      assert.match(ext2.events.find((e) => e.runId === r.runId && e.event.kind === 'error').event.error, /without calling finish.*bye/);
      const r2 = await ext2.request({ type: MSG.AGENT_START, harness: 'quiet', tabId: 1, url: 'https://example.test/', prompt: 'x' });
      await ext2.waitFor((e) => e.runId === r2.runId && e.event.kind === 'done');
      ext2.close();
    } finally {
      await env2.close();
    }
    const env3 = await setup({ harnesses: stubHarness('undef', async () => undefined) });
    try {
      const ext3 = await connectFakeExtension(env3.bridge.url);
      const r = await ext3.request({ type: MSG.AGENT_START, harness: 'undef', tabId: 1, url: 'https://example.test/', prompt: 'x' });
      const d = await ext3.waitFor((e) => e.runId === r.runId && e.event.kind === 'done');
      assert.equal(d.event.cost, null);
      ext3.close();
    } finally {
      await env3.close();
    }
    release();
    ext.close();
  } finally {
    await env.close();
  }
});

test('tool connections: bad token, good token, tool calls, extension missing', async () => {
  let resolveRun;
  const harness = stubHarness('waiter', () => new Promise((r) => (resolveRun = r)));
  const env = await setup({ harnesses: harness });
  try {
    const ext = await connectFakeExtension(env.bridge.url);
    const { runId } = await ext.request({ type: MSG.AGENT_START, harness: 'waiter', tabId: 1, url: 'https://example.test/', prompt: 'x' });
    const run = env.bridge.runs.get(runId);

    const open = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(env.bridge.url);
        const replies = [];
        ws.addEventListener('message', (ev) => replies.push(JSON.parse(ev.data)));
        ws.addEventListener('open', () => resolve({ ws, replies, send: (f) => ws.send(JSON.stringify(f)) }));
      });
    const bad = await open();
    bad.send({ id: '1', type: MSG.HELLO, role: 'tool', runId, token: 'wrong' });
    await until(() => bad.replies.length === 1);
    assert.match(bad.replies[0].error, /bad token/);
    bad.send({ id: '2', type: MSG.HELLO, role: 'alien' });
    await until(() => bad.replies.length === 2);
    assert.match(bad.replies[1].error, /unknown role alien/);
    bad.send({ id: '3', type: MSG.TOOL_CALL, tool: 'page_outline', input: {} });
    await until(() => bad.replies.length === 3);
    assert.match(bad.replies[2].error, /not a tool connection/);
    bad.send({ id: '4', type: MSG.AGENT_START, harness: 'waiter', tabId: 1, url: 'u', prompt: 'p' });
    await until(() => bad.replies.length === 4);
    assert.match(bad.replies[3].error, /only the extension/);
    bad.ws.close();

    const good = await open();
    good.send({ id: '1', type: MSG.HELLO, role: 'tool', runId, token: run.token });
    await until(() => good.replies.length === 1);
    assert.deepEqual(good.replies[0].tools.length, 6);
    good.send({ id: '2', type: MSG.TOOL_CALL, tool: 'inspect', input: { selector: '#go' } });
    await until(() => good.replies.length === 2);
    assert.equal(good.replies[1].result.count, 1);
    good.send({ id: '3', type: MSG.TOOL_CALL, tool: 'inspect', input: {} });
    await until(() => good.replies.length === 3);
    assert.match(good.replies[2].error, /invalid input/);

    // extension gone: tool calls fail with a clear error
    ext.close();
    await until(() => env.bridge.extension === null);
    good.send({ id: '4', type: MSG.TOOL_CALL, tool: 'page_outline', input: {} });
    await until(() => good.replies.length === 4);
    assert.match(good.replies[3].error, /extension is not connected/);
    good.send({ id: '5', type: MSG.TOOL_CALL, tool: 'finish', input: { message: 'm', patch: null, risk: 'low', warnings: [], declined: [] } });
    await until(() => good.replies.length === 5);
    assert.deepEqual(good.replies[4].result, { ok: true });
    assert.equal(run.result.message, 'm');
    good.ws.close();
    resolveRun({});
    await until(() => run.finished);
  } finally {
    await env.close();
  }
});

test('stop aborts running agents and start rejects a busy port', async () => {
  const env = await setup({ harnesses: stubHarness('forever', ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))) });
  const ext = await connectFakeExtension(env.bridge.url);
  await ext.request({ type: MSG.AGENT_START, harness: 'forever', tabId: 1, url: 'https://example.test/', prompt: 'x' });
  const busy = new Bridge({ store: env.store, harnesses: stubHarness('x', () => {}), port: env.bridge.port });
  await assert.rejects(busy.start(), /EADDRINUSE/);
  await env.close();
  await wait(20);
  // second stop is harmless
  await env.bridge.stop();
});
