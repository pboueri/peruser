// Codex adapter: runs the locally installed `codex` CLI non-interactively
// with Peruser's browser tools attached as an MCP server. Best effort: the
// exact flag set is configurable through PERUSER_CODEX_ARGS.

import os from 'node:os';
import { runProcess, parseJsonLine } from './process.js';

function tomlString(s) {
  return JSON.stringify(String(s));
}

function tomlArray(arr) {
  return `[${arr.map(tomlString).join(', ')}]`;
}

function tomlTable(obj) {
  return `{ ${Object.entries(obj)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(', ')} }`;
}

export function createCodexHarness({ spawn, command = 'codex', extraArgs = [] } = {}) {
  return {
    name: 'codex',
    label: 'Codex',
    command,
    buildArgs({ prompt, system, mcp, model, cwd }) {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        cwd,
        '-c',
        `mcp_servers.peruser.command=${tomlString(mcp.command)}`,
        '-c',
        `mcp_servers.peruser.args=${tomlArray(mcp.args)}`,
        '-c',
        `mcp_servers.peruser.env=${tomlTable(mcp.env)}`,
      ];
      if (model) args.push('-m', model);
      args.push(...extraArgs);
      args.push(`${system}\n\n${prompt}`);
      return args;
    },
    async run({ prompt, system, mcp, model, signal, onEvent }) {
      if (!mcp) throw new Error('Codex needs the MCP tool server');
      let lastText = '';
      let error = null;
      const { code, stderr } = await runProcess({
        spawn,
        command,
        args: this.buildArgs({ prompt, system, mcp, model, cwd: os.tmpdir() }),
        env: {},
        signal,
        onLine: (line) => {
          const msg = parseJsonLine(line);
          if (!msg) return onEvent({ kind: 'log', text: line });
          if (msg.type === 'thread.started') return onEvent({ kind: 'status', text: `Codex thread ${msg.thread_id || ''}`.trim() });
          if (msg.type === 'error') {
            error = msg.message || 'Codex reported an error';
            return onEvent({ kind: 'log', text: error });
          }
          const item = msg.item;
          if (!item) return;
          if (msg.type === 'item.completed' && item.type === 'agent_message' && item.text?.trim()) {
            lastText = item.text.trim();
            return onEvent({ kind: 'assistant', text: lastText });
          }
          if (msg.type === 'item.started' && item.type === 'mcp_tool_call') {
            return onEvent({ kind: 'thinking_tool', tool: item.tool, input: item.arguments });
          }
        },
      });
      if (error) return { error, lastText };
      if (code !== 0) return { error: `codex exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, lastText };
      return { lastText };
    },
  };
}
