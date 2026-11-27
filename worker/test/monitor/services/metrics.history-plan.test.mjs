import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const DAY = 86_400_000;

test('Host-only metrics do not depend on the Ping task catalog', async () => {
  let pingReads = 0;
  const loader = createWorkerLoader({ db: {
    listPingTasks: async () => { pingReads++; throw new Error('Ping unavailable'); },
    getSettingsByKeys: async () => ({ record_persist_interval_sec: '120' }),
    getRecordsByTimeRangeAggregated: async () => [{ ts: 1795737600, cpu: 42, samples: 1 }],
  } });
  const { loadMonitorMetrics } = loader.load('worker/src/monitor/services/metrics.ts');
  const result = await loadMonitorMetrics({}, 'node', {
    start: '2026-11-26T00:00:00Z', end: '2026-11-27T00:00:00Z', step: 60, series: 'metrics',
  });
  assert.equal(pingReads, 0);
  assert.equal(result.payload.metrics.length, 1);
  assert.equal(result.payload.metrics[0].cpu, 42);
});

for (const [days, requestedStep, hostRetentionHours, pingRetentionHours, expectedStep, expectedSource] of [
  [7, 10080, 168, 168, 10800, 'rollup'],
  [8, 3601, 168, 168, 7200, 'rollup'],
  [30, 10080, 168, 168, 10800, 'rollup'],
  [3, 360, 48, 48, 3600, 'rollup'],
  [3, 360, 168, 168, 360, 'raw'],
  [8, 3600, 720, 720, 3600, 'raw'],
  [8, 3600, 168, 168, 3600, 'rollup'],
  // Host history rolls up at 48h while Ping is still raw at 168h. The response
  // grid is hourly, so the raw Ping RPC must use that same one-hour bucket.
  [3, 360, 48, 168, 3600, 'raw'],
]) {
  test(`Monitor ${days}d host retention=${hostRetentionHours}h Ping retention=${pingRetentionHours}h uses one grid`, async () => {
    const calls = [];
    const statsCalls = [];
    const loader = createWorkerLoader({ db: {
      listPingTasks: async () => [{ id: 1, name: 'probe', clients: ['node'], all_clients: false }],
      getSettingsByKeys: async () => ({ record_persist_interval_sec: '120', record_preserve_time: String(hostRetentionHours), ping_record_preserve_time: String(pingRetentionHours) }),
      getRecordsByTimeRangeAggregated: async (...args) => { calls.push(['host', args[4], args[2], args[3]]); return []; },
      getPingRollupRange: async (...args) => { calls.push(['rollup', args[5], args[3], args[4]]); return {}; },
      getPingRecordsForTasksRangeBucketed: async (...args) => { calls.push(['raw', args[5], args[3], args[4]]); return {}; },
      getPingStatsFromRollupRange: async (...args) => { statsCalls.push(['rollup', args[3], args[4]]); return {}; },
      getPingStatsForTasksRange: async (...args) => { statsCalls.push(['raw', args[3], args[4]]); return {}; },
    } });
    const { loadMonitorMetrics } = loader.load('worker/src/monitor/services/metrics.ts');
    const end = Date.now();
    // Grid alignment can extend the actual window by almost one output step.
    const result = await loadMonitorMetrics({}, 'node', {
      start: new Date(end - days * DAY - requestedStep * 1000).toISOString(),
      end: new Date(end).toISOString(), rangeMs: days * DAY,
      step: requestedStep, series: '',
    });
    assert.equal(result.payload.step, expectedStep);
    assert.deepEqual(calls.map(([source, step]) => [source, step]), [['host', expectedStep], [expectedSource, expectedStep]]);
    assert.equal(calls[0][2], calls[1][2], 'host and ping must use the same aligned start');
    assert.equal(calls[0][3], calls[1][3], 'host and ping must use the same end');
    // 整窗 loss 用与绘图桶相同的 raw/rollup 源，且窗口完全一致。
    assert.deepEqual(statsCalls.map(([source]) => source), [expectedSource], '整窗统计应跟随绘图桶的源');
    assert.equal(statsCalls[0][1], calls[0][2], '整窗统计必须与绘图桶共用对齐后的起点');
    assert.equal(statsCalls[0][2], calls[0][3], '整窗统计必须与绘图桶共用终点');
  });
}
