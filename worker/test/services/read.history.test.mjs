import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const DAY = 86_400_000;

function loaderWith(calls) {
  const db = {
    getPingRollupRange: async (...args) => { calls.push(['rollup', ...args]); return { 1: [] }; },
    getPingRecordsForTasksRangeBucketed: async (...args) => { calls.push(['bucketed', ...args]); return { 1: [] }; },
    getPingRecordsForTasksRange: async (...args) => { calls.push(['raw', ...args]); return { 1: [] }; },
    getPingStatsFromRollupRange: async (...args) => { calls.push(['stats-rollup', ...args]); return {}; },
    getPingStatsForTasksRange: async (...args) => { calls.push(['stats-raw', ...args]); return {}; },
    getRecordsByTimeRangeBucketed: async (...args) => { calls.push(['host-bucketed', ...args]); return []; },
    getRecordsByTimeRangeLimited: async (...args) => { calls.push(['host-raw', ...args]); return []; },
    getRecordsByTimeRangeAggregated: async (...args) => { calls.push(['host-aggregated', ...args]); return []; },
  };
  return createWorkerLoader({ db }).load('worker/src/services/read/history.ts');
}

test('history read: Ping plans pick the matching RPC exactly once', async () => {
  const cases = [
    [{ source: 'rollup', stepSec: 1800 }, 'rollup'],
    [{ source: 'raw', stepSec: 360 }, 'bucketed'],
    [{ source: 'raw', stepSec: 0 }, 'raw'],
  ];
  for (const [plan, expected] of cases) {
    const calls = [];
    const history = loaderWith(calls);
    const result = await history.loadPingHistory({}, {
      uuid: 'node', taskIds: [1, 2], start: 'a', end: 'b', limit: 1500, plan,
    });
    assert.deepEqual(result, { 1: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], expected);
    if (expected === 'rollup' || expected === 'bucketed') {
      assert.deepEqual(calls[0].slice(1), [{}, 'node', [1, 2], 'a', 'b', plan.stepSec, 1500]);
    } else {
      assert.deepEqual(calls[0].slice(1), [{}, 'node', [1, 2], 'a', 'b', 1500]);
    }
  }
});

test('history read: window stats follow the plotting source', async () => {
  for (const [source, expected] of [['rollup', 'stats-rollup'], ['raw', 'stats-raw']]) {
    const calls = [];
    const history = loaderWith(calls);
    await history.loadPingWindowStats({}, {
      uuid: 'node', taskIds: [3], start: 'a', end: 'b', source,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], expected);
    assert.deepEqual(calls[0].slice(1), [{}, 'node', [3], 'a', 'b']);
  }
});

test('history read: native host windows keep the shared bucket boundary', async () => {
  {
    const calls = [];
    const history = loaderWith(calls);
    const end = new Date(Date.UTC(2026, 10, 26, 12));
    const start = new Date(end.getTime() - 4 * 60 * 60 * 1000);
    await history.loadHostHistory({}, {
      uuid: 'node', start: start.toISOString(), end: end.toISOString(), limit: 800,
    });
    assert.equal(calls[0][0], 'host-bucketed', 'short windows must also enforce the point budget');
    assert.equal(calls[0][5], 60);
  }
  {
    const calls = [];
    const history = loaderWith(calls);
    const end = new Date(Date.UTC(2026, 10, 26, 12));
    const start = new Date(end.getTime() - 2 * DAY);
    await history.loadHostHistory({}, {
      uuid: 'node', start: start.toISOString(), end: end.toISOString(), limit: 900,
    });
    assert.equal(calls[0][0], 'host-bucketed');
    assert.equal(calls[0][5], 360, '2 天窗口使用与 monitor 相同的 360s 步长');
  }
});

test('history read: monitor host aggregation goes through the same service', async () => {
  const calls = [];
  const history = loaderWith(calls);
  await history.loadAggregatedHostHistory({}, {
    uuid: 'node', start: 'a', end: 'b', stepSec: 7200, limit: 1500, sampleSec: 120,
  });
  assert.equal(calls[0][0], 'host-aggregated');
  assert.deepEqual(calls[0].slice(1), [{}, 'node', 'a', 'b', 7200, 1500, 120]);
});

test('history read: routes and monitor do not reimplement the raw/rollup choice', () => {
  for (const file of [
    'worker/src/routes/public.ts',
    'worker/src/monitor/services/metrics.ts',
  ]) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const symbol of [
      'getPingRollupRange',
      'getPingRecordsForTasksRangeBucketed',
      'getPingStatsFromRollupRange',
      'getPingStatsForTasksRange',
    ]) {
      assert.ok(
        !source.includes(symbol),
        `${file} 不应直接挑选 ${symbol}，统一走 services/read/history`,
      );
    }
  }
});
