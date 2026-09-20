// Harness registry: which coding agents the bridge can drive.

import { spawnSync } from 'node:child_process';
import { createClaudeHarness } from './claude.js';
import { createCodexHarness } from './codex.js';
import { createFakeHarness } from './fake.js';

export function commandExists(command, { spawnSync: spawnSyncImpl = spawnSync } = {}) {
  try {
    const r = spawnSyncImpl(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

export function createHarnesses({ spawn, spawnSync: spawnSyncImpl, env = process.env, includeFake = false } = {}) {
  const map = new Map();
  map.set('claude', createClaudeHarness({ spawn, command: env.PERUSER_CLAUDE_COMMAND || 'claude', extraArgs: splitArgs(env.PERUSER_CLAUDE_ARGS) }));
  map.set('codex', createCodexHarness({ spawn, command: env.PERUSER_CODEX_COMMAND || 'codex', extraArgs: splitArgs(env.PERUSER_CODEX_ARGS) }));
  if (includeFake || env.PERUSER_FAKE_HARNESS) map.set('fake', createFakeHarness());
  const availability = new Map();
  return {
    get(name) {
      return map.get(name) || null;
    },
    names() {
      return [...map.keys()];
    },
    available() {
      return [...map.values()].map((h) => {
        if (!availability.has(h.name)) availability.set(h.name, h.command ? commandExists(h.command, { spawnSync: spawnSyncImpl }) : true);
        return { name: h.name, label: h.label, available: availability.get(h.name), command: h.command || null };
      });
    },
  };
}

export function splitArgs(s) {
  if (!s) return [];
  return s.match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, ''));
}
