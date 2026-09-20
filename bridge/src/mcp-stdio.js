// Stdio MCP server that a coding harness spawns. Every tool call is
// forwarded over WebSocket to the bridge, which runs it in the tab.
//
// Env: PERUSER_BRIDGE_URL, PERUSER_RUN_ID, PERUSER_RUN_TOKEN

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MSG, createRequestChannel } from '../../src/lib/protocol.js';
import { TOOL_DEFS } from './tools.js';

export async function connectToBridge({ url, runId, token, WebSocketImpl = globalThis.WebSocket, timeoutMs = 10 * 60 * 1000 }) {
  const ws = new WebSocketImpl(url);
  const channel = createRequestChannel((f) => ws.send(JSON.stringify(f)), { timeoutMs });
  ws.addEventListener('message', (ev) => {
    let frame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    channel.handle(frame);
  });
  ws.addEventListener('close', () => channel.rejectAll('bridge connection closed'));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot reach the bridge at ${url}`)), { once: true });
  });
  await channel.request({ type: MSG.HELLO, role: 'tool', runId, token });
  return {
    ws,
    async call(tool, input) {
      const res = await channel.request({ type: MSG.TOOL_CALL, tool, input });
      return res.result;
    },
    close() {
      ws.close();
    },
  };
}

export function buildServer(link) {
  const server = new McpServer({ name: 'peruser', version: '0.1.0' }, { instructions: 'Tools that inspect and patch the live browser tab the user is looking at.' });
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input, annotations: def.readOnly ? { readOnlyHint: true } : undefined },
      async (input) => {
        try {
          const result = await link.call(def.name, input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function main(env = process.env, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const url = env.PERUSER_BRIDGE_URL;
  const runId = env.PERUSER_RUN_ID;
  const token = env.PERUSER_RUN_TOKEN;
  if (!url || !runId || !token) throw new Error('PERUSER_BRIDGE_URL, PERUSER_RUN_ID and PERUSER_RUN_TOKEN are required');
  const link = await connectToBridge({ url, runId, token });
  const server = buildServer(link);
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  return { server, link, transport };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`peruser mcp: ${e.message}\n`);
    process.exit(1);
  });
}
