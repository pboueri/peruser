// Claude Code adapter: runs the locally installed `claude` CLI in headless
// mode with Peruser's browser tools attached as an MCP server. Auth is
// whatever the CLI is already logged in with.

import { runProcess, parseJsonLine } from './process.js';
import { TOOL_NAMES } from '../tools.js';

const BUILTIN_TOOLS_TO_BLOCK = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];

export function createClaudeHarness({ spawn, command = 'claude', extraArgs = [] } = {}) {
  return {
    name: 'claude',
    label: 'Claude Code',
    command,
    buildArgs({ prompt, system, mcp, model }) {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--append-system-prompt',
        system,
        '--mcp-config',
        JSON.stringify({ mcpServers: { peruser: mcp } }),
        '--strict-mcp-config',
        '--allowedTools',
        TOOL_NAMES.map((t) => `mcp__peruser__${t}`).join(','),
        '--disallowedTools',
        BUILTIN_TOOLS_TO_BLOCK.join(','),
        '--max-turns',
        '40',
      ];
      if (model) args.push('--model', model);
      return args.concat(extraArgs);
    },
    async run({ prompt, system, mcp, model, signal, onEvent }) {
      if (!mcp) throw new Error('Claude Code needs the MCP tool server');
      let lastText = '';
      let cost = null;
      let turns = null;
      let resultError = null;
      const { code, stderr } = await runProcess({
        spawn,
        command,
        args: this.buildArgs({ prompt, system, mcp, model }),
        env: {},
        signal,
        onLine: (line) => {
          const msg = parseJsonLine(line);
          if (!msg) return onEvent({ kind: 'log', text: line });
          if (msg.type === 'system' && msg.subtype === 'init') return onEvent({ kind: 'status', text: `Claude Code session ${msg.session_id || ''} (${msg.model || 'default model'})`.trim() });
          if (msg.type === 'assistant') {
            for (const block of msg.message?.content || []) {
              if (block.type === 'text' && block.text?.trim()) {
                lastText = block.text.trim();
                onEvent({ kind: 'assistant', text: lastText });
              } else if (block.type === 'tool_use') {
                onEvent({ kind: 'thinking_tool', tool: String(block.name || '').replace(/^mcp__peruser__/, ''), input: block.input });
              }
            }
            return;
          }
          if (msg.type === 'result') {
            cost = msg.total_cost_usd ?? null;
            turns = msg.num_turns ?? null;
            if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) resultError = msg.result || msg.subtype || 'Claude Code reported an error';
          }
        },
      });
      if (resultError) return { error: resultError, lastText, cost, turns };
      if (code !== 0) return { error: `claude exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, lastText, cost, turns };
      return { lastText, cost, turns };
    },
  };
}
