import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSpawn, scripted } from '../helpers/fakeSpawn.js';
import { runProcess, parseJsonLine } from '../../bridge/src/harness/process.js';
import { createClaudeHarness } from '../../bridge/src/harness/claude.js';
import { createCodexHarness } from '../../bridge/src/harness/codex.js';
import { createFakeHarness } from '../../bridge/src/harness/fake.js';
import { createHarnesses, commandExists, splitArgs } from '../../bridge/src/harness/index.js';

const mcp = { command: 'node', args: ['mcp.js'], env: { PERUSER_BRIDGE_URL: 'ws://127.0.0.1:1', PERUSER_RUN_ID: 'r', PERUSER_RUN_TOKEN: 't' } };

test('runProcess streams lines, collects stderr, handles partial last line', async () => {
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.stdout.write('one\ntw');
    child.stdout.write('o\n\n  \nlast');
    child.stderr.write('x'.repeat(25_000));
    child.stdout.end();
    child.emit('close', 3);
  });
  const lines = [];
  const errs = [];
  const r = await runProcess({ spawn, command: 'c', args: ['a'], env: { A: '1' }, onLine: (l) => lines.push(l), onStderr: (s) => errs.push(s.length), stdinText: 'hello' });
  assert.deepEqual(lines, ['one', 'two', 'last']);
  assert.equal(r.code, 3);
  assert.equal(r.stderr.length, 20_000);
  assert.equal(calls[0].opts.env.A, '1');
  assert.equal(calls[0].child.stdinData, 'hello');
  assert.equal(parseJsonLine('{"a":1}').a, 1);
  assert.equal(parseJsonLine('nope'), null);
});

test('runProcess: spawn errors, ENOENT, abort before and during', async () => {
  await assert.rejects(
    runProcess({
      spawn: () => {
        throw new Error('spawn boom');
      },
      command: 'c',
      args: [],
      onLine() {},
    }),
    /spawn boom/,
  );
  const enoent = fakeSpawn(({ child }) => child.emit('error', Object.assign(new Error('nf'), { code: 'ENOENT' })));
  await assert.rejects(runProcess({ spawn: enoent.spawn, command: 'claude', args: [], onLine() {} }), /claude is not installed/);
  const other = fakeSpawn(({ child }) => child.emit('error', new Error('EACCES')));
  await assert.rejects(runProcess({ spawn: other.spawn, command: 'c', args: [], onLine() {} }), /EACCES/);

  const pre = new AbortController();
  pre.abort(new Error('early'));
  const never = fakeSpawn(() => {});
  await assert.rejects(runProcess({ spawn: never.spawn, command: 'c', args: [], signal: pre.signal, onLine() {} }), /early/);
  assert.deepEqual(never.calls[0].child.killed, ['SIGTERM']);

  const mid = new AbortController();
  const hang = fakeSpawn(({ child }) => {
    child.kill = () => {
      throw new Error('gone');
    };
    setTimeout(() => mid.abort('plain string reason'), 10);
  });
  await assert.rejects(runProcess({ spawn: hang.spawn, command: 'c', args: [], signal: mid.signal, onLine() {} }), /aborted/);
  // close after abort is ignored
  hang.calls[0].child.emit('close', 0);
});

test('claude harness builds the right argv and parses stream-json', async () => {
  const events = [];
  const { spawn, calls } = fakeSpawn(
    scripted({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'opus' },
        { type: 'assistant', message: { content: [{ type: 'text', text: ' Looking. ' }, { type: 'tool_use', name: 'mcp__peruser__page_outline', input: {} }, { type: 'text', text: '  ' }, { type: 'tool_use' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result' }] } },
        { type: 'assistant', message: {} },
        'not json',
        { type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 3 },
      ],
    }),
  );
  const h = createClaudeHarness({ spawn, extraArgs: ['--extra'] });
  assert.equal(h.label, 'Claude Code');
  const r = await h.run({ prompt: 'P', system: 'S', mcp, model: 'opus', signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  assert.deepEqual(r, { lastText: 'Looking.', cost: 0.5, turns: 3 });
  const args = calls[0].args;
  assert.equal(args[0], '-p');
  assert.equal(args[1], 'P');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.peruser.command, 'node');
  assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__peruser__finish/);
  assert.match(args[args.indexOf('--disallowedTools') + 1], /Bash/);
  assert.deepEqual(args.slice(-3), ['--model', 'opus', '--extra']);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'assistant', 'thinking_tool', 'thinking_tool', 'log'],
  );
  assert.equal(events[2].tool, 'page_outline');
  assert.equal(events[3].tool, '');
  assert.match(events[0].text, /session s1 \(opus\)/);
  assert.ok(!h.buildArgs({ prompt: 'p', system: 's', mcp, model: '' }).includes('--model'));
  await assert.rejects(h.run({ prompt: 'p', system: 's', mcp: null, onEvent() {} }), /needs the MCP/);
});

test('claude harness reports errors and exit codes', async () => {
  const err = fakeSpawn(scripted({ lines: [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'error_max_turns', is_error: true }] }));
  const r1 = await createClaudeHarness({ spawn: err.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} });
  assert.equal(r1.error, 'error_max_turns');
  const err2 = fakeSpawn(scripted({ lines: [{ type: 'result', subtype: 'error', result: 'bad things' }] }));
  const r2 = await createClaudeHarness({ spawn: err2.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} });
  assert.equal(r2.error, 'bad things');
  const err3 = fakeSpawn(scripted({ lines: [{ type: 'result', is_error: true }] }));
  assert.equal((await createClaudeHarness({ spawn: err3.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} })).error, 'Claude Code reported an error');
  const exit = fakeSpawn(scripted({ code: 1, stderr: 'line1\nNot logged in\n' }));
  const r3 = await createClaudeHarness({ spawn: exit.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} });
  assert.equal(r3.error, 'claude exited with code 1: Not logged in');
  const exitQuiet = fakeSpawn(scripted({ code: 2 }));
  const r4 = await createClaudeHarness({ spawn: exitQuiet.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} });
  assert.equal(r4.error, 'claude exited with code 2');
});

test('codex harness builds argv with TOML overrides and parses JSONL', async () => {
  const events = [];
  const { spawn, calls } = fakeSpawn(
    scripted({
      lines: [
        { type: 'thread.started', thread_id: 'th' },
        { type: 'thread.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: ' hi ' } },
        { type: 'item.completed', item: { type: 'agent_message', text: '  ' } },
        { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'verify', arguments: {} } },
        { type: 'item.started', item: { type: 'command_execution' } },
        { type: 'turn.completed' },
        'garbage',
      ],
    }),
  );
  const h = createCodexHarness({ spawn, extraArgs: ['-a', 'never'] });
  assert.equal(h.label, 'Codex');
  const r = await h.run({ prompt: 'P', system: 'S', mcp, model: 'gpt-5', onEvent: (e) => events.push(e) });
  assert.deepEqual(r, { lastText: 'hi' });
  const args = calls[0].args;
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('mcp_servers.peruser.command="node"'));
  assert.ok(args.includes('mcp_servers.peruser.args=["mcp.js"]'));
  assert.ok(args.find((a) => a.startsWith('mcp_servers.peruser.env={ PERUSER_BRIDGE_URL = "ws://127.0.0.1:1"')));
  assert.deepEqual(args.slice(-4, -1), ['gpt-5', '-a', 'never']);
  assert.equal(args.at(-1), 'S\n\nP');
  assert.deepEqual(events.map((e) => e.kind), ['status', 'status', 'assistant', 'thinking_tool', 'log']);
  assert.equal(events[1].text, 'Codex thread');
  assert.ok(!h.buildArgs({ prompt: 'p', system: 's', mcp, model: '', cwd: '/tmp' }).includes('-m'));
  await assert.rejects(h.run({ prompt: 'p', system: 's', mcp: null, onEvent() {} }), /needs the MCP/);

  const err = fakeSpawn(scripted({ lines: [{ type: 'error', message: 'quota' }] }));
  assert.equal((await createCodexHarness({ spawn: err.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} })).error, 'quota');
  const err2 = fakeSpawn(scripted({ lines: [{ type: 'error' }] }));
  assert.equal((await createCodexHarness({ spawn: err2.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} })).error, 'Codex reported an error');
  const exit = fakeSpawn(scripted({ code: 1, stderr: 'boom' }));
  assert.equal((await createCodexHarness({ spawn: exit.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} })).error, 'codex exited with code 1: boom');
  const exit2 = fakeSpawn(scripted({ code: 1 }));
  assert.equal((await createCodexHarness({ spawn: exit2.spawn }).run({ prompt: 'p', system: 's', mcp, onEvent() {} })).error, 'codex exited with code 1');
});

test('fake harness command language', async () => {
  const h = createFakeHarness();
  const calls = [];
  const outline = { volatility: { volatile: true } };
  const callTool = async (name, input) => {
    calls.push([name, input]);
    if (name === 'page_outline') return outline;
    if (name === 'preview_patch') return { ok: true };
    if (name === 'verify') return { ok: true };
    return {};
  };
  const r = await h.run({ prompt: 'Request: text h1 => Hello\nvalue #q => x\nstyle p => color:red\nattr a title=T\nrisky\nunknown cmd', callTool, onEvent() {} });
  assert.equal(r.lastText, 'finished');
  const finish = calls.find((c) => c[0] === 'finish')[1];
  assert.equal(finish.risk, 'high');
  assert.equal(finish.warnings.length, 2);
  assert.deepEqual(finish.patch.rules.map((x) => x.action), ['setText', 'setValue', 'style', 'setAttribute']);
  assert.deepEqual(finish.patch.rules[3], { action: 'setAttribute', selector: 'a', name: 'title', value: 'T' });
  // no "Request:" marker, volatile page bumps risk to medium, text without value
  const r2 = await h.run({ prompt: 'text h1\nattr a title\nvalue #q\nstyle p', callTool, onEvent() {} });
  assert.equal(r2.lastText, 'finished');
  const f2 = calls.filter((c) => c[0] === 'finish').at(-1)[1];
  assert.equal(f2.risk, 'medium');
  assert.equal(f2.patch.rules[0].text, '');
  assert.equal(f2.patch.rules[1].value, '');
  assert.equal(f2.patch.rules[2].value, '');
  assert.equal(f2.patch.rules[3].value, '');
  await assert.rejects(h.run({ prompt: 'fail', callTool, onEvent() {} }), /fake harness failure/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(h.run({ prompt: 'hide a', callTool, onEvent() {}, signal: aborted.signal }), /aborted/);
  outline.volatility = null;
  const r3 = await h.run({ prompt: 'Request: nothing here', callTool, onEvent() {} });
  assert.equal(r3.lastText, 'finished without a patch');
  assert.equal(calls.at(-1)[1].message, 'Nothing to change.');
});

test('harness registry', () => {
  const found = createHarnesses({ spawnSync: () => ({ status: 0 }), env: { PERUSER_CLAUDE_COMMAND: '/x/claude', PERUSER_CODEX_ARGS: '-a never "quoted arg"' } });
  assert.deepEqual(found.names(), ['claude', 'codex']);
  assert.equal(found.get('claude').command, '/x/claude');
  assert.equal(found.get('nope'), null);
  const avail = found.available();
  assert.deepEqual(avail.map((h) => h.available), [true, true]);
  assert.deepEqual(found.available(), avail); // cached
  const withFake = createHarnesses({ spawnSync: () => ({ error: new Error('x') }), env: { PERUSER_FAKE_HARNESS: '1' } });
  assert.deepEqual(withFake.available().map((h) => [h.name, h.available, h.command]), [['claude', false, 'claude'], ['codex', false, 'codex'], ['fake', true, null]]);
  assert.equal(commandExists('definitely-not-a-real-command-xyz'), false);
  assert.equal(
    commandExists('x', {
      spawnSync: () => {
        throw new Error('nope');
      },
    }),
    false,
  );
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('a "b c" d'), ['a', 'b c', 'd']);
});
