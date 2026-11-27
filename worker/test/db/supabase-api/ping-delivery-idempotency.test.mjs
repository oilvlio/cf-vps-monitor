import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

// v2 keeps one raw row per (client, time) and merges task keys on conflict, so a
// retry that only carries part of the tasks cannot drop the others.
test('V-W01 Ping retries merge task keys into one (client, time) row', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('delivery-node','Synthetic delivery fixture')");
  await database.query(`
    insert into ping_tasks(id,name,target,clients) values
      (1,'one','example.com','["delivery-node"]'),
      (2,'two','example.com','["delivery-node"]'),
      (3,'three','example.com','["delivery-node"]')
  `);
  const observedMs = Math.floor((Date.now() - 60 * 60 * 1000) / (30 * 60 * 1000)) * 30 * 60 * 1000;
  const args = { input_client: 'delivery-node', input_time: new Date(observedMs).toISOString() };

  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 1, value: 10 }, { taskId: 2, value: 20 }] });
  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 2, value: 20 }, { taskId: 1, value: 10 }] });

  const afterRetry = (await database.query('select values_json from ping_snapshots order by time')).rows;
  assert.equal(afterRetry.length, 1, 'reordered retries must not duplicate history');
  assert.deepEqual(afterRetry[0].values_json, { 1: 10, 2: 20 });

  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 3, value: 30 }] });
  const afterMerge = (await database.query('select values_json from ping_snapshots order by time')).rows;
  assert.equal(afterMerge.length, 1, 'a later delivery merges into the same row instead of duplicating it');
  assert.deepEqual(afterMerge[0].values_json, { 1: 10, 2: 20, 3: 30 },
    'tasks missing from the retransmission keep their earlier values');
});
