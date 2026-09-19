import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, HELP, startBridge, main } from '../../bridge/src/cli.js';
import { DEFAULT_ROOT } from '../../bridge/src/store.js';
import { tmpDir, rm, until } from '../helpers/tmp.js';
import { connectFakeExtension } from '../helpers/fakeExtension.js';
import { MSG } from '../../src/lib/protocol.js';

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { port: 48923, root: DEFAULT_ROOT, fake: false, help: false });
  assert.equal(parseArgs(['-p', '1234']).port, 1234);
  assert.match(parseArgs(['--root', 'rel/dir']).root, /\/rel\/dir$/);
  assert.equal(parseArgs(['-r', '/abs', '--fake', '-h']).fake, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--port', 'x']), /--port must be/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port must be/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument --wat/);
  assert.match(HELP, /peruser-bridge/);
});

test('startBridge wires store, watcher and harnesses', async () => {
  const root = await tmpDir();
  try {
    const logs = [];
    const running = await startBridge({ port: 0, root, fake: true, log: (m) => logs.push(m), env: { PERUSER_CLAUDE_COMMAND: 'no-such-claude-cmd', PERUSER_CODEX_COMMAND: 'no-such-codex-cmd' } });
    assert.ok(running.bridge.port > 0);
    assert.match(logs.join('\n'), /patches live in/);
    assert.match(logs.join('\n'), /Claude Code: not found/);
    assert.match(logs.join('\n'), /Fake \(tests\): available/);
    assert.equal(running.bridge.mcpCommand.command, process.execPath);
    const ext = await connectFakeExtension(running.bridge.url);
    const { runId } = await ext.request({ type: MSG.AGENT_START, harness: 'fake', tabId: 1, url: 'https://example.test/', prompt: 'hide .promo' });
    const done = await ext.waitFor((e) => e.runId === runId && e.event.kind === 'done');
    assert.equal(done.event.ok, true);
    running.store.emit('error', new Error('disk'));
    assert.match(logs.join('\n'), /store error: disk/);
    ext.close();
    await running.close();
    // problems from hand-edited files are logged
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.join(root, 'sites', 'x'), { recursive: true });
    const logs2 = [];
    const again = await startBridge({ port: 0, root, log: (m) => logs2.push(m), env: {} });
    assert.match(logs2.join('\n'), /warning: x\/views.json/);
    await again.close();
  } finally {
    await rm(root);
  }
});

test('main handles help, bad args and shutdown signals', async () => {
  const root = await tmpDir();
  try {
    const logs = [];
    const exits = [];
    const exit = (c) => exits.push(c);
    await main(['--help'], { log: (m) => logs.push(m), exit });
    assert.deepEqual(exits, [0]);
    await main(['--nope'], { log: (m) => logs.push(m), exit });
    assert.deepEqual(exits, [0, 2]);
    assert.match(logs.at(-1), /error: unknown argument --nope/);
    const running = await main(['--port', '0', '--root', root], { log: (m) => logs.push(m), exit, env: {} });
    assert.ok(running.bridge.port > 0);
    process.emit('SIGINT');
    await until(() => exits.length === 3);
    assert.equal(exits[2], 0);
    assert.match(logs.join('\n'), /shutting down/);
    const running2 = await main(['--port', '0', '--root', root], { log: (m) => logs.push(m), exit, env: {} });
    process.emit('SIGTERM');
    await until(() => exits.length === 4);
    assert.equal(process.listenerCount('SIGTERM'), 0);
    assert.ok(running2);
  } finally {
    await rm(root);
  }
});
