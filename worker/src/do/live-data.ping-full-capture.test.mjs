import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

// 回归：24h 内的 Ping 历史应按落库间隔全量保存。
// 此前 shouldPersistPingResult 会把「与上次落库值相差 <5ms」的结果整批丢掉，
// 延迟稳定的任务只剩每 30 分钟一条心跳，曲线上点稀疏到几乎没有。
async function setup(t, intervalSec = 120) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('full-capture-node','Full capture')");
  const tasks = [1, 2].map(id => ({ id, name: `Task ${id}`, type: 'tcp', target: 'example.test:443', all_clients: true, clients: [], interval_sec: intervalSec }));
  const external = {
    getSettingsByKeys: async () => ({ record_enabled: 'true', ping_record_persist_interval_sec: String(intervalSec) }),
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
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

test('stable ping latency is persisted on every interval, not only on the 30 minute heartbeat', async t => {
  const { database, object } = await setup(t);
  const start = Date.UTC(2026, 9, 17, 0, 0, 0);
  // 两个任务的延迟都在 ±3ms 内抖动，永远达不到 5ms 的变化阈值。
  const jitter = [50, 52, 49, 51, 50, 53, 48, 50, 52, 51];
  for (let i = 0; i < jitter.length; i += 1) {
    await object.persistPingResult('full-capture-node', {
      results: [{ task_id: 1, value: jitter[i] }, { task_id: 2, value: 100 + jitter[i] }],
    }, start + i * 120_000);
  }
  const rows = (await database.query('select values_json from ping_snapshots order by time')).rows;
  assert.equal(rows.length, jitter.length, '每个落库间隔都应有一行（24h 内全量）');
  assert.deepEqual(rows.map(r => r.values_json['1']), jitter);
});

test('reports faster than the persist interval are still throttled', async t => {
  const { database, object } = await setup(t);
  const start = Date.UTC(2026, 9, 17, 0, 0, 0);
  // 每 30 秒上报一次，落库间隔 120 秒：5 分钟内只应落 3 行（0s、120s、240s）。
  for (let i = 0; i <= 10; i += 1) {
    await object.persistPingResult('full-capture-node', { results: [{ task_id: 1, value: 50 }, { task_id: 2, value: 60 }] }, start + i * 30_000);
  }
  const rows = (await database.query('select 1 from ping_snapshots')).rows;
  assert.equal(rows.length, 3, '间隔节流不应受影响');
});

test('loss and recovery are persisted as they happen', async t => {
  const { database, object } = await setup(t);
  const start = Date.UTC(2026, 9, 17, 0, 0, 0);
  const values = [50, -1, -1, 50];
  for (let i = 0; i < values.length; i += 1) {
    await object.persistPingResult('full-capture-node', { results: [{ task_id: 1, value: values[i] }, { task_id: 2, value: 60 }] }, start + i * 120_000);
  }
  const rows = (await database.query('select values_json from ping_snapshots order by time')).rows;
  assert.deepEqual(rows.map(r => r.values_json['1']), values);
});
