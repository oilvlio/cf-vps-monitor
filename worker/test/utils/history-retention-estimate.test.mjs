import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { estimateHistoryRetention } = createWorkerLoader().load('worker/src/utils/history-retention-estimate.ts');

test('retention estimate scales host raw, Ping raw and shared rollup storage by their settings', () => {
  const estimate = estimateHistoryRetention({
    records: 100, ping_snapshots: 200,
    host_rollup: 300, ping_rollup: 100, total: 700,
  }, {
    record_preserve_time: 100, ping_record_preserve_time: 200, rollup_preserve_time: 300,
  }, {
    record_preserve_time: 200, ping_record_preserve_time: 100, rollup_preserve_time: 600,
  }, 10, 1200);

  assert.equal(estimate.current_bytes, 700);
  assert.equal(estimate.projected_bytes, 1100);
  assert.equal(estimate.per_client_change_bytes, 40);
  assert.ok(Math.abs(estimate.budget_ratio - (1100 / 1200)) < 1e-12);
  assert.equal(estimate.capacity_risk, true);
});

test('zero nodes omit per-node estimate and zero budget does not report a false risk', () => {
  const estimate = estimateHistoryRetention({ total: 100 }, {
    record_preserve_time: 168, ping_record_preserve_time: 168, rollup_preserve_time: 2160,
  }, {
    record_preserve_time: 168, ping_record_preserve_time: 168, rollup_preserve_time: 2160,
  }, 0, 0);
  assert.equal(estimate.per_client_change_bytes, null);
  assert.equal(estimate.capacity_risk, false);
});
