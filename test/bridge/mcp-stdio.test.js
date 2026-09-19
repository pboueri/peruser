import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../../bridge/src/store.js';
import { Bridge } from '../../bridge/src/server.js';
import { MSG } from '../../src/lib/protocol.js';
import { connectToBridge, buildServer, main } from '../../bridge/src/mcp-stdio.js';
import { connectFakeExtension } from '../helpers/fakeExtension.js';
import { tmpDir, rm, until } from '../helpers/tmp.js';

const MCP_PATH = fileURLToPath(new URL('../../bridge/src/mcp-stdio.js', import.meta.url));

async function setup() {
  const root = await tmpDir();
  const store = await new Store({ root }).init();
  let finishRun;
  const harnesses = {
    get: () => ({ name: 'wait', run: () => new Promise((r) => (finishRun = r)) }),
    available: () => [],
  };
  const bridge = new Bridge({ store, harnesses });
  await bridge.start();
  const ext = await connectFakeExtension(bridge.url);
  const { runId } = await ext.request({ type: MSG.AGENT_START, harness: 'wait', tabId: 1, url: 'https://example.test/', prompt: 'x' });
  const run = bridge.runs.get(runId);
  return {
    bridge,
    ext,
    run,
    async close() {
      finishRun({});
      ext.close();
      await bridge.stop();
      store.close();
      await rm(root);
    },
  };
}

test('connectToBridge: hello, calls, errors, unreachable', async () => {
  const env = await setup();
  try {
    await assert.rejects(connectToBridge({ url: env.bridge.url, runId: env.run.id, token: 'bad' }), /bad token/);
    const link = await connectToBridge({ url: env.bridge.url, runId: env.run.id, token: env.run.token });
    const outline = await link.call('page_outline', {});
    assert.equal(outline.title, 'T');
    await assert.rejects(link.call('inspect', {}), /invalid input/);
    link.ws.dispatchEvent(new MessageEvent('message', { data: 'not json' }));
    link.close();
    await assert.rejects(link.call('page_outline', {}), /closed|not open|CLOSING|CLOSED/i);
    await assert.rejects(connectToBridge({ url: 'ws://127.0.0.1:1', runId: 'r', token: 't' }), /cannot reach the bridge/);
  } finally {
    await env.close();
  }
});

test('buildServer exposes the tools over MCP', async () => {
  const env = await setup();
  try {
    const link = await connectToBridge({ url: env.bridge.url, runId: env.run.id, token: env.run.token });
    const server = buildServer(link);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientT);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['clear_preview', 'finish', 'inspect', 'page_outline', 'preview_patch', 'verify']);
    assert.equal(tools.tools.find((t) => t.name === 'inspect').annotations.readOnlyHint, true);
    const r = await client.callTool({ name: 'inspect', arguments: { selector: '#go' } });
    assert.equal(JSON.parse(r.content[0].text).count, 1);
    const bad = await client.callTool({ name: 'inspect', arguments: { selector: '<<' } });
    assert.match(JSON.parse(bad.content[0].text).error, /invalid selector/);
    env.ext.close();
    await until(() => env.bridge.extension === null);
    const gone = await client.callTool({ name: 'page_outline', arguments: {} });
    assert.equal(gone.isError, true);
    assert.match(gone.content[0].text, /extension is not connected/);
    await client.close();
    link.close();
  } finally {
    await env.close();
  }
});

test('main() serves MCP over the given streams', async () => {
  const env = await setup();
  try {
    await assert.rejects(main({}), /required/);
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on('data', (d) => out.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    const served = await main({ PERUSER_BRIDGE_URL: env.bridge.url, PERUSER_RUN_ID: env.run.id, PERUSER_RUN_TOKEN: env.run.token }, { stdin, stdout });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    await until(() => out.length === 1);
    assert.equal(out[0].result.serverInfo.name, 'peruser');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await until(() => out.length === 2);
    assert.equal(out[1].result.tools.length, 6);
    await served.server.close();
    served.link.close();
  } finally {
    await env.close();
  }
});

test('main() runs as a stdio MCP server process', async () => {
  const env = await setup();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_PATH],
      env: { ...process.env, PERUSER_BRIDGE_URL: env.bridge.url, PERUSER_RUN_ID: env.run.id, PERUSER_RUN_TOKEN: env.run.token },
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    const r = await client.callTool({ name: 'page_outline', arguments: {} });
    assert.equal(JSON.parse(r.content[0].text).title, 'T');
    await client.close();
    // a process with a bad token exits with an error
    const bad = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_PATH],
      env: { ...process.env, PERUSER_BRIDGE_URL: env.bridge.url, PERUSER_RUN_ID: env.run.id, PERUSER_RUN_TOKEN: 'nope' },
      stderr: 'pipe',
    });
    let stderr = '';
    const badClient = new Client({ name: 'test', version: '0' });
    const errP = badClient.connect(bad).catch((e) => e);
    bad.stderr?.on('data', (d) => (stderr += d));
    const e = await errP;
    assert.ok(e instanceof Error);
    await until(() => /bad token/.test(stderr), { timeoutMs: 5000 });
    await bad.close();
  } finally {
    await env.close();
  }
});
