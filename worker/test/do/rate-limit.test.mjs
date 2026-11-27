import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

function fixture() {
  let now = 1_800_000_000_000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const { RateLimitDO } = createWorkerLoader({ globals: { Date: Clock } }).load('worker/src/do/rate-limit.ts');
  const state = createDurableState();
  let writes = 0;
  const put = state.state.storage.put;
  state.state.storage.put = async (key, value) => {
    writes += 1;
    return put(key, value);
  };
  return {
    object: new RateLimitDO(state.state, {}),
    state,
    writes: () => writes,
    advance: ms => { now += ms; },
  };
}

function limitRequest(body) {
  return new Request('https://do/rate-limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('health probe is read-only', async () => {
  const { object, state, writes } = fixture();
  const response = await object.fetch(new Request('https://do/health', { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(state.values.size, 0);
  assert.equal(writes(), 0, 'health checks must not consume Durable Object writes');
});

test('rejected requests stop writing after the window is saturated', async () => {
  const { object, writes, advance } = fixture();
  const body = { bucket: 'agent-auth-failure', ip: 'sha256:abc', max: 2, windowMs: 60_000 };

  assert.equal((await (await object.fetch(limitRequest(body))).json()).allowed, true);
  assert.equal((await (await object.fetch(limitRequest(body))).json()).allowed, true);
  assert.equal(writes(), 2);

  const rejected = await (await object.fetch(limitRequest(body))).json();
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);
  assert.equal(writes(), 2, 'a rejected request must not add another storage write');

  advance(60_001);
  assert.equal((await (await object.fetch(limitRequest(body))).json()).allowed, true);
  assert.equal(writes(), 3, 'a new window resumes counting');
});
