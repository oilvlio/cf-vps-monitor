import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('Ping snapshots use daily partitions, rollups have weekly partitions, and pruning drops expired ranges', async () => {
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
    const weekly = await database.query("select count(*)::integer count from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.ping_rollup'::regclass and c.relname ~ '^ping_rollup_w[0-9]{8}$'");
    assert.ok(weekly.rows[0].count > 0, 'the rollup runway includes weekly partitions');

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
    assert.ok(pruned.ping_rollup_partitions >= 0);
    assert.equal(pruned.ping_snapshot_partitions > 0, true);
    const names = partition_day.replaceAll('-', '');
    const removed = await database.query(`
      select to_regclass('public.ping_snapshots_p' || $1) is null snapshots_removed,
        to_regclass('public.ping_rollup_p' || $1) is null rollups_removed,
        (select count(*)::integer from ping_snapshots) snapshots_left,
        (select count(*)::integer from ping_rollup) rollups_left
    `, [names]);
    assert.deepEqual(removed.rows[0], {
      snapshots_removed: true, rollups_removed: true, snapshots_left: 0, rollups_left: 1,
    }, 'the weekly rollup retains the row until its complete weekly range expires');
    const clearDay = new Date(Date.parse(`${partition_day}T00:00:00Z`) + 3 * 24 * 60 * 60 * 1000).toISOString();
    await database.query(`insert into ping_snapshots(client,time,values_json) values ('partition-node',$1::timestamptz,'{"7":13}')`, [clearDay]);
    await database.exec(`
      insert into records(client,time) values ('partition-node',now());
      insert into gpu_records(client,time) values ('partition-node',now());
      insert into gpu_snapshots(client,time) values ('partition-node',now());
      insert into ping_records(client,task_id,time,value) values ('partition-node',7,now(),15);
    `);
    await database.query(`
      insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,sum_latency,sumsq_latency)
      values ('partition-node',7,$1::timestamptz,1,1,0,13,169)
    `, [clearDay]);
    await database.exec('set role service_role');
    const cleared = await rpc(database, 'cfm_clear_all_records');
    await database.exec('reset role');
    assert.equal(cleared.deleted.ping_snapshots, 1);
    assert.equal(cleared.deleted.ping_rollup, 2);
    assert.equal(cleared.deleted.records, 1);
    assert.equal(cleared.deleted.gpu_records, 1);
    assert.equal(cleared.deleted.gpu_snapshots, 1);
    assert.equal(cleared.deleted.ping_records, 1);
    await rpc(database, 'cfm_prune_ping_time_partitions', {
      input_snapshots_before: null,
      input_rollups_before: new Date(Date.parse(`${partition_day}T00:00:00Z`) + 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal((await database.query('select count(*)::integer count from ping_rollup')).rows[0].count, 0);
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, 0);
    assert.equal((await database.query('select count(*)::integer count from ping_rollup')).rows[0].count, 0);
    for (const table of ['records','gpu_records','gpu_snapshots','ping_records']) {
      assert.equal((await database.query(`select count(*)::integer count from ${table}`)).rows[0].count, 0, `${table} is truncated too`);
    }

    const legacy = (await database.query(`
      select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid
      where i.inhparent='public.ping_snapshots'::regclass and c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$'
      limit 1
    `)).rows[0]?.relname;
    if (legacy) await database.exec(`drop table public.${legacy}`);
    const beforeOldInsert = (await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count;
    await rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: 'partition-node',
      input_time: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      input_results: [{ taskId: 7, value: 12 }],
    });
    assert.equal((await database.query('select count(*)::integer count from ping_snapshots')).rows[0].count, beforeOldInsert,
      'too-old samples are ignored rather than failing with no partition found');

    const migration = await readFile(new URL('../../../supabase/migrations/4_ping_time_partitions.sql', import.meta.url), 'utf8');
    await database.exec(`begin;\n${migration}\ncommit;`);
    const safetyMigration = await readFile(new URL('../../../supabase/migrations/5_ping_partition_safety.sql', import.meta.url), 'utf8');
    await database.exec(`begin;\n${safetyMigration}\ncommit;`);
    const cleanupMigration = await readFile(new URL('../../../supabase/migrations/6_ping_and_history_cleanup.sql', import.meta.url), 'utf8');
    assert.match(cleanupMigration, /exception when lock_not_available/i, 'a timed-out partition drop is deferred');
    assert.match(cleanupMigration, /set_config\('lock_timeout',previous_lock_timeout,true\)/i, 'the caller timeout is restored');
    await database.exec(`begin;\n${cleanupMigration}\ncommit;`);

    await database.exec("begin; set local lock_timeout='17s';");
    await rpc(database, 'cfm_prune_ping_time_partitions', {
      input_snapshots_before: null,
      input_rollups_before: null,
    });
    assert.equal((await database.query('select current_setting(\'lock_timeout\') value')).rows[0].value, '17s',
      'the partition-prune timeout is restored before returning to callers');
    await database.exec('commit');
  } finally {
    await database.close();
  }
});
