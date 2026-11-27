import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigration,
  createRealPostgresDatabase,
  ensureHistoryFixturePartitions,
  hasRealPostgres,
  rpc,
} from '../../../scripts/test-support/real-postgres.mjs';

/**
 * 真实 Postgres 并发/生命周期测试。
 *
 * 本地没有 DATABASE_URL 时整组 skip；CI 用 postgres:16 服务运行。
 * Phase 0 覆盖“测试夹具 + 现有锁行为”，Phase 1 再补 v2 的
 * cfm_partition_maintain / cfm_build_rollup 并发与时序用例。
 */

const skip = hasRealPostgres() ? false : 'DATABASE_URL is not set';

test('concurrent node assignments preserve both memberships and timeout overrides', { skip, timeout: 30000 }, async () => {
  const db = await createRealPostgresDatabase();
  const first = await db.connect();
  const second = await db.connect();
  try {
    await db.query(`insert into clients(uuid) values ('a'),('b');
      insert into ping_tasks(id,name,target) values (1,'shared','example.com');`);
    const args = client => ({ input_client: client, input_desired: [1], input_base: [],
      input_timeouts: [{ task_id: 1, timeout_ms: client === 'a' ? 1000 : 2000 }] });
    await first.query('begin');
    assert.equal((await rpc(first, 'cfm_set_client_ping_assignment', args('a'))).ok, true);
    const pid = (await second.query('select pg_backend_pid()')).rows[0].pg_backend_pid;
    const waiting = rpc(second, 'cfm_set_client_ping_assignment', args('b'));
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await db.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (activity.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
      }
      assert.equal(blocked, true, 'the second transaction waits for the current task row');
    } finally {
      await first.query('commit');
    }
    assert.equal((await waiting).ok, true);
    assert.deepEqual((await db.query('select clients from ping_tasks where id=1')).rows[0].clients.sort(), ['a', 'b']);
    assert.deepEqual((await db.query('select client,timeout_ms from ping_task_client_timeouts order by client')).rows,
      [{ client: 'a', timeout_ms: 1000 }, { client: 'b', timeout_ms: 2000 }]);
  } finally {
    await first.query('rollback').catch(() => {});
    await db.close();
  }
});

async function createHistoryPostgresDatabase(options) {
  const database = await createRealPostgresDatabase(options);
  if (options?.migrate !== false) {
    await ensureHistoryFixturePartitions(database, ['2026-09-01T00:00:00Z']);
  }
  return database;
}

async function seedHistory(database) {
  await database.query(`
    insert into clients (uuid, name) values ('pg-node', 'PG node');
    insert into ping_tasks (id, name, target, clients) values (1, 'probe', 'example.com', '["pg-node"]');
    insert into ping_snapshots (client, time, values_json) values
      ('pg-node', '2026-09-01T00:00:00Z', '{"1":10}'),
      ('pg-node', '2026-09-01T00:05:00Z', '{"1":20}');
  `);
}

test('real Postgres migrations create the history layout', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  try {
    const tables = await database.query(`
      select tablename from pg_tables
      where schemaname = 'public'
        and tablename in ('records', 'ping_snapshots', 'ping_rollup')
      order by tablename
    `);
    assert.deepEqual(
      tables.rows.map(row => row.tablename),
      ['ping_rollup', 'ping_snapshots', 'records'],
    );
  } finally {
    await database.close();
  }
});

test('concurrent partition maintenance is serialized by the advisory lock', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const holder = await database.connect();
  try {
    // v2 maintenance uses one advisory lock key. While another session holds it,
    // cfm_partition_maintain reports itself as locked instead of waiting or
    // building duplicate partitions.
    await holder.query('begin');
    await holder.query("select pg_advisory_xact_lock(hashtext('cfm_partition_maintain'))");

    const blocked = await rpc(database.client, 'cfm_partition_maintain', { input_now: new Date().toISOString() });
    assert.equal(blocked.locked, true, 'a held advisory lock short-circuits maintenance');
    assert.equal(blocked.created, 0);

    await holder.query('rollback');

    const unblocked = await rpc(database.client, 'cfm_partition_maintain', { input_now: new Date().toISOString() });
    assert.equal(unblocked.locked, false, 'lock release lets the next maintenance run');
    assert.equal(typeof unblocked.created, 'number');
  } finally {
    await holder.query('rollback').catch(() => {});
    await holder.end().catch(() => {});
    await database.close();
  }
});

test('pruning a locked partition reports pending instead of throwing', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const locker = await database.connect();
  try {
    const partition = await database.query(`
      select pc.relname
      from cfm_internal.partition_children('public.ping_snapshots'::regclass) pc
      where pc.range_start is not null and pc.range_end is not null
      order by pc.range_end
      limit 1
    `);
    assert.ok(partition.rows.length > 0, 'a dated Ping partition must exist after migrations');

    // Whole-partition drops are gated by the rollup watermark, so push it past
    // the future cutoff before taking the table lock.
    const cutoff = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    await database.query(`
      insert into cfm_internal.rollup_state(family, watermark) values ('ping', $1)
      on conflict (family) do update set watermark = excluded.watermark
    `, [cutoff]);

    await locker.query('begin');
    await locker.query(`lock table public.${partition.rows[0].relname} in access exclusive mode`);

    const result = await rpc(database.client, 'cfm_partition_maintain', { input_now: cutoff });
    assert.ok(result.pending > 0, 'the locked partition stays pending');
    assert.equal(result.locked, false, 'the maintenance lock itself was free');
  } finally {
    await locker.query('rollback').catch(() => {});
    await locker.end().catch(() => {});
    await database.close();
  }
});

test('task delete and rollup build settle without a foreign-key race', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const deleter = await database.connect();
  try {
    await seedHistory(database);

    const results = await Promise.allSettled([
      rpc(database.client, 'cfm_build_rollup', {
        input_family: 'ping',
        input_now: '2026-09-01T01:00:00Z',
        input_max_buckets: 48,
      }),
      rpc(deleter, 'cfm_delete_ping_task', { input_id: 1 }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        assert.fail(`concurrent task delete/build must not fail: ${result.reason?.message ?? result.reason}`);
      }
    }

    // 无外键后也必须自己清理：任务删除与构建并发时不能留下孤儿 rollup 行。
    const orphans = await database.query(`
      select count(*)::integer as count
      from ping_rollup r
      where not exists (select 1 from ping_tasks t where t.id = r.task_id)
    `);
    assert.equal(orphans.rows[0].count, 0);
  } finally {
    await deleter.end().catch(() => {});
    await database.close();
  }
});

async function waitForLockWait(database, fragment) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiters = await database.query(`
      select count(*)::integer as count
      from pg_stat_activity
      where wait_event_type = 'Lock' and query like $1
    `, [`%${fragment}%`]);
    if (waiters.rows[0].count > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`no session waited on a lock for ${fragment}`);
}

test('client delete waits for an in-flight rollup and leaves no orphan rows', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const rollup = await database.connect();
  const deleter = await database.connect();
  try {
    await database.query(`
      insert into clients (uuid, name) values ('race-node', 'Race node');
      insert into ping_tasks (id, name, target, clients)
        values (41, 'race-probe', 'example.com', '["race-node"]');
    `);

    // The rollup session holds the same KEY SHARE lock rollup_range takes while
    // selecting the client and task, then commits the rollup rows it built.
    await rollup.query('begin');
    await rollup.query(`
      select 1 from public.clients c
      join public.ping_tasks t on t.clients ? c.uuid
      where c.uuid = 'race-node' and t.id = 41
      for key share of t, c
    `);

    const pendingDelete = rpc(deleter, 'cfm_delete_clients', { input_uuids: ['race-node'] });
    await waitForLockWait(database, 'cfm_delete_clients');

    await rollup.query(`
      insert into public.host_rollup(client, bucket_start, sample_count, first_time, last_time)
      values ('race-node', date_bin(interval '30 minutes', now(), timestamptz '1970-01-01'), 1, now(), now())
    `);
    await rollup.query(`
      insert into public.ping_rollup(
        client, task_id, bucket_start, sample_count, success_count, loss_count, sum_latency, sumsq_latency
      ) values (
        'race-node', 41, date_bin(interval '30 minutes', now(), timestamptz '1970-01-01'), 1, 1, 0, 10, 100
      )
    `);
    await rollup.query('commit');

    const removed = await pendingDelete;
    assert.equal(removed.removed, 1);

    const orphans = await database.query(`
      select
        (select count(*)::integer from host_rollup h where h.client = 'race-node') as host_rows,
        (select count(*)::integer from ping_rollup r where r.client = 'race-node') as ping_rows,
        (select count(*)::integer from clients c where c.uuid = 'race-node') as client_rows
    `);
    assert.deepEqual(orphans.rows[0], { host_rows: 0, ping_rows: 0, client_rows: 0 },
      'rollup rows committed while the delete was waiting must still be removed');
  } finally {
    await rollup.query('rollback').catch(() => {});
    await rollup.end().catch(() => {});
    await deleter.end().catch(() => {});
    await database.close();
  }
});

async function hostPartitions(database, endBefore) {
  const result = await database.query(`
    select c.relname, pc.range_end
    from cfm_internal.partition_children('public.records'::regclass) pc
    join pg_class c on c.relname = pc.relname
    where pc.range_end is not null and pc.range_end <= $1::timestamptz
    order by pc.range_end
  `, [endBefore]);
  return result.rows;
}

test('v2 partition maintenance backs off when another session holds the lock', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const holder = await database.connect();
  try {
    await holder.query('begin');
    await holder.query("select pg_advisory_xact_lock(hashtext('cfm_partition_maintain'))");

    const blocked = await rpc(database.client, 'cfm_partition_maintain', {
      input_now: '2026-09-01T01:00:00Z',
    });
    assert.equal(blocked.locked, true, 'the second caller must not wait for the lock');
    assert.equal(blocked.created, 0);
    assert.equal(blocked.dropped, 0);
    await holder.query('rollback');

    const unblocked = await rpc(database.client, 'cfm_partition_maintain', {
      input_now: '2026-09-01T01:00:00Z',
    });
    assert.equal(unblocked.locked, false);
    const status = await rpc(database.client, 'cfm_history_maintenance_status');
    assert.equal(status.partition_maintenance.pending_partitions, 0);
    assert.ok(status.partition_maintenance.updated_at);
  } finally {
    await holder.query('rollback').catch(() => {});
    await holder.end().catch(() => {});
    await database.close();
  }
});

test('an expired partition locked by a reader stays pending until the lock clears', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const locker = await database.connect();
  const inputNow = '2026-12-01T00:00:00Z';
  const horizon = '2026-11-24T00:00:00Z';
  try {
    const expired = await hostPartitions(database, horizon);
    assert.ok(expired.length > 0, 'an expired raw partition must exist at this clock');

    // Let the watermark gate pass, so only the table lock can hold the drop.
    await database.query(`
      insert into cfm_internal.rollup_state(family, watermark)
      values ('host', '2026-11-30T00:00:00Z')
      on conflict (family) do update set watermark = excluded.watermark
    `);

    await locker.query('begin');
    await locker.query(`lock table public.${expired[0].relname} in access exclusive mode`);

    const pending = await rpc(database.client, 'cfm_partition_maintain', { input_now: inputNow });
    assert.equal(pending.locked, false);
    assert.ok(pending.pending >= 1, 'a locked expired partition must be reported, not thrown');
    const status = await rpc(database.client, 'cfm_history_maintenance_status');
    assert.ok(status.partition_maintenance.pending_partitions >= 1);
    assert.ok(status.partition_maintenance.lock_timeouts >= 1);
    assert.ok(status.partitions['public.records']);
    assert.ok(status.partitions['public.records'].gate_clearance_seconds !== null);

    const stillThere = await database.query(
      `select to_regclass($1) is not null as present`,
      [`public.${expired[0].relname}`],
    );
    assert.equal(stillThere.rows[0].present, true);

    await locker.query('rollback');

    const recovered = await rpc(database.client, 'cfm_partition_maintain', { input_now: inputNow });
    assert.ok(recovered.dropped >= 1, 'the next run drops the partition after the lock clears');

    const gone = await database.query(
      `select to_regclass($1) is null as dropped`,
      [`public.${expired[0].relname}`],
    );
    assert.equal(gone.rows[0].dropped, true);
  } finally {
    await locker.query('rollback').catch(() => {});
    await locker.end().catch(() => {});
    await database.close();
  }
});

test('a late raw sample re-rolls its bucket end-to-end on Postgres', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  try {
    await database.query(`
      insert into clients (uuid, name) values ('pg-host-node', 'PG host');
      insert into records (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count)
      values
        ('pg-host-node', '2026-09-01T00:05:00Z', 10, 1000, 2000, 10, 100, 200, 5, 2, 50),
        ('pg-host-node', '2026-09-01T00:20:00Z', 20, 2000, 2100, 20, 110, 210, 6, 3, 51);
    `);

    const first = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });
    assert.equal(first.has_more, false);

    let rows = await database.query(`
      select sample_count, sum_cpu, max_cpu
      from host_rollup where client = 'pg-host-node'
    `);
    assert.deepEqual(rows.rows, [{ sample_count: 2, sum_cpu: 30, max_cpu: 20 }]);

    // A delayed sample lands in a bucket that has already been summarised.
    await database.query(`
      insert into records (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count)
      values ('pg-host-node', '2026-09-01T00:15:00Z', 30, 3000, 2200, 30, 120, 220, 7, 4, 52);
      insert into cfm_internal.rollup_dirty(family, client, task_id, bucket_start)
      values ('host', 'pg-host-node', 0, '2026-09-01T00:00:00Z');
    `);

    const second = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T01:30:00Z', input_max_buckets: 48,
    });
    assert.equal(second.dirty, 1);

    rows = await database.query(`
      select sample_count, sum_cpu, max_cpu
      from host_rollup where client = 'pg-host-node'
    `);
    assert.deepEqual(rows.rows, [{ sample_count: 3, sum_cpu: 60, max_cpu: 30 }]);

    const dirty = await database.query(`select count(*)::integer as n from cfm_internal.rollup_dirty`);
    assert.equal(dirty.rows[0].n, 0, 'the dirty queue drains after the re-roll');
  } finally {
    await database.close();
  }
});

test('v2 Ping rollup build and task delete settle without orphans', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  const deleter = await database.connect();
  try {
    await seedHistory(database);

    const results = await Promise.allSettled([
      rpc(database.client, 'cfm_build_rollup', {
        input_family: 'ping',
        input_now: '2026-09-01T01:00:00Z',
        input_max_buckets: 48,
      }),
      rpc(deleter, 'cfm_delete_ping_task', { input_id: 1 }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        assert.fail(`concurrent v2 delete/build must not fail: ${result.reason?.message ?? result.reason}`);
      }
    }

    const orphans = await database.query(`
      select count(*)::integer as count
      from ping_rollup r
      where not exists (select 1 from ping_tasks t where t.id = r.task_id)
    `);
    assert.equal(orphans.rows[0].count, 0);

    const state = await database.query(`
      select count(*)::integer as count from cfm_internal.rollup_state where family = 'ping'
    `);
    assert.equal(state.rows[0].count, 1, 'the watermark row is created once');
  } finally {
    await deleter.end().catch(() => {});
    await database.close();
  }
});

test('v2 settings replay keeps operator values and migrates only the old default', { skip }, async () => {
  // Simulate a pre-v2 install: apply the baseline layout once, then overwrite
  // the settings with legacy values and re-apply the schema migration. This is
  // the order `/db-init` uses during an upgrade (schema first, layout swap later).
  const database = await createHistoryPostgresDatabase({ migrate: false });
  try {
    await applyMigration(database.client, '1_schema');

    // Only the per-family Ping rollup retention exists, host raw is still at the
    // historic 30-day default, and one raw family was configured below the new
    // 48-hour floor.
    await database.query(`
      insert into settings(key, value) values ('ping_rollup_preserve_time', '4320')
      on conflict (key) do update set value = excluded.value;
      delete from settings where key = 'rollup_preserve_time';
      update settings set value = '720' where key = 'record_preserve_time';
      update settings set value = '24' where key = 'ping_record_preserve_time';
      delete from settings where key = 'history_storage_v2_migrated';
    `);

    await applyMigration(database.client, '1_schema');

    const migrated = await database.query(`
      select key, value from settings
      where key in (
        'record_preserve_time', 'ping_record_preserve_time',
        'rollup_preserve_time', 'history_storage_v2_migrated'
      )
      order by key
    `);
    assert.deepEqual(
      migrated.rows,
      [
        { key: 'history_storage_v2_migrated', value: 'true' },
        { key: 'ping_record_preserve_time', value: '48' },
        { key: 'record_preserve_time', value: '168' },
        { key: 'rollup_preserve_time', value: '4320' },
      ],
      'the old Ping value is copied, the 720 default is rewritten, and raw floors at 48h',
    );

    // A later replay must not touch an operator-chosen raw retention.
    await database.query(`update settings set value = '480' where key = 'record_preserve_time'`);
    await applyMigration(database.client, '1_schema');
    const replayed = await database.query(`
      select key, value from settings
      where key in ('record_preserve_time', 'rollup_preserve_time')
      order by key
    `);
    assert.deepEqual(
      replayed.rows,
      [
        { key: 'record_preserve_time', value: '480' },
        { key: 'rollup_preserve_time', value: '4320' },
      ],
    );
  } finally {
    await database.close();
  }
});

// Shared clock helper: choose a recent 30-minute bucket so Ping's late-arrival
// window (168h - 24h = 144h) still accepts it. Bucketing by hand keeps the
// assertions independent of the wall clock minute.
function recentBucket(hoursAgo) {
  const step = 30 * 60 * 1000;
  const bucketMs = Math.floor((Date.now() - hoursAgo * 60 * 60 * 1000) / step) * step;
  return {
    bucketMs,
    bucket: new Date(bucketMs).toISOString(),
    at: (offsetMinutes) => new Date(bucketMs + offsetMinutes * 60 * 1000).toISOString(),
  };
}

test('write-time RPCs enqueue a dirty bucket once the watermark has passed it', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  try {
    await database.query(`
      insert into clients (uuid, name) values ('dirty-node', 'Dirty node');
      insert into ping_tasks (id, name, target, clients)
        values (1, 'probe', 'example.com', '["dirty-node"]');
    `);

    const clock = recentBucket(4);
    // Watermark is one hour after the sample bucket, so the sample is late and
    // the next build would otherwise never look at it again.
    await database.query(`
      insert into cfm_internal.rollup_state(family, watermark) values
        ('host', $1::timestamptz), ('ping', $1::timestamptz)
      on conflict (family) do update set watermark = excluded.watermark
    `, [clock.at(60)]);

    await rpc(database.client, 'cfm_insert_monitor_record', {
      input_record: { client: 'dirty-node', time: clock.at(5), cpu: 12 },
    });
    await rpc(database.client, 'cfm_insert_ping_snapshot', {
      input_client: 'dirty-node',
      input_time: clock.at(5),
      input_results: [{ taskId: 1, value: 30 }],
    });

    const dirty = await database.query(`
      select family, client, task_id, bucket_start
      from cfm_internal.rollup_dirty
      order by family, task_id
    `);
    assert.deepEqual(
      dirty.rows.map(row => ({ ...row, bucket_start: row.bucket_start.toISOString() })),
      [
        { family: 'host', client: 'dirty-node', task_id: 0, bucket_start: clock.bucket },
        { family: 'ping', client: 'dirty-node', task_id: 1, bucket_start: clock.bucket },
      ],
      'each late write queues exactly one bucket for its family',
    );

    // A sample at or after the watermark is covered by the next incremental
    // build, so it must not enqueue a redundant re-roll.
    await rpc(database.client, 'cfm_insert_monitor_record', {
      input_record: { client: 'dirty-node', time: clock.at(125), cpu: 13 },
    });
    const count = await database.query(`select count(*)::integer as n from cfm_internal.rollup_dirty`);
    assert.equal(count.rows[0].n, 2);
  } finally {
    await database.close();
  }
});

test('a late write after a build re-rolls the closed bucket through the RPC path', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  try {
    await database.query(`insert into clients (uuid, name) values ('late-node', 'Late node')`);
    const clock = recentBucket(5);

    await rpc(database.client, 'cfm_insert_monitor_record', {
      input_record: { client: 'late-node', time: clock.at(5), cpu: 10 },
    });
    const first = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host',
      input_now: clock.at(90),
      input_max_buckets: 48,
    });
    assert.equal(first.has_more, false);

    const before = await database.query(
      `select sample_count, sum_cpu from host_rollup where client = 'late-node' and bucket_start = $1::timestamptz`,
      [clock.bucket],
    );
    assert.deepEqual(before.rows, [{ sample_count: 1, sum_cpu: 10 }]);

    // The delayed sample lands in the already-closed bucket. The write RPC (not
    // the test) must enqueue it, because the watermark has moved past the end.
    await rpc(database.client, 'cfm_insert_monitor_record', {
      input_record: { client: 'late-node', time: clock.at(15), cpu: 20 },
    });
    const queued = await database.query(
      `select count(*)::integer as n from cfm_internal.rollup_dirty where family = 'host'`,
    );
    assert.equal(queued.rows[0].n, 1, 'the late write queues its closed bucket');

    const second = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host',
      input_now: clock.at(120),
      input_max_buckets: 48,
    });
    assert.equal(second.dirty, 1, 'the queued bucket is re-rolled');

    const after = await database.query(
      `select sample_count, sum_cpu from host_rollup where client = 'late-node' and bucket_start = $1::timestamptz`,
      [clock.bucket],
    );
    assert.deepEqual(after.rows, [{ sample_count: 2, sum_cpu: 30 }],
      'the whole bucket is replaced with both samples, not appended twice');

    const drained = await database.query(`select count(*)::integer as n from cfm_internal.rollup_dirty`);
    assert.equal(drained.rows[0].n, 0);
  } finally {
    await database.close();
  }
});

test('a six-hour cron gap leaves no hole in the 30-minute rollup', { skip }, async () => {
  const database = await createHistoryPostgresDatabase();
  try {
    await database.query(`insert into clients (uuid, name) values ('gap-node', 'Gap node')`);

    // First run covers only the first bucket.
    await database.query(`
      insert into records (client, time, cpu) values ('gap-node', '2026-09-01T00:05:00Z', 10)
    `);
    const first = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host',
      input_now: '2026-09-01T01:00:00Z',
      input_max_buckets: 48,
    });
    assert.equal(new Date(first.watermark).toISOString(), '2026-09-01T01:00:00.000Z');

    // Six hours pass without a build, while samples keep arriving.
    await database.query(`
      insert into records (client, time, cpu)
      select 'gap-node', timestamptz '2026-09-01T01:05:00Z' + n * interval '30 minutes', 10 + n
      from generate_series(0, 11) n
    `);

    const second = await rpc(database.client, 'cfm_build_rollup', {
      input_family: 'host',
      input_now: '2026-09-01T07:00:00Z',
      input_max_buckets: 48,
    });
    assert.equal(new Date(second.watermark).toISOString(), '2026-09-01T07:00:00.000Z',
      'one run advances across the whole gap');
    assert.equal(second.has_more, false);

    const buckets = await database.query(`
      select bucket_start from host_rollup
      where client = 'gap-node'
      order by bucket_start
    `);
    const expected = await database.query(`
      select timestamptz '2026-09-01T00:00:00Z' as bucket_start
      union all
      select gs
      from generate_series(
        timestamptz '2026-09-01T01:00:00Z',
        timestamptz '2026-09-01T06:30:00Z',
        interval '30 minutes'
      ) gs
      order by 1
    `);
    assert.deepEqual(
      buckets.rows.map(row => row.bucket_start.toISOString()),
      expected.rows.map(row => row.bucket_start.toISOString()),
      'every 30-minute bucket with a sample is present and none are missing',
    );
  } finally {
    await database.close();
  }
});
