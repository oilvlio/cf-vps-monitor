import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

for (const [retentionHours, expectedReader] of [[48, 'rollup'], [168, 'raw']]) {
  test(`public Ping history selects ${expectedReader} from ${retentionHours}h retention`, async () => {
    const now = Date.now();
    const start = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    const end = new Date(now - 60 * 60 * 60 * 1000).toISOString();
    const calls = [];
    const db = {
      listPublicClientRows: async () => [{ uuid: 'node', name: 'Node', hidden: false }],
      getSettingsByKeys: async (_database, keys) => Object.fromEntries(keys.map(key => [
        key, key === 'ping_record_preserve_time' ? String(retentionHours) : '120',
      ])),
      getPingRollupRange: async (_database, ...args) => { calls.push(['rollup', ...args]); return { 1: [] }; },
      getPingRecordsForTasksRangeBucketed: async (_database, ...args) => { calls.push(['raw_bucketed', ...args]); return { 1: [] }; },
      getPingRecordsForTasksRange: async (_database, ...args) => { calls.push(['raw', ...args]); return { 1: [] }; },
    };
    const { publicRoutes } = createWorkerLoader({ db }).load('worker/src/routes/public.ts');
    const response = await publicRoutes.fetch(new Request(
      `https://example.test/records/ping?uuid=node&task_id=1&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    ), { LIVE_DATA: { idFromName: () => 'global', get: () => ({
      fetch: async () => Response.json({ clients: [], removed: [] }),
    }) } });
    assert.equal(response.status, 200);
    assert.equal(calls[0][0], expectedReader);
  });
}
