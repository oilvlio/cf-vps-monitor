import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('records and GPU histories are time-partitioned and retain bounded cleanup semantics', async () => {
  const database = await createTestDatabase();
  try {
    const parents = await database.query(`
      select c.relname,c.relkind from pg_class c
      where c.oid in ('public.records'::regclass,'public.gpu_records'::regclass,'public.gpu_snapshots'::regclass)
      order by c.relname
    `);
    assert.deepEqual(parents.rows, [
      { relname: 'gpu_records', relkind: 'p' },
      { relname: 'gpu_snapshots', relkind: 'p' },
      { relname: 'records', relkind: 'p' },
    ]);
    await database.exec(`insert into clients(uuid) values ('partitioned-host');`);
    const future = (await database.query(`select to_char((now() at time zone 'UTC')::date+3,'YYYY-MM-DD') future_day`)).rows[0].future_day;
    for (const table of ['records','gpu_records','gpu_snapshots']) {
      await database.query(`insert into ${table}(client,time) values ('partitioned-host',$1::timestamptz)`, [`${future}T00:15:00Z`]);
    }
    const routed = await database.query(`
      select tableoid::regclass::text child,count(*)::integer rows from records group by 1
      union all select tableoid::regclass::text,count(*)::integer from gpu_records group by 1
      union all select tableoid::regclass::text,count(*)::integer from gpu_snapshots group by 1
    `);
    assert.equal(routed.rows.length, 3);
    assert.ok(routed.rows.every(row => /_p\d{8}$/.test(row.child)), 'new records land in date partitions');

    const cleanup = await rpc(database, 'cfm_delete_old_records', {
      input_before_time: `${future}T23:59:59Z`, input_max_batches: 1,
    });
    assert.equal(cleanup.has_more, false);
    for (const table of ['records','gpu_records','gpu_snapshots']) {
      assert.equal((await database.query(`select count(*)::integer count from ${table}`)).rows[0].count, 0);
    }
  } finally {
    await database.close();
  }
});
