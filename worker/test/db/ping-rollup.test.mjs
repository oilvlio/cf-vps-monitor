import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc } from '../../../scripts/test-support/postgres.mjs';

test('30-minute Ping rollup matches raw buckets and merges exact additive statistics', async () => {
  const database = await createTestDatabase();
  try {
    await ensureHistoryFixturePartitions(database, ['2026-09-01T00:00:00Z']);
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

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
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

    await database.exec(`update cfm_internal.rollup_state set watermark='2026-09-01T03:00:00Z' where family='ping'`);
    const completeWindow = await rpc(database, 'cfm_ping_rollup_range', {
      input_client: 'rollup-node', input_task_ids: [1], input_start: '2026-09-01T00:00:00Z',
      input_end: '2026-09-01T01:00:00Z', input_step_sec: 1800, input_limit: 1500,
    });
    assert.deepEqual(completeWindow['1'], rawHalfHours['1'], 'a fully rolled-up window preserves all bucket fields');

    const stats = await rpc(database, 'cfm_ping_stats_from_rollup', {
      input_client: 'rollup-node', input_task_ids: [1], input_start: '2026-09-01T00:00:00Z',
      input_end: '2026-09-01T01:00:00Z',
    });
    assert.equal(stats['1'].samples, 8);
    assert.equal(stats['1'].success_count, 6);
    assert.equal(stats['1'].loss_count, 2);
    assert.equal(stats['1'].avg_latency, 35);
    assert.equal(stats['1'].loss_rate, 25);
    assert.ok(Math.abs(stats['1'].jitter - 18.708286933869708) < 1e-10);
  } finally {
    await database.close();
  }
});

test('Ping rollup skips deleted task keys and malformed values without stalling', async () => {
  const database = await createTestDatabase();
  try {
    await ensureHistoryFixturePartitions(database, ['2026-09-01T00:00:00Z']);
    await database.exec(`
      insert into clients (uuid, name) values ('rollup-orphan-node', 'Rollup orphan');
      insert into ping_tasks (id, name, target, clients) values (1, 'probe', 'example.com', '["rollup-orphan-node"]');
      insert into ping_snapshots (client,time,values_json) values
        ('rollup-orphan-node','2026-09-01T00:05:00Z','{"1":12,"26":99,"not-a-task":88}'),
        ('rollup-orphan-node','2026-09-01T00:10:00Z','{"1":12.5,"26":99}');
    `);

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: '2026-09-01T00:30:00Z', input_max_buckets: 48,
    });
    assert.equal(built.watermark, '2026-09-01T00:30:00+00:00');
    assert.equal(built.has_more, false);

    const rows = await database.query(`select task_id, sample_count from ping_rollup order by task_id`);
    assert.deepEqual(rows.rows, [{ task_id: 1, sample_count: 1 }]);
    const state = await database.query(`select watermark from cfm_internal.rollup_state where family='ping'`);
    assert.equal(state.rows[0].watermark.toISOString(), '2026-09-01T00:30:00.000Z');
  } finally {
    await database.close();
  }
});

test('Ping rollup revisits its two-hour raw buffer and keeps cleanup behind it', async () => {
  const database = await createTestDatabase();
  try {
    await ensureHistoryFixturePartitions(database, ['2026-09-01T00:00:00Z']);
    await database.exec(`
      insert into clients (uuid, name) values ('rollup-late-node', 'Rollup late');
      insert into ping_tasks (id, name, target, clients) values (2, 'probe', 'example.com', '["rollup-late-node"]');
      insert into ping_snapshots (client,time,values_json) values
        ('rollup-late-node','2026-09-01T00:05:00Z','{"2":10}');
    `);
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: '2026-09-01T01:00:00Z' });
    await database.exec(`insert into ping_snapshots (client,time,values_json) values
      ('rollup-late-node','2026-09-01T00:15:00Z','{"2":30}')`);
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: '2026-09-01T01:30:00Z' });

    const row = await database.query(`select sample_count, sum_latency, p50_latency from ping_rollup where client='rollup-late-node' and task_id=2 and bucket_start='2026-09-01T00:00:00Z'`);
    assert.deepEqual(row.rows[0], { sample_count: 2, sum_latency: 40, p50_latency: 20 });

    // Raw Ping history only shrinks by dropping whole partitions, and only after
    // the rollup watermark has passed the partition plus its two-hour buffer.
    await database.exec(`update settings set value='48' where key='ping_record_preserve_time'`);
    const blocked = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-20T00:00:00Z' });
    assert.equal(blocked.dropped_by_parent['public.ping_snapshots'] ?? 0, 0,
      'the watermark gate keeps the partition while the rollup buffer is still open');
    assert.equal((await database.query(`select count(*)::integer count from ping_snapshots where client='rollup-late-node'`)).rows[0].count, 2);

    await database.exec(`update cfm_internal.rollup_state set watermark='2026-09-05T00:00:00Z' where family='ping'`);
    const dropped = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-20T00:00:00Z' });
    assert.equal(dropped.dropped_by_parent['public.ping_snapshots'], 1);
    assert.equal((await database.query(`select count(*)::integer count from ping_snapshots where client='rollup-late-node'`)).rows[0].count, 0);
  } finally {
    await database.close();
  }
});
