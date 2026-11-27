import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc } from '../../../scripts/test-support/postgres.mjs';

/**
 * Phase 1 lifecycle gate.
 *
 * Everything here uses an explicit `input_now`; no assertion depends on the
 * wall clock. The harness pins the session timezone to UTC so partition names
 * and returned timestamps are stable across machines.
 */

const CLIENT = 'lifecycle-node';
const T0 = '2026-09-01T00:00:00Z';

async function seedClient(database) {
  await database.exec(`insert into clients (uuid, name) values ('${CLIENT}', 'Lifecycle')`);
}

async function insertRecord(database, time, cpu) {
  await ensureHistoryFixturePartitions(database, [time]);
  await database.exec(
    `insert into records (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count)
     values ('${CLIENT}', '${time}', ${cpu}, 1000, 2000, 10, 100, 200, 5, 2, 50)`,
  );
}

async function hostPartitions(database) {
  const result = await database.query(`
    select c.relname
    from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.host_rollup'::regclass
    order by c.relname
  `);
  return result.rows.map(row => row.relname);
}

test('maintenance builds the runway from a fixed clock and is idempotent', async () => {
  const database = await createTestDatabase();
  try {
    // Start from an empty rollup parent so the fixed clock, not install time,
    // decides the runway.
    for (const name of await hostPartitions(database)) {
      await database.exec(`drop table public."${name}"`);
    }

    const first = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-01T01:00:00Z' });
    assert.equal(first.locked, false);
    assert.ok(first.created > 0, 'host rollup runway must be created');

    const names = await hostPartitions(database);
    assert.ok(names.includes('host_rollup_20260824'), `week of Aug 24 expected, got ${names.join(',')}`);
    assert.ok(names.includes('host_rollup_20260914'), 'two-week runway after the clock');

    const bounds = await database.query(
      `select min_start, max_end from cfm_internal.partition_bounds where parent = 'public.host_rollup'::regclass`,
    );
    assert.equal(bounds.rows.length, 1);
    assert.ok(new Date(bounds.rows[0].max_end) > new Date('2026-09-01T01:00:00Z'));

    const second = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-01T01:00:00Z' });
    assert.equal(second.created, 0, 'a second run inside the same window creates nothing');
  } finally {
    await database.close();
  }
});

test('host rollup stores mergeable 30-minute sufficient statistics', async () => {
  const database = await createTestDatabase();
  try {
    await seedClient(database);
    await ensureHistoryFixturePartitions(database, [T0]);
    await insertRecord(database, '2026-09-01T00:00:00Z', 10);
    await insertRecord(database, '2026-09-01T00:10:00Z', 20);
    await insertRecord(database, '2026-09-01T00:31:00Z', 30);

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });
    assert.equal(built.family, 'host');
    assert.equal(built.has_more, false);

    const rows = await database.query(`
      select bucket_start, sample_count, sum_cpu, min_cpu, max_cpu, sum_ram, max_ram, first_time, last_time
      from host_rollup where client = $1 order by bucket_start
    `, [CLIENT]);
    assert.equal(rows.rows.length, 2, 'empty buckets are not written');

    const [first, second] = rows.rows;
    assert.equal(new Date(first.bucket_start).toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(first.sample_count, 2);
    assert.equal(first.sum_cpu, 30);
    assert.equal(first.min_cpu, 10);
    assert.equal(first.max_cpu, 20);
    assert.equal(Number(first.sum_ram), 2000);
    assert.equal(Number(first.max_ram), 1000);
    assert.equal(new Date(first.first_time).toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(new Date(first.last_time).toISOString(), '2026-09-01T00:10:00.000Z');

    assert.equal(new Date(second.bucket_start).toISOString(), '2026-09-01T00:30:00.000Z');
    assert.equal(second.sample_count, 1);
    assert.equal(second.max_cpu, 30);

    // Re-running does not duplicate rows and keeps the same statistics.
    await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:30:00Z', input_max_buckets: 48,
    });
    const after = await database.query(`select count(*)::integer as n from host_rollup where client = $1`, [CLIENT]);
    assert.equal(after.rows[0].n, 2);
  } finally {
    await database.close();
  }
});

test('the watermark heals a six-hour cron gap without a permanent hole', async () => {
  const database = await createTestDatabase();
  try {
    await seedClient(database);
    await insertRecord(database, '2026-09-01T00:05:00Z', 10);
    await insertRecord(database, '2026-09-01T06:05:00Z', 60);

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T07:00:00Z', input_max_buckets: 48,
    });
    assert.equal(built.has_more, false);
    assert.ok(built.buckets >= 12, 'all closed buckets since the earliest raw row are processed');

    const rows = await database.query(`
      select bucket_start from host_rollup where client = $1 order by bucket_start
    `, [CLIENT]);
    assert.deepEqual(
      rows.rows.map(row => new Date(row.bucket_start).toISOString()),
      ['2026-09-01T00:00:00.000Z', '2026-09-01T06:00:00.000Z'],
    );

    // A late sample arrives for a gap bucket that was already crossed.
    await insertRecord(database, '2026-09-01T03:05:00Z', 30);
    await database.exec(`
      insert into cfm_internal.rollup_dirty(family, client, task_id, bucket_start)
      values ('host', '${CLIENT}', 0, '2026-09-01T03:00:00Z')
    `);

    const late = await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T07:30:00Z', input_max_buckets: 48,
    });
    assert.equal(late.dirty, 1);

    const caught = await database.query(`
      select bucket_start, sample_count, max_cpu from host_rollup
      where client = $1 and bucket_start = '2026-09-01T03:00:00Z'
    `, [CLIENT]);
    assert.equal(caught.rows.length, 1);
    assert.equal(caught.rows[0].sample_count, 1);
    assert.equal(caught.rows[0].max_cpu, 30);
  } finally {
    await database.close();
  }
});

test('raw partitions drop only after the rollup watermark gate', async () => {
  const database = await createTestDatabase();
  try {
    await seedClient(database);
    await insertRecord(database, T0, 10);

    await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });
    const rollupRows = await database.query(`select count(*)::integer as n from host_rollup where client = $1`, [CLIENT]);
    assert.equal(rollupRows.rows[0].n, 1);

    const oldPartition = 'records_20260901';

    // Retention is 168h, so input_now - 168h is past the legacy upper bound.
    // The host watermark is still Sep 1, which must block the drop.
    await rpc(database, 'cfm_partition_maintain', { input_now: '2026-12-01T00:00:00Z' });
    const stillThere = await database.query(`select to_regclass($1) is not null as present`, [`public.${oldPartition}`]);
    assert.equal(stillThere.rows[0].present, true, 'expired raw partition waits for the watermark');

    await database.exec(`
      insert into cfm_internal.rollup_state(family, watermark) values ('host', '2026-11-25T00:00:00Z')
      on conflict (family) do update set watermark = excluded.watermark
    `);
    const pruned = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-12-01T00:00:00Z' });
    assert.ok(pruned.dropped > 0, 'watermark gate lets the expired partition go');

    const gone = await database.query(`select to_regclass($1) is null as dropped`, [`public.${oldPartition}`]);
    assert.equal(gone.rows[0].dropped, true);

    const survived = await database.query(`select count(*)::integer as n from host_rollup where client = $1`, [CLIENT]);
    assert.equal(survived.rows[0].n, 1, 'rollup survives the raw partition drop');
  } finally {
    await database.close();
  }
});

test('a dirty bucket re-roll replaces the whole bucket instead of accumulating', async () => {
  const database = await createTestDatabase();
  try {
    await seedClient(database);
    await insertRecord(database, '2026-09-01T00:05:00Z', 10);
    await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });

    await insertRecord(database, '2026-09-01T00:15:00Z', 30);
    await database.exec(`
      insert into cfm_internal.rollup_dirty(family, client, task_id, bucket_start)
      values ('host', '${CLIENT}', 0, '2026-09-01T00:00:00Z')
    `);

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:30:00Z', input_max_buckets: 48,
    });
    assert.equal(built.dirty, 1);

    const rows = await database.query(`
      select sample_count, sum_cpu, min_cpu, max_cpu from host_rollup where client = $1
    `, [CLIENT]);
    assert.deepEqual(rows.rows, [{ sample_count: 2, sum_cpu: 40, min_cpu: 10, max_cpu: 30 }]);

    const dirty = await database.query(`select count(*)::integer as n from cfm_internal.rollup_dirty`);
    assert.equal(dirty.rows[0].n, 0);
  } finally {
    await database.close();
  }
});
