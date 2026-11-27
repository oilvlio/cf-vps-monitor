import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

// Recent, 120-second-aligned base so raw writes stay inside the late-arrival
// window instead of expiring with the wall clock.
const START = Math.floor((Date.now() - 60 * 60 * 1000) / 120_000) * 120_000;
// 回归：24h 内的 Ping 历史应按落库间隔全量保存。
// 此前 shouldPersistPingResult 会把「与上次落库值相差 <5ms」的结果整批丢掉，
// 延迟稳定的任务只剩每 30 分钟一条心跳，曲线上点稀疏到几乎没有。
async function setup(t, intervalSec = 120, insertSnapshotOverride) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('full-capture-node','Full capture')");
  const tasks = [1, 2].map(id => ({ id, name: `Task ${id}`, type: 'tcp', target: 'example.test:443', all_clients: true, clients: [], interval_sec: intervalSec }));
  const external = {
    getSettingsByKeys: async () => ({ record_enabled: 'true', ping_record_persist_interval_sec: String(intervalSec) }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageBytes: async () => ({ allocated_bytes: 0, total: 0 }),
    listPingTasks: async () => tasks,
    getSetting: async () => null, setSetting: async () => {},
    tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
    insertPingSnapshot: insertSnapshotOverride || (async (_db, client, time, results) => rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: client, input_time: time, input_results: results,
    })),
  };
  const { LiveDataDO } = createWorkerLoader({ db: external }).load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});
  await state.drain();
  return { database, object, state, LiveDataDO };
}

test('report batches merge distinct task results with the same snapshot timestamp', async t => {
  const { database, object } = await setup(t);
  const stamp = START + 120_000;
  await object.persistPingResultsFromReports('full-capture-node', [
    { report: { ping_results: [{ task_id: 1, value: 41, timestamp: stamp }] }, reportTime: stamp },
    { report: { ping_results: [{ task_id: 2, value: 73, timestamp: stamp }] }, reportTime: stamp },
  ], stamp);

  const rows = (await database.query(`
    select time, values_json from ping_snapshots where client='full-capture-node' order by time
  `)).rows;
  assert.equal(rows.length, 1, 'one timestamp must result in one primary-key upsert');
  assert.equal(new Date(rows[0].time).getTime(), stamp);
  assert.deepEqual(rows[0].values_json, { 1: 41, 2: 73 });
});
