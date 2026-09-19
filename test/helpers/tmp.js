import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tmpDir(prefix = 'peruser-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeoutMs = 3000, stepMs = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout in until()');
    await wait(stepMs);
  }
}
