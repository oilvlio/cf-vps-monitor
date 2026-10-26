import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

// Agent 不等服务端确认，按 Ping 间隔探测并把结果积压，随下一次上报一起发来。
// 每条结果带自己的探测时间，必须按它落库，而不是按收到报告的时间。
async function setup(t, intervalSec = 120) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('backlog-node','Backlog')");
  const tasks = [1, 2].map(id => ({ id, name: `Task ${id}`, type: 'tcp', target: 'example.test:443', all_clients: true, clients: [], interval_sec: intervalSec }));
  const external = {
    getSettingsByKeys: async () => ({ record_enabled: 'true', ping_record_persist_interval_sec: String(intervalSec) }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, live_row_bytes: 0, estimated_live_storage_bytes: 0, allocated_bytes: 0, reusable_bytes: null, measurement: 'live-row-bytes-test' }),
    listPingTasks: async () => tasks,
    getSetting: async () => null, setSetting: async () => {},
    tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
    insertPingSnapshot: async (_db, client, time, results) => rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: client, input_time: time, input_results: results,
    }),
  };
  const { LiveDataDO } = createWorkerLoader({ db: external }).load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});
  await state.drain();
  return { database, object };
}


const T0 = Date.UTC(2026, 9, 17, 0, 0, 0);
const round = (taskStamp, a, b) => ({ results: [{ task_id: 1, value: a, timestamp: taskStamp }, { task_id: 2, value: b, timestamp: taskStamp }] });

test('backlogged rounds delivered together are stored at their own probe times', async t => {
  const { database, object } = await setup(t);
  const receivedAt = T0 + 360_000;
  // 上报间隔 360s、Ping 间隔 120s：一次上报带来三轮结果，收到时间相同。
  for (let i = 0; i < 3; i += 1) {
    await object.persistPingResult('backlog-node', round(T0 + i * 120_000, 50 + i, 100 + i), receivedAt);
  }
  const rows = (await database.query('select time, values_json from ping_snapshots order by time')).rows;
  assert.equal(rows.length, 3, '每一轮探测都应落库，而不是只剩收到时间那一行');
  assert.deepEqual(rows.map(r => new Date(r.time).getTime()), [T0, T0 + 120_000, T0 + 240_000]);
  assert.deepEqual(rows.map(r => r.values_json['1']), [50, 51, 52]);
});

test('probe times that drift a few seconds from the interval are still accepted', async t => {
  const { database, object } = await setup(t);
  const stamps = [T0, T0 + 119_000, T0 + 240_500];
  for (const stamp of stamps) {
    await object.persistPingResult('backlog-node', round(stamp, 50, 60), T0 + 400_000);
  }
  const rows = (await database.query('select 1 from ping_snapshots')).rows;
  assert.equal(rows.length, 3);
});

test('results probed closer together than the interval are still throttled', async t => {
  const { database, object } = await setup(t);
  for (const stamp of [T0, T0 + 30_000, T0 + 60_000, T0 + 120_000]) {
    await object.persistPingResult('backlog-node', round(stamp, 50, 60), T0 + 200_000);
  }
  const rows = (await database.query('select 1 from ping_snapshots')).rows;
  assert.equal(rows.length, 2, '只保留 T0 与 T0+120s');
});

test('retrying an already stored batch does not duplicate rows', async t => {
  const { database, object } = await setup(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (let i = 0; i < 2; i += 1) {
      await object.persistPingResult('backlog-node', round(T0 + i * 120_000, 50, 60), T0 + 300_000);
    }
  }
  const rows = (await database.query('select 1 from ping_snapshots')).rows;
  assert.equal(rows.length, 2);
});

test('results probed before the retention window are discarded, future stamps are clamped', async t => {
  const { database, object } = await setup(t);
  const receivedAt = T0 + 10 * 24 * 3600_000;
  await object.persistPingResult('backlog-node', round(T0, 50, 60), receivedAt);
  await object.persistPingResult('backlog-node', round(receivedAt + 3600_000, 51, 61), receivedAt);
  const rows = (await database.query('select time, values_json from ping_snapshots order by time')).rows;
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].time).getTime(), receivedAt);
  assert.equal(rows[0].values_json['1'], 51);
});
