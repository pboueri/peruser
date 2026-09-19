// Shared helper: spawn a CLI, stream its stdout line by line, kill on abort.

import { spawn as nodeSpawn } from 'node:child_process';

export function runProcess({ spawn = nodeSpawn, command, args, env, cwd, signal, onLine, onStderr = () => {}, stdinText = null }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let stdoutBuf = '';
    let stderr = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      done(reject, signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    child.on('error', (e) => done(reject, e.code === 'ENOENT' ? new Error(`${command} is not installed or not on PATH`) : e));
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      onStderr(String(chunk));
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim()) onLine(stdoutBuf.trim());
      done(resolve, { code, stderr });
    });
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

export function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
