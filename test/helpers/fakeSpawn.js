// A controllable stand-in for child_process.spawn.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdinData = '';
    child.stdin.on('data', (d) => (child.stdinData += d));
    child.killed = [];
    child.kill = (sig) => child.killed.push(sig);
    calls.push({ command, args, opts, child });
    setImmediate(() => script({ command, args, opts, child }));
    return child;
  };
  return { spawn, calls };
}

/** Script helper: emit stdout lines and close. */
export function scripted({ lines = [], stderr = '', code = 0, delayClose = 0 } = {}) {
  return ({ child }) => {
    for (const l of lines) child.stdout.write(typeof l === 'string' ? l + '\n' : JSON.stringify(l) + '\n');
    if (stderr) child.stderr.write(stderr);
    setTimeout(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    }, delayClose);
  };
}
