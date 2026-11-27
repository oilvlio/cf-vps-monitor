import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc } from '../../scripts/test-support/postgres.mjs';
import { loadTypeScriptFunctions } from '../../scripts/test-support/typescript.mjs';
import { ScheduledBudget, ScheduledBudgetExceeded } from '../src/utils/scheduled-budget.ts';

test('R-D06 the daily cleanup gate runs audit deletion before stamping completion', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.match(source, /const RECORD_CLEANUP_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(source, /const RECORD_CLEANUP_LAST_RUN_KEY = 'maintenance_last_cleanup_at';/);
  assert.match(source, /now\.getTime\(\) - lastCleanupAt < RECORD_CLEANUP_INTERVAL_MS/);

  const cleanupStart = source.indexOf('async function runRecordCleanup');
  const lastRunRead = source.indexOf('Date.parse(settings[RECORD_CLEANUP_LAST_RUN_KEY]', cleanupStart);
  const auditDelete = source.indexOf('db.deleteOldAuditLogs', cleanupStart);
  const lastRunWrite = source.indexOf('db.setSetting(context.database, RECORD_CLEANUP_LAST_RUN_KEY', cleanupStart);
  const deletedRows = source.indexOf('const deletedRows = Object.values(deleted)', cleanupStart);

  assert.ok(cleanupStart > 0);
  assert.ok(lastRunRead > cleanupStart);
  assert.ok(auditDelete > lastRunRead);
  assert.ok(lastRunWrite > auditDelete);
  assert.ok(deletedRows > lastRunWrite);
});

async function cleanupHarness(database) {
  let maintenanceCalls = 0;
  const { runRecordCleanup } = await loadTypeScriptFunctions(new URL('../src/index.ts', import.meta.url), ['runRecordCleanup'], {
    RECORD_CLEANUP_LAST_RUN_KEY: 'maintenance_last_cleanup_at', RECORD_CLEANUP_INTERVAL_MS: 86_400_000,
    db: {
      buildRollup: async () => ({}),
      maintainHistory: async (_connection, now) => {
        maintenanceCalls += 1;
        return rpc(database, 'cfm_partition_maintain', { input_now: now });
      },
      deleteOldAuditLogs: (_connection, before, options = {}) => rpc(database, 'cfm_delete_old_audit_logs', {
        input_before_time: before, input_max_batches: options.maxBatches,
      }),
      cleanupNotificationDeliveryState: (_connection, now, options = {}) => rpc(database, 'cfm_cleanup_notification_delivery_state', {
        input_now: now, input_batch_size: options.batchSize, input_max_batches: options.maxBatches,
      }),
      setSetting: (_connection, key, value) => rpc(database, 'cfm_set_settings', { input_settings: { [key]: value } }),
      insertAuditLog: (_connection, user, action, detail) => rpc(database, 'cfm_insert_audit_log', {
        input_user: user, input_action: action, input_detail: detail,
      }),
    },
  });
  return {
    run: now => runRecordCleanup({ database: {}, getSettings: () => rpc(database, 'cfm_public_settings') }, now),
    calls: () => maintenanceCalls,
  };
}

test('AUD-07 a full cleanup batch continues next Cron before recording completion', async () => {
  const database = await createTestDatabase();
  try {
    // v2 raw history expires by whole partition, so the only bounded batch
    // family left is audit_logs. Keep the continuation contract covered there.
    await database.exec(`insert into settings (key, value) values ('record_preserve_time', '72'), ('ping_record_preserve_time', '72'), ('audit_log_preserve_time', '72') on conflict (key) do update set value = excluded.value;`);
    await database.exec(`
      insert into audit_logs (time) select '2026-09-01T00:00:00Z'::timestamptz - n * interval '1 second'
        from generate_series(1,36000) n;
      insert into audit_logs (time) values ('2026-09-06T00:00:00Z');
    `);
    const oldRows = () => database.query(
      "select count(*)::integer as count from audit_logs where time < '2026-09-03T00:00:00Z'::timestamptz",
    ).then(result => result.rows[0].count);
    const cleanup = await cleanupHarness(database);
    await cleanup.run(new Date('2026-09-06T00:00:00Z'));
    assert.equal(await oldRows(), 16000);
    assert.equal((await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at, undefined,
      'unfinished cleanup must not be stamped completed for the next 24 hours');
    await cleanup.run(new Date('2026-09-06T00:02:00Z'));
    assert.equal(cleanup.calls(), 2);
    assert.equal(await oldRows(), 0);
    assert.equal((await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at, '2026-09-06T00:02:00.000Z');
    await cleanup.run(new Date('2026-09-06T00:04:00Z'));
    assert.equal(cleanup.calls(), 2, 'drained cleanup keeps its low-frequency idle schedule');
  } finally {
    await database.close();
  }
});

test('AUD-07 expired raw partitions are dropped whole instead of accumulating rows', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`insert into settings (key, value) values ('record_preserve_time', '48') on conflict (key) do update set value = excluded.value;`);
    await database.exec("insert into clients (uuid) select 'node-' || n from generate_series(1,50) n;");
    const day = (await database.query("select date_trunc('day', now()) as d")).rows[0].d;
    // One full day of 50 nodes at 120-second intervals: 36,000 samples in
    // today's dated partition (the MINVALUE guard is never dropped).
    await database.query(`
      insert into records (client,time)
      select 'node-' || ((n-1) % 50 + 1), $1::timestamptz + ((n-1) / 50) * interval '120 seconds'
      from generate_series(1,36000) n
    `, [new Date(day).toISOString()]);
    assert.equal((await database.query('select count(*)::integer as count from records')).rows[0].count, 36000);

    // Cron three days later. Raw may only be dropped after the rollup watermark
    // has passed the partition, so advance host rollup first.
    const later = new Date(new Date(day).getTime() + 3 * 86_400_000);
    await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: later.toISOString(), input_max_buckets: 96,
    });
    const dropped = await rpc(database, 'cfm_partition_maintain', { input_now: later.toISOString() });
    assert.ok(dropped.dropped >= 1, 'expired raw partition must be dropped once its rollup is durable');
    assert.equal((await database.query('select count(*)::integer as count from records')).rows[0].count, 0);
  } finally {
    await database.close();
  }
});

test('AUD-07 raw history has no row-level backlog; only the heap audit table does', async () => {
  const database = await createTestDatabase();
  try {
    await ensureHistoryFixturePartitions(database, ['2026-01-01T00:00:00Z']);
    await database.exec(`
      insert into clients (uuid) values ('node-a');
      insert into ping_snapshots (client,time) select 'node-a','2026-01-01'::timestamptz + n * interval '1 minute' from generate_series(1,101) n;
      insert into audit_logs (time) select '2026-01-01' from generate_series(1,101);
      update settings set value='48' where key='ping_record_preserve_time';
    `);

    const gated = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-01T00:00:00Z' });
    assert.equal(gated.dropped_by_parent['public.ping_snapshots'] ?? 0, 0,
      'raw partitions wait for the rollup watermark');
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, 101,
      'no row-level DELETE runs against raw history');

    await database.exec(`insert into cfm_internal.rollup_state(family, watermark) values ('ping','2026-01-03T00:00:00Z') on conflict (family) do update set watermark = excluded.watermark`);
    const dropped = await rpc(database, 'cfm_partition_maintain', { input_now: '2026-09-01T00:00:00Z' });
    assert.equal(dropped.dropped_by_parent['public.ping_snapshots'], 1);
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, 0);

    const auditCleanup = { input_before_time: '2026-09-01', input_max_batches: 1 };
    assert.equal((await rpc(database, 'cfm_delete_old_audit_logs', auditCleanup)).has_more, true,
      'heap history still reports bounded row-delete backlog');
    assert.equal((await rpc(database, 'cfm_delete_old_audit_logs', auditCleanup)).has_more, false);
  } finally {
    await database.close();
  }
});

async function fixture(t) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const calls = [];
  const transport = (name, args) => { calls.push(name); return rpc(database, name, args); };
  const history = name => (_db, before) => transport(name, { input_before_time: before });
  const { runRecordCleanup } = await loadTypeScriptFunctions(new URL('../src/index.ts', import.meta.url), ['runRecordCleanup'], {
    RECORD_CLEANUP_LAST_RUN_KEY: 'maintenance_last_cleanup_at', RECORD_CLEANUP_INTERVAL_MS: 86400000,
    db: {
      buildRollup: async () => ({}),
      maintainHistory: async () => ({ created: 0, dropped: 0, dropped_by_parent: {}, pending: 0, skipped: 0, locked: false }),
      deleteOldAuditLogs: history('cfm_delete_old_audit_logs'),
      cleanupNotificationDeliveryState: (_db, now, options = {}) => transport('cfm_cleanup_notification_delivery_state', {
        input_now: now, input_batch_size: options.batchSize, input_max_batches: options.maxBatches,
      }),
      setSetting: (_db, key, value) => transport('cfm_set_settings', { input_settings: { [key]: value } }),
      insertAuditLog: (_db, user, action, detail) => transport('cfm_insert_audit_log', { input_user: user, input_action: action, input_detail: detail }),
    },
  });
  const run = (now, budget) => runRecordCleanup({ database: {}, budget, getSettings: () => rpc(database, 'cfm_public_settings') }, new Date(now));
  const count = async () => (await database.query('select count(*)::int as n from cfm_internal.notification_delivery_state')).rows[0].n;
  const completion = async () => (await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at;
  return { database, calls, run, count, completion };
}

test('R-D06 orphan delivery cleanup continues bounded batches before the daily completion stamp', async t => {
  const f = await fixture(t);
  await f.database.exec(`insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,updated_at)
    select 'offline:orphan-'||n,'synthetic-old-event','failed',1,'2026-01-01','2026-01-01' from generate_series(1,1001) n`);
  await f.run('2026-09-09T00:00:00Z');
  assert.equal(await f.count(), 1, 'One bounded 1000-row batch leaves the remaining orphan for continuation');
  assert.equal(await f.completion(), undefined, 'Do not skip the remaining ledger backlog for the next day');
  await f.run('2026-09-09T00:02:00Z');
  assert.equal(await f.count(), 0);
  assert.equal(await f.completion(), '2026-09-09T00:02:00.000Z');
  const calls = f.calls.length;
  await f.run('2026-09-09T00:04:00Z');
  assert.equal(f.calls.length, calls, 'Drained cleanup returns to the low-frequency schedule');
});

test('R-D06 a live orphan lease is retained and drained by the next Cron after expiry', async t => {
  const f = await fixture(t);
  await f.database.exec(`insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,updated_at,claim_token)
    values ('offline:orphan-active','synthetic-sending','pending',1,'2026-09-09T00:01:30Z','2026-09-09T00:00:00Z','synthetic-active-token')`);
  await f.run('2026-09-09T00:00:00Z');
  assert.equal(await f.count(), 1, 'An in-flight provider send cannot lose its lease');
  assert.equal(await f.completion(), undefined, 'A retained retired lease needs near-term continuation');
  await f.run('2026-09-09T00:02:00Z');
  assert.equal(await f.count(), 0);
  assert.equal(await f.completion(), '2026-09-09T00:02:00.000Z');
});

test('R-D06 cleanup without enough scheduled budget defers before starting database work', async t => {
  const f = await fixture(t);
  const budget = new ScheduledBudget({ maxSubrequests: 7, reserveRequests: 0 });
  await assert.rejects(f.run('2026-09-09T00:00:00Z', budget), ScheduledBudgetExceeded);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.completion(), undefined);
});
