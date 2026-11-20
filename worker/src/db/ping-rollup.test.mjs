import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('30-minute Ping rollup matches raw buckets and merges exact additive statistics', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients (uuid, name) values ('rollup-node', 'Rollup');
      insert into ping_tasks (id, name, target, clients) values (1, 'probe', 'example.com', '["rollup-node"]');
      insert into ping_snapshots (client,time,values_json) values
        ('rollup-node','2026-09-01T00:00:00Z','{"1":10}'),
        ('rollup-node','2026-09-01T00:05:00Z','{"1":20}'),
        ('rollup-node','2026-09-01T00:10:00Z','{"1":-1}'),
        ('rollup-node','2026-09-01T00:15:00Z','{"1":30}'),
        ('rollup-node','2026-09-01T00:30:00Z','{"1":40}'),
        ('rollup-node','2026-09-01T00:35:00Z','{"1":50}'),
        ('rollup-node','2026-09-01T00:40:00Z','{"1":-1}'),
        ('rollup-node','2026-09-01T00:45:00Z','{"1":60}');
    `);

    const built = await rpc(database, 'cfm_build_ping_rollup', {
      input_before: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });
    assert.equal(built.buckets, 2);
    assert.equal(built.has_more, false);

    const rawHalfHours = await rpc(database, 'cfm_ping_records_for_tasks_range_bucketed', {
      input_client: 'rollup-node', input_task_ids: [1], input_start: '2026-09-01T00:00:00Z',
      input_end: '2026-09-01T01:00:00Z', input_bucket_sec: 1800, input_limit: 1500,
    });
    const rolledHalfHours = await rpc(database, 'cfm_ping_rollup_range', {
      input_client: 'rollup-node', input_task_ids: [1], input_start: '2026-09-01T00:00:00Z',
      input_end: '2026-09-01T01:00:00Z', input_step_sec: 1800, input_limit: 1500,
    });
    assert.deepEqual(rolledHalfHours['1'], rawHalfHours['1']);

    const merged = await rpc(database, 'cfm_ping_rollup_range', {
      input_client: 'rollup-node', input_task_ids: [1], input_start: '2026-09-01T00:00:00Z',
      input_end: '2026-09-01T01:00:00Z', input_step_sec: 3600, input_limit: 1500,
    });
    assert.equal(merged['1'].length, 1);
    assert.equal(merged['1'][0].sample_count, 8);
    assert.equal(merged['1'][0].success_count, 6);
    assert.equal(merged['1'][0].loss_count, 2);
    assert.equal(merged['1'][0].avg_latency, 35);
    assert.equal(merged['1'][0].min_latency, 10);
    assert.equal(merged['1'][0].max_latency, 60);
  } finally {
    await database.close();
  }
});
