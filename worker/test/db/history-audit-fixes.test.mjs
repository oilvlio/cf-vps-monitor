import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc, applyMigration } from '../../../scripts/test-support/postgres.mjs';
import { createRealPostgresDatabase, hasRealPostgres } from '../../../scripts/test-support/real-postgres.mjs';

for (const engine of ['PGlite', 'Postgres']) {
test(`${engine}: rollup failures retain retry state; retention changes preserve data; raw percentiles stay exact`, { skip: engine === 'Postgres' && !hasRealPostgres() }, async t => {
  const db = engine === 'Postgres' ? await createRealPostgresDatabase() : await createTestDatabase();
  if (engine === 'Postgres') db.exec = sql => db.query(sql);
  t.after(() => db.close());
  const now = Date.now();
  const old = Math.floor((now - 60 * 3600_000) / 1800_000) * 1800_000;
  const recent = now - 600_000;
  await ensureHistoryFixturePartitions(db, [old, recent].map(x => new Date(x).toISOString()));
  await db.exec("insert into clients(uuid) values ('audit'); insert into ping_tasks(id,name,target) values (1,'audit','example.com');");
  for (const [i, value] of [1, 2, 100].entries()) {
    await rpc(db, 'cfm_insert_ping_snapshot', { input_client: 'audit', input_time: new Date(recent + i * 60_000).toISOString(), input_results: [{ taskId: '1', value }] });
  }
  const range = { input_client: 'audit', input_task_ids: [1], input_start: new Date(now - 3600_000).toISOString(), input_end: new Date(now).toISOString() };
  const stats = await rpc(db, 'cfm_ping_stats_from_rollup', range);
  assert.equal(stats['1'].p50_latency, 2);
  assert.equal(stats['1'].p75_latency, 51);
  await rpc(db, 'cfm_ping_rollup_range', { input_client: 'audit', input_task_ids: [1], input_start: range.input_start });
  await rpc(db, 'cfm_ping_rollup_range', { input_client: 'audit', input_task_ids: [1], input_end: range.input_end });

  await rpc(db, 'cfm_insert_ping_snapshot', { input_client: 'audit', input_time: new Date(old + 60_000).toISOString(), input_results: [{ taskId: '1', value: 42 }] });
  await db.query("select cfm_internal.rollup_range('ping',$1::timestamptz,$2::timestamptz)", [new Date(old).toISOString(), new Date(old + 1800_000).toISOString()]);
  await db.query("delete from ping_snapshots where time < $1", [new Date(old + 1800_000).toISOString()]);
  await db.exec("update settings set value='168' where key='ping_record_preserve_time'");
  const oldRange = { ...range, input_start: new Date(old).toISOString(), input_end: new Date(old + 1800_000).toISOString() };
  const bucketed = await rpc(db, 'cfm_ping_records_for_tasks_range_bucketed', { ...oldRange, input_bucket_sec: 360 });
  const raw = await rpc(db, 'cfm_ping_records_for_tasks_range', oldRange);
  const oldStats = await rpc(db, 'cfm_ping_stats_for_tasks_range', oldRange);
  assert.equal(bucketed['1'][0].value, 42);
  assert.equal(raw['1'][0].value, 42);
  assert.equal(oldStats['1'].samples, 1);

  // Adjacent raw and retained rollup buckets merge once into a larger bucket.
  await rpc(db, 'cfm_insert_ping_snapshot', { input_client: 'audit', input_time: new Date(old + 1860_000).toISOString(), input_results: [{ taskId: '1', value: 58 }] });
  const mixedRange = { ...oldRange, input_end: new Date(old + 3600_000).toISOString() };
  const mixed = await rpc(db, 'cfm_ping_stats_for_tasks_range', mixedRange);
  assert.equal(mixed['1'].samples, 2);
  assert.equal(mixed['1'].avg_latency, 50);
  const coarse = await rpc(db, 'cfm_ping_records_for_tasks_range_bucketed', { ...mixedRange, input_bucket_sec: 86400 });
  assert.equal(coarse['1'].reduce((n, row) => n + row.sample_count, 0), 2);

  await db.query("insert into records(client,time,cpu) values ('audit',$1,10),('audit',$2,30)", [new Date(old + 60_000).toISOString(), new Date(old + 1860_000).toISOString()]);
  await db.query("select cfm_internal.rollup_range('host',$1::timestamptz,$2::timestamptz)", [new Date(old).toISOString(), new Date(old + 3600_000).toISOString()]);
  await db.query("delete from records where time < $1", [new Date(old + 1800_000).toISOString()]);
  await db.exec("update settings set value='168' where key='record_preserve_time'");
  const hostRange = { input_client: 'audit', input_start: mixedRange.input_start, input_end: mixedRange.input_end, input_bucket_sec: 1800 };
  const host = await rpc(db, 'cfm_records_range_aggregated', hostRange);
  assert.equal(host.reduce((n, row) => n + row.samples, 0), 2);
  assert.deepEqual(host.map(row => row.cpu), [10, 30]);
  const hostPoints = await rpc(db, 'cfm_records_range_bucketed', hostRange);
  assert.deepEqual(hostPoints.map(row => row.cpu), [10, 30]);

  const watermark = new Date(old).toISOString();
  await db.query("insert into cfm_internal.rollup_state(family,watermark) values ('ping',$1) on conflict(family) do update set watermark=excluded.watermark", [watermark]);
  await db.query("insert into cfm_internal.rollup_dirty(family,client,task_id,bucket_start) values ('ping','audit',1,$1) on conflict do nothing", [watermark]);
  await db.exec("create or replace function cfm_internal.rollup_bucket(p_family text,p_client text,p_task_id integer,p_bucket_start timestamptz) returns integer language plpgsql as $$ begin raise exception 'injected failure'; end $$; create or replace function cfm_internal.rollup_range(p_family text,p_from timestamptz,p_to timestamptz,p_client text default null,p_task_id integer default null) returns integer language plpgsql as $$ begin raise exception 'injected failure'; end $$;");
  const failed = await rpc(db, 'cfm_build_rollup', { input_family: 'ping', input_now: new Date(now).toISOString(), input_max_buckets: 1 });
  assert.ok(failed.failed_buckets > 0);
  assert.equal(new Date(failed.watermark).getTime(), old);
  assert.equal((await db.query("select count(*)::int n from cfm_internal.rollup_dirty where family='ping'")).rows[0].n, 1);
  await applyMigration(db, '2_functions');
  const recovered = await rpc(db, 'cfm_build_rollup', { input_family: 'ping', input_now: new Date(now).toISOString(), input_max_buckets: 1 });
  assert.equal(recovered.failed_buckets, 0);
  assert.equal(new Date(recovered.watermark).getTime(), old + 1800_000);
  assert.equal((await db.query("select count(*)::int n from cfm_internal.rollup_dirty where family='ping'")).rows[0].n, 0);
});
}
