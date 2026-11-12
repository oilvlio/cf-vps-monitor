import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

function createClosableSocket() {
  return {
    readyState: 1,
    closeCalls: [],
    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.readyState = 3;
    },
    serializeAttachment() {},
    deserializeAttachment() { return null; },
  };
}

test('DO retire closes every session so agents reconnect to the new object', async () => {
  const first = createClosableSocket();
  const second = createClosableSocket();
  const loader = createWorkerLoader();
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(createDurableState([], [first, second]).state, {});

  const response = await object.fetch(new Request('https://do/retire', { method: 'POST' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.closed, 2);
  assert.deepEqual(first.closeCalls, [{ code: 1012, reason: 'Live data object retired' }]);
  assert.deepEqual(second.closeCalls, [{ code: 1012, reason: 'Live data object retired' }]);
});

test('reading /retire does not close sessions', async () => {
  const socket = createClosableSocket();
  const loader = createWorkerLoader();
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(createDurableState([], [socket]).state, {});

  await object.fetch(new Request('https://do/retire'));
  assert.deepEqual(socket.closeCalls, []);
});
