import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('Ping snapshots and rollups use daily partitions and prune expired partitions', async () => {
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
    assert.ok(indexes.rows.some(index => index.index_name.includes('idx_ping_snapshots_time_brin') && index.amname === 'brin'));
    assert.ok(!indexes.rows.some(index => index.index_name.includes('idx_ping_snapshots_values_json')), 'the redundant JSON GIN index is removed');

    await database.exec(`
      insert into clients(uuid,name) values ('partition-node','Partition');
      insert into ping_tasks(id,name,target,clients) values (7,'probe','example.com','["partition-node"]');
    `);
    const { partition_day } = (await database.query(`
      select to_char((now() at time zone 'UTC')::date + 2,'YYYY-MM-DD') partition_day
    `)).rows[0];
    await database.query(`insert into ping_snapshots(client,time,values_json) values ('partition-node',$1::timestamptz,'{"7":12}')`, [`${partition_day}T12:00:00Z`]);
    await database.query(`
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
      values ('partition-node',7,$1::timestamptz,1,1,0,12,144)
    `, [`${partition_day}T12:00:00Z`]);

    const cutoff = new Date(Date.parse(`${partition_day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString();
    const pruned = await rpc(database, 'cfm_prune_ping_time_partitions', {
      input_snapshots_before: cutoff,
      input_rollups_before: cutoff,
    });
    assert.ok(pruned.ping_snapshot_partitions >= 1);
    assert.ok(pruned.ping_rollup_partitions >= 1);
    const names = partition_day.replaceAll('-', '');
    const removed = await database.query(`
      select to_regclass('public.ping_snapshots_p' || $1) is null snapshots_removed,
        to_regclass('public.ping_rollup_p' || $1) is null rollups_removed,
        (select count(*)::integer from ping_snapshots) snapshots_left,
        (select count(*)::integer from ping_rollup) rollups_left
    `, [names]);
    assert.deepEqual(removed.rows[0], {
      snapshots_removed: true, rollups_removed: true, snapshots_left: 0, rollups_left: 0,
    });

    const clearDay = new Date(Date.parse(`${partition_day}T00:00:00Z`) + 3 * 24 * 60 * 60 * 1000).toISOString();
    await database.query(`insert into ping_snapshots(client,time,values_json) values ('partition-node',$1::timestamptz,'{"7":13}')`, [clearDay]);
    await database.query(`
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
      values ('partition-node',7,$1::timestamptz,1,1,0,13,169)
    `, [clearDay]);
    const cleared = await rpc(database, 'cfm_clear_all_records');
    assert.equal(cleared.deleted.ping_snapshots, 1);
    assert.equal(cleared.deleted.ping_rollup, 1);
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, 0);
    assert.equal((await database.query('select count(*)::integer count from ping_rollup')).rows[0].count, 0);

    const migration = await readFile(new URL('../../../supabase/migrations/4_ping_time_partitions.sql', import.meta.url), 'utf8');
    await database.exec(`begin;\n${migration}\ncommit;`);
  } finally {
    await database.close();
  }
});
