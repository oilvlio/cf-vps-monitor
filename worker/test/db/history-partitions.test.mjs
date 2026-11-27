import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('host and Ping histories are daily-partitioned and route new writes to dated children', async () => {
  const database = await createTestDatabase();
  try {
    const parents = await database.query(`
      select c.relname, c.relkind from pg_class c
      where c.oid in (
        'public.records'::regclass,
        'public.ping_snapshots'::regclass,
        'public.host_rollup'::regclass,
        'public.ping_rollup'::regclass
      )
      order by c.relname
    `);
    assert.deepEqual(parents.rows, [
      { relname: 'host_rollup', relkind: 'p' },
      { relname: 'ping_rollup', relkind: 'p' },
      { relname: 'ping_snapshots', relkind: 'p' },
      { relname: 'records', relkind: 'p' },
    ]);

    const retired = await database.query(`
      select to_regclass('public.gpu_snapshots') is null as gpu_raw,
             to_regclass('public.gpu_rollup') is null as gpu_rollup
    `);
    assert.deepEqual(retired.rows[0], { gpu_raw: true, gpu_rollup: true },
      'GPU history tables are not part of the layout');

    // gpu_records / ping_records are dead pre-v2 tables.
    const dead = await database.query(`
      select to_regclass('public.gpu_records') is null as gpu_dropped,
             to_regclass('public.ping_records') is null as ping_dropped
    `);
    assert.deepEqual(dead.rows[0], { gpu_dropped: true, ping_dropped: true });

    const rawChildren = await database.query(`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.records'::regclass
        or i.inhparent = 'public.ping_snapshots'::regclass
    `);
    assert.ok(rawChildren.rows.every(row => !row.relname.includes('_legacy_')),
      'raw fixture has no unbounded MINVALUE child');

    await database.exec(`insert into clients(uuid) values ('partitioned-host');`);
    const future = (await database.query(`select to_char((now() at time zone 'UTC')::date+1,'YYYY-MM-DD') future_day`)).rows[0].future_day;
    for (const table of ['records', 'ping_snapshots']) {
      await database.query(`insert into ${table}(client,time) values ('partitioned-host',$1::timestamptz)`, [`${future}T00:15:00Z`]);
    }
    const routed = await database.query(`
      select tableoid::regclass::text child, count(*)::integer rows from records group by 1
      union all select tableoid::regclass::text, count(*)::integer from ping_snapshots group by 1
    `);
    assert.equal(routed.rows.length, 2);
    for (const row of routed.rows) {
      assert.match(row.child, /_\d{8}$/, `new records land in dated partitions (${row.child})`);
    }

    const bytes = await rpc(database, 'cfm_history_storage_bytes');
    for (const key of ['records', 'ping_snapshots', 'host_rollup', 'ping_rollup', 'total']) {
      assert.equal(typeof bytes[key], 'number', `cfm_history_storage_bytes.${key}`);
    }
    assert.equal(Object.hasOwn(bytes, 'gpu_snapshots'), false);
    assert.equal(Object.hasOwn(bytes, 'gpu_rollup'), false);
  } finally {
    await database.close();
  }
});
