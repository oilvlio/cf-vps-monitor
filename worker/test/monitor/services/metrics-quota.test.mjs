import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const { MonitorMetricsQuota } = createWorkerLoader().load('worker/src/monitor/services/metrics-quota.ts');

test('Monitor concurrent query quota coalesces identical work and releases slots after success and failure', async () => {
  const quota = new MonitorMetricsQuota(2);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const pending = quota.run('a', () => first.promise);
  assert.equal(quota.run('a', () => { throw new Error('must share'); }), pending);
  const failed = quota.run('b', () => second.promise);
  assert.equal(quota.run('c', async () => 3), null);
  first.resolve(1);
  assert.equal(await pending, 1);
  assert.equal(await quota.run('c', async () => 3), 3);
  second.reject(new Error('backend failure'));
  await assert.rejects(failed, /backend failure/);
  assert.equal(await quota.run('b', async () => 2), 2);
});

test('Monitor minute quota scales with public node count and validates updates', () => {
  const quota = new MonitorMetricsQuota();
  assert.equal(quota.limit(), 120);
  quota.update(30);
  assert.equal(quota.limit(), 900);
  quota.update(NaN);
  assert.equal(quota.limit(), 900);
  quota.update(10000);
  assert.equal(quota.limit(), 3000);
});
