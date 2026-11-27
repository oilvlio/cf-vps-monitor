import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

const MiB = 1024 * 1024;
function fixture(initial = []) {
  let allocated = 20 * MiB;
  let calls = 0;
  const state = createDurableState(initial);
  const db = {
    getHistoryStorageBytes: async () => {
      calls += 1;
      return { allocated_bytes: allocated, total: allocated };
    },
    getSetting: async () => null, setSetting: async () => {}, tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
  };
  const { LiveDataDO } = createWorkerLoader({ db }).load('worker/src/do/live-data.ts');
  return {
    object: new LiveDataDO(state.state, {}),
    state,
    get calls() { return calls; },
    setAllocated: value => { allocated = value; },
  };
}

test('AUD-13: reclaimable allocated bytes cannot permanently block a small live dataset', async () => {
  const f = fixture();
  const now = Date.now();
  assert.equal(await f.object.canPersistWithinCapacity(now), true);
  assert.equal(f.object.recordCapacityBytes, 20 * MiB);
  for (let index = 1; index < 20; index += 1) assert.equal(await f.object.canPersistWithinCapacity(now + index), true);
  assert.equal(f.calls, 1, 'the potentially expensive usage query is cached');
});

test('AUD-13: the fuse resumes below its low watermark after deletion without shrinking allocated files', async () => {
  const f = fixture();
  let now = Date.now();
  f.setAllocated(450 * MiB);
  assert.equal(await f.object.canPersistWithinCapacity(now), false);
  f.setAllocated(360 * MiB);
  now += 61000;
  assert.equal(await f.object.canPersistWithinCapacity(now), false, '90% is still above the 80% recovery watermark');
  f.setAllocated(300 * MiB);
  now += 61000;
  assert.equal(await f.object.canPersistWithinCapacity(now), true);
});

test('AUD-13: snapshots from the old row-count model are invalidated across an upgrade', async () => {
  const now = Date.now();
  const f = fixture([['record:capacity:snapshot', {
    rows: 20, bytes: 600 * MiB, blocked: true, checkedAt: now - 1000, nextCheckAt: now + 3600000,
    highWatermarkRows: 700000, highWatermarkBytes: 400 * MiB,
  }]]);
  assert.equal(await f.object.canPersistWithinCapacity(now), true);
  assert.equal(f.calls, 1);
});