import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc } from '../../../scripts/test-support/postgres.mjs';

test('Ping snapshots use daily partitions, rollups weekly partitions, and prune drops whole ranges', async () => {
  const database = await createTestDatabase();
  try {
    const parents = await database.query(`
      select c.relname, c.relkind
      from pg_class c where c.oid in ('public.ping_snapshots'::regclass, 'public.ping_rollup'::regclass)
      order by c.relname
    `);
    assert.deepEqual(parents.rows, [
      { relname: 'ping_rollup', relkind: 'p' },
      { relname: 'ping_snapshots', relkind: 'p' },
    ]);

    const indexes = await database.query(`
      select indexrelid::regclass::text index_name, am.amname
      from pg_index i join pg_class idx on idx.oid=i.indexrelid
      join pg_am am on am.oid=idx.relam
      where i.indrelid='public.ping_snapshots'::regclass
    `);
    assert.ok(!indexes.rows.some(index => index.index_name.includes('idx_ping_snapshots_time_brin')));
    assert.ok(!indexes.rows.some(index => index.index_name.includes('idx_ping_snapshots_values_json')), 'the redundant JSON GIN index is removed');
    const weekly = await database.query(`
      select count(*)::integer count
      from pg_inherits i join pg_class c on c.oid=i.inhrelid
      where i.inhparent='public.ping_rollup'::regclass and c.relname ~ '^ping_rollup_[0-9]{8}$'
    `);
    assert.ok(weekly.rows[0].count > 0, 'the rollup runway includes weekly partitions');

    await database.exec(`
      insert into clients(uuid,name) values ('partition-node','Partition');
      insert into ping_tasks(id,name,target,clients) values (7,'probe','example.com','["partition-node"]');
    `);
    const { partition_day } = (await database.query(`
      select to_char((now() at time zone 'UTC')::date - 3,'YYYY-MM-DD') partition_day
    `)).rows[0];
    await ensureHistoryFixturePartitions(database, [`${partition_day}T12:00:00Z`]);
    await database.query(`insert into ping_snapshots(client,time,values_json) values ('partition-node',$1::timestamptz,'{"7":12}')`, [`${partition_day}T12:00:00Z`]);
    await database.query(`
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
      values ('partition-node',7,$1::timestamptz,1,1,0,12,144)
    `, [`${partition_day}T12:00:00Z`]);

    const rawChildren = await database.query(`
      select count(*)::integer count
      from cfm_internal.partition_children('public.ping_snapshots'::regclass)
      where (range_start is null or range_start <= $1::timestamptz)
        and (range_end is null or range_end > $1::timestamptz)
    `, [`${partition_day}T12:00:00Z`]);
    assert.equal(rawChildren.rows[0].count, 1, 'the fixture day is inside a raw partition');

    await database.exec("update settings set value='48' where key='ping_record_preserve_time'");
    // Raw partitions only expire after the rollup watermark clears them plus the
    // two-hour buffer, so seed a watermark past the fixture day first.
    await database.exec(`
      insert into cfm_internal.rollup_state(family, watermark) values ('ping', now())
      on conflict (family) do update set watermark = excluded.watermark
    `);
    const pruned = await rpc(database, 'cfm_partition_maintain', { input_now: new Date().toISOString() });
    assert.ok(pruned.dropped > 0);
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, 0);
    assert.equal((await database.query('select count(*)::integer count from ping_rollup')).rows[0].count, 1,
      'weekly rollups are dropped only when their whole range expires');

    await database.query(`insert into ping_snapshots(client,time,values_json) values ('partition-node',now(),'{"7":13}')`);
    await database.query(`
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
      values ('partition-node',7,now(),1,1,0,13,169)
    `);
    await database.exec(`
      insert into records(client,time) values ('partition-node',now());
    `);

    const beforeOldInsert = (await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count;
    await rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: 'partition-node',
      input_time: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      input_results: [{ taskId: 7, value: 12 }],
    });
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, beforeOldInsert,
      'samples older than the late-arrival window are ignored rather than failing with no partition found');

    await rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: 'partition-node',
      input_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      input_results: [{ taskId: 7, value: 14 }],
    });
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, beforeOldInsert + 1,
      'a recent sample is routed to a dated partition');

  } finally {
    await database.close();
  }
});
