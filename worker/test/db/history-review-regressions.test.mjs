import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigration, createRealPostgresDatabase, ensureHistoryFixturePartitions, hasRealPostgres, rpc,
} from '../../../scripts/test-support/real-postgres.mjs';

const skip = hasRealPostgres() ? false : 'DATABASE_URL is not set';

test('Ping cursor and page apply time bounds before pagination and retain legacy defaults', { skip }, async () => {
  const db = await createRealPostgresDatabase();
  try {
    const times = [0, 1, 2, 3, 4].map(i => new Date(Date.now() - (5 - i) * 60_000).toISOString());
    await ensureHistoryFixturePartitions(db, times);
    await db.query(`insert into clients(uuid) values ('node');
      insert into ping_tasks(id,name,target) values (1,'probe','example.com');`);
    for (const [i, time] of times.entries()) {
      await rpc(db.client, 'cfm_insert_ping_snapshot', {
        input_client: 'node', input_time: time, input_results: [{ taskId: '1', value: i + 10 }],
      });
    }
    const bounded = { input_client: 'node', input_task_id: 1, input_start: times[1], input_end: times[3], input_limit: 2 };
    const page1 = await rpc(db.client, 'cfm_ping_records_paged', { ...bounded, input_page: 1 });
    assert.deepEqual(page1.data.map(r => r.value), [12, 13]);
    assert.equal(page1.has_more, true);
    const page2 = await rpc(db.client, 'cfm_ping_records_paged', { ...bounded, input_page: 2 });
    assert.deepEqual(page2.data.map(r => r.value), [11]);
    assert.equal(page2.has_more, false);
    const cursor1 = await rpc(db.client, 'cfm_ping_records_cursor', bounded);
    assert.deepEqual(cursor1.data.map(r => r.value), [12, 13]);
    const cursor2 = await rpc(db.client, 'cfm_ping_records_cursor', { ...bounded, input_cursor: cursor1.next_cursor });
    assert.deepEqual(cursor2.data.map(r => r.value), [11]);
    assert.equal(cursor2.has_more, false);
    const legacy = await rpc(db.client, 'cfm_ping_records_cursor', { input_client: 'node', input_task_id: 1 });
    assert.equal(legacy.data.length, 5);
    const empty = await rpc(db.client, 'cfm_ping_records_paged', { ...bounded, input_start: times[4] });
    assert.deepEqual(empty.data, []);
    // Simulate the legacy overloads still present in an upgraded installation.
    await db.query(`create function public.cfm_ping_records_paged(text,integer,integer,integer)
      returns jsonb language sql as $$ select '{}'::jsonb $$;
      create function public.cfm_ping_records_cursor(text,integer,text,integer)
      returns jsonb language sql as $$ select '{}'::jsonb $$;`);
    await applyMigration(db.client, '2_functions');
    const signatures = await db.query(`select proname,count(*)::integer as count from pg_proc
      where pronamespace='public'::regnamespace and proname in ('cfm_ping_records_paged','cfm_ping_records_cursor')
      group by proname order by proname`);
    assert.deepEqual(signatures.rows, [
      { proname: 'cfm_ping_records_cursor', count: 1 }, { proname: 'cfm_ping_records_paged', count: 1 },
    ]);
    assert.deepEqual((await rpc(db.client, 'cfm_ping_records_paged', { ...bounded, input_page: 2 })).data.map(r => r.value), [11]);
  } finally { await db.close(); }
});

test('Host window reads retained rollups after raw cleanup and keeps unknown metrics null across replay', { skip }, async () => {
  const db = await createRealPostgresDatabase();
  try {
    const now = Date.now();
    const old = new Date(Math.floor((now - 72 * 3_600_000) / 1_800_000) * 1_800_000 + 60_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    await ensureHistoryFixturePartitions(db, [old, recent]);
    await db.query(`insert into clients(uuid,mem_total) values ('node',1024);
      insert into settings(key,value) values ('record_preserve_time','48') on conflict(key) do update set value=excluded.value;`);
    for (const [time, cpu] of [[old, 42], [recent, 19]]) {
      await rpc(db.client, 'cfm_insert_monitor_record', { input_record: {
        client: 'node', time, cpu, ram: 512, ram_total: 1024, load: null, load5: null, load15: null,
        disk: null, disk_total: null, uptime: null,
      } });
    }
    assert.deepEqual((await db.query('select disk,disk_total,uptime from records order by time')).rows,
      [{ disk: null, disk_total: null, uptime: null }, { disk: null, disk_total: null, uptime: null }]);
    await rpc(db.client, 'cfm_build_rollup', { input_family: 'host', input_now: new Date(now).toISOString(), input_max_buckets: 48 });
    await db.query('delete from records where time=$1', [old]);
    await applyMigration(db.client, '1_schema');
    await applyMigration(db.client, '2_functions');
    const args = { input_client: 'node', input_start: new Date(now - 7 * 86_400_000).toISOString(),
      input_end: new Date(now).toISOString(), input_bucket_sec: 900, input_limit: 1200 };
    const window = await rpc(db.client, 'cfm_records_range_bucketed', args);
    assert.deepEqual(window.map(r => r.cpu), [42, 19]);
    assert.deepEqual(window.map(r => [r.disk, r.disk_total, r.uptime]), [[null, null, null], [null, null, null]]);
    assert.equal(window[0].ram_total, 1024);
    const aggregate = await rpc(db.client, 'cfm_records_range_aggregated', args);
    assert.equal(aggregate.length, 2);
    assert.ok(aggregate.every(r => r.disk_used === null), 'unknown disk never becomes zero in aggregates');
    await db.query('update host_rollup set last_record=null,disk_samples=null');
    const legacy = await rpc(db.client, 'cfm_records_range_bucketed', args);
    assert.equal(legacy[0].cpu, 42, 'rollups created before the upgrade remain readable');
    assert.equal(legacy[0].load, null);
    assert.equal(legacy[0].disk, null);
    assert.equal(legacy[0].uptime, null);
    const alerts = await rpc(db.client, 'cfm_load_metric_window_stats', {
      input_clients: ['node'], input_start: args.input_start, input_end: args.input_end,
      input_metric: 'disk', input_threshold: 10,
    });
    assert.ok(alerts.every(row => row.samples === 0), 'unknown disk cannot count as an idle alert sample');
  } finally { await db.close(); }
});

test('Host window point budget covers dense samples across both edges without paging', { skip }, async () => {
  const db = await createRealPostgresDatabase();
  try {
    const endMs = Math.floor(Date.now() / 60_000) * 60_000;
    const startMs = endMs - 24 * 3_600_000;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    await ensureHistoryFixturePartitions(db, [start, end]);
    await db.query("insert into clients(uuid) values ('dense')");
    await db.query(`insert into records(client,time,cpu)
      select 'dense', time, case when time=$1::timestamptz then 11 when time=$2::timestamptz then 99 else 42 end
      from generate_series($1::timestamptz,$2::timestamptz,interval '3 seconds') time`, [start, end]);
    const limit = 720;
    const rows = await rpc(db.client, 'cfm_records_range_bucketed', {
      input_client: 'dense', input_start: start, input_end: end,
      input_bucket_sec: Math.ceil((endMs - startMs) / 1000 / (limit - 1)), input_limit: limit,
    });
    assert.ok(rows.length <= limit);
    assert.ok(Date.parse(rows[0].time) - startMs < 121_000, 'old edge remains in the bounded response');
    assert.equal(Date.parse(rows.at(-1).time), endMs);
    assert.equal(rows.at(-1).cpu, 99);
  } finally { await db.close(); }
});
