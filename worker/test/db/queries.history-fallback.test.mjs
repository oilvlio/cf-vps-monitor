import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('Ping rollup failure propagates instead of returning incomplete raw history', async () => {
  const calls = [];
  const expected = { 1: [{ time: '2026-11-01T00:00:00Z', value: 12 }] };
  const loader = createWorkerLoader({ db: null, overrides: {
    'worker/src/db/supabase-api/client.ts': {
      getSupabasePingRollupRange: async (...args) => { calls.push(args); throw new Error('rollup unavailable'); },
      getSupabasePingRecordsForTasksRangeBucketed: async (...args) => { calls.push(args); return expected; },
    },
  } });
  const queries = loader.load('worker/src/db/queries.ts');
  await assert.rejects(queries.getPingRollupRange({ env: {} }, 'node', [1], 'start', 'end', 10800, 1500), /rollup unavailable/);
  assert.equal(calls.length, 1);
});

test('Ping rollup stats failure propagates without substituting raw statistics', async () => {
  let rawCalls = 0;
  const loader = createWorkerLoader({ db: null, overrides: {
    'worker/src/db/supabase-api/client.ts': {
      getSupabasePingStatsFromRollupRange: async () => { throw new Error('rollup unavailable'); },
      getSupabasePingStatsForTasksRange: async () => { rawCalls++; throw new Error('raw unavailable'); },
    },
  } });
  const queries = loader.load('worker/src/db/queries.ts');
  await assert.rejects(queries.getPingStatsFromRollupRange({ env: {} }, 'node', [1], 'start', 'end'), /rollup unavailable/);
  assert.equal(rawCalls, 0);
});

test('Host aggregate failure cannot be masked by a successful raw-only response', async () => {
  const calls = [];
  const expected = [{ ts: 10, samples: 2, minutes: 4, cpu: 5 }];
  const loader = createWorkerLoader({ db: null, overrides: {
    'worker/src/db/supabase-api/client.ts': {
      getSupabaseRecordsByTimeRangeAggregated: async (...args) => { calls.push(['rollup', ...args]); throw new Error('rollup unavailable'); },
      getSupabaseRecordsByTimeRangeAggregatedRaw: async (...args) => { calls.push(['raw', ...args]); return expected; },
    },
  } });
  const queries = loader.load('worker/src/db/queries.ts');
  await assert.rejects(queries.getRecordsByTimeRangeAggregated({ env: {} }, 'node', 'start', 'end', 3600, 2000, 120), /rollup unavailable/);
  assert.equal(calls.length, 1);
});
