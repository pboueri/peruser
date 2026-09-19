// Command-line entry: `peruser-bridge [--port N] [--root DIR] [--fake]`

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, DEFAULT_ROOT } from './store.js';
import { Bridge } from './server.js';
import { createHarnesses } from './harness/index.js';
import { DEFAULT_BRIDGE_PORT } from '../../src/lib/protocol.js';

export function parseArgs(argv) {
  const out = { port: DEFAULT_BRIDGE_PORT, root: DEFAULT_ROOT, fake: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--root' || a === '-r') out.root = path.resolve(argv[++i]);
    else if (a === '--fake') out.fake = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be a number between 0 and 65535');
  return out;
}

export const HELP = `peruser-bridge — local companion for the Peruser Chrome extension

  --port, -p N     WebSocket port (default ${DEFAULT_BRIDGE_PORT}; the extension must use the same)
  --root, -r DIR   where patches are stored (default ~/.peruser)
  --fake           also offer the scripted "fake" harness (for demos and tests)
  --help, -h       this text
`;

export async function startBridge({ port, root, fake, log = console.log, env = process.env } = {}) {
  const store = await new Store({ root }).init();
  store.watch();
  const harnesses = createHarnesses({ env, includeFake: fake });
  const mcpCommand = { command: process.execPath, args: [fileURLToPath(new URL('./mcp-stdio.js', import.meta.url))] };
  const bridge = new Bridge({ store, harnesses, port, log, mcpCommand });
  await bridge.start();
  store.on('error', (e) => log(`store error: ${e.message}`));
  log(`patches live in ${store.root}`);
  for (const h of harnesses.available()) log(`harness ${h.label}: ${h.available ? 'available' : `not found (${h.command} is not on PATH)`}`);
  if (store.problems.length) for (const p of store.problems) log(`warning: ${p}`);
  return { bridge, store, harnesses, async close() {
    await bridge.stop();
    store.close();
  } };
}

export async function main(argv = process.argv.slice(2), { log = console.log, exit = process.exit, env = process.env } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(`error: ${e.message}\n\n${HELP}`);
    return exit(2);
  }
  if (opts.help) {
    log(HELP);
    return exit(0);
  }
  const running = await startBridge({ ...opts, log, env });
  const shutdown = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    log('shutting down');
    await running.close();
    exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return running;
}
