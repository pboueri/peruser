// Boots the fixture site and a bridge with the fake harness for the whole run.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixtures/server.js';
import { startBridge } from '../bridge/src/cli.js';

export default async function globalSetup() {
  const site = await startFixtureServer(48910);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'peruser-e2e-'));
  const bridge = await startBridge({ port: 48999, root, fake: true, log: () => {}, env: { PERUSER_CLAUDE_COMMAND: 'no-such-claude', PERUSER_CODEX_COMMAND: 'no-such-codex' } });
  process.env.PERUSER_E2E_SITE = site.url;
  process.env.PERUSER_E2E_ROOT = root;
  process.env.PERUSER_E2E_PORT = '48999';
  return async () => {
    await bridge.close();
    await new Promise((r) => site.server.close(r));
    await fsp.rm(root, { recursive: true, force: true });
  };
}
