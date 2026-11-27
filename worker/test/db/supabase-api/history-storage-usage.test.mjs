import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

// Capacity uses only actual allocated bytes from the partition trees.
test('capacity counts partition-tree allocation and drops ghost relation keys', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`insert into clients(uuid) values ('synthetic-node')`);
    const before = await rpc(database, 'cfm_history_storage_bytes');
    await database.exec(`
      insert into records(client,time) select 'synthetic-node', now() - n * interval '1 second'
        from generate_series(1,20000) n;
      insert into ping_snapshots(client,time,values_json)
        values ('synthetic-node', now(), '{"7":10}');
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
        values ('synthetic-node',7,date_trunc('hour',now()),1,1,0,10,100);
      insert into host_rollup(client,bucket_start,sample_count,first_time,last_time)
        values ('synthetic-node',date_trunc('hour',now()),1,now(),now());
    `);
    const after = await rpc(database, 'cfm_history_storage_bytes');
    assert.ok(after.records > before.records, 'records bytes grow with retained rows');
    assert.equal(after.total,
      after.records + after.ping_snapshots + after.host_rollup + after.ping_rollup,
      'total is the sum of the live history partition trees');
    assert.equal(Object.hasOwn(after, 'gpu_records'), false);
    assert.equal(Object.hasOwn(after, 'ping_records'), false);
    assert.equal(after.allocated_bytes, after.total);

    const { evaluateHistoryCapacity } = await import('../../../src/utils/history-capacity.ts');
    const usage = { allocated_bytes: after.allocated_bytes };
    assert.equal(evaluateHistoryCapacity(usage, {
      byteLimit: after.total,
    }).blocked, true, 'byte limit blocks');
    assert.equal(evaluateHistoryCapacity(usage, {
      byteLimit: after.total * 2,
    }).blocked, false);
    assert.equal(evaluateHistoryCapacity({ allocated_bytes: after.total * 0.5 }, {
      byteLimit: after.total, wasBlocked: true,
    }).blocked, false, 'recovery below the 80% low-water mark clears the fuse');
  } finally { await database.close(); }
});
