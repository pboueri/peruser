import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, TOOLS, DEFAULT_BRIDGE_PORT, nextId, createRequestChannel } from '../src/lib/protocol.js';

test('constants', () => {
  assert.equal(typeof MSG.AGENT_START, 'string');
  assert.ok(TOOLS.includes('finish'));
  assert.equal(DEFAULT_BRIDGE_PORT, 48923);
  assert.notEqual(nextId(), nextId());
  assert.match(nextId('x'), /^x/);
});

test('request channel resolves, rejects and times out', async () => {
  const sent = [];
  const ch = createRequestChannel((f) => sent.push(f), { timeoutMs: 30 });
  const p = ch.request({ type: 'a' });
  assert.equal(ch.size, 1);
  assert.equal(ch.handle({ id: 'unknown' }), false);
  assert.equal(ch.handle(null), false);
  assert.equal(ch.handle({ id: sent[0].id, type: 'ok', v: 1 }), true);
  assert.equal((await p).v, 1);

  const p2 = ch.request({ type: 'b' });
  ch.handle({ id: sent[1].id, type: MSG.ERROR, error: 'boom' });
  await assert.rejects(p2, /boom/);
  const p2b = ch.request({ type: 'b' });
  ch.handle({ id: sent[2].id, type: MSG.ERROR });
  await assert.rejects(p2b, /error/);

  const p3 = ch.request({ type: 'c' });
  await assert.rejects(p3, /timeout waiting for c/);

  const p4 = ch.request({ type: 'd' });
  ch.rejectAll('closed');
  await assert.rejects(p4, /closed/);
  assert.equal(ch.size, 0);

  const bad = createRequestChannel(() => {
    throw new Error('send failed');
  });
  await assert.rejects(bad.request({ type: 'e' }), /send failed/);
  assert.equal(bad.size, 0);
});
