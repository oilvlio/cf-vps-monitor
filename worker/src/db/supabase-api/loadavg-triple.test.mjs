import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

// CPU 负载三元组端到端：写入语义（显式 null→null，缺字段→0）与读侧 RPC 列清单。
test('loadavg triple insert keeps explicit nulls and exposes load5/load15 on read RPCs', async () => {
  const sql = await createTestDatabase();
  try {
    await sql.exec("insert into clients(uuid,name) values ('loadavg-triple','Synthetic');");
    const columns = (await sql.query(
      "select column_name from information_schema.columns where table_name = 'records' and column_name in ('load5','load15') order by column_name",
    )).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['load15', 'load5'], 'records 必须有可空的 load5/load15 列');

    await rpc(sql, 'cfm_insert_monitor_record', { input_record: {
      client: 'loadavg-triple', time: '2026-10-01T00:00:00Z', load: 1.25, load5: 0.75, load15: 0.5,
    } });
    await rpc(sql, 'cfm_insert_monitor_record', { input_record: {
      client: 'loadavg-triple', time: '2026-10-01T00:01:00Z', load: null, load5: null, load15: null,
    } });
    // 老探针：不带三元组字段，仍按 0。
    await rpc(sql, 'cfm_insert_monitor_record', { input_record: {
      client: 'loadavg-triple', time: '2026-10-01T00:02:00Z', load: 0.5,
    } });

    const rows = (await sql.query(
      "select load, load5, load15 from records where client='loadavg-triple' order by time",
    )).rows;
    assert.deepEqual(rows.map((row) => row.load), [1.25, null, 0.5]);
    assert.deepEqual(rows.map((row) => row.load5), [0.75, null, 0]);
    assert.deepEqual(rows.map((row) => row.load15), [0.5, null, 0]);

    for (const [name, result] of [
      ['cfm_recent_records', await rpc(sql, 'cfm_recent_records', { input_client: 'loadavg-triple', input_limit: 10 })],
      ['cfm_records_range', await rpc(sql, 'cfm_records_range', {
        input_client: 'loadavg-triple', input_start: '2026-10-01T00:00:00Z', input_end: '2026-10-01T00:03:00Z',
      })],
      ['cfm_records_range_limited', await rpc(sql, 'cfm_records_range_limited', {
        input_client: 'loadavg-triple', input_start: '2026-10-01T00:00:00Z', input_end: '2026-10-01T00:03:00Z', input_limit: 10,
      })],
      ['cfm_records_range_bucketed', await rpc(sql, 'cfm_records_range_bucketed', {
        input_client: 'loadavg-triple', input_start: '2026-10-01T00:00:00Z', input_end: '2026-10-01T00:03:00Z',
        input_bucket_sec: 60, input_limit: 10,
      })],
    ]) {
      assert.equal(result.length, 3, `${name} 应返回 3 条`);
      assert.deepEqual(result.map((row) => row.load5), [0.75, null, 0], `${name} load5 透传`);
      assert.deepEqual(result.map((row) => row.load15), [0.5, null, 0], `${name} load15 透传`);
      assert.ok('load5' in result[1] && 'load15' in result[1], `${name} null 键不得被剥离`);
    }

    const paged = await rpc(sql, 'cfm_records_range_paged', {
      input_client: 'loadavg-triple', input_start: '2026-10-01T00:00:00Z', input_end: '2026-10-01T00:03:00Z',
      input_page: 1, input_limit: 10,
    });
    assert.deepEqual(paged.data.map((row) => row.load5), [0.75, null, 0], 'paged load5 透传');
    assert.deepEqual(paged.data.map((row) => row.load15), [0.5, null, 0], 'paged load15 透传');

    const cursor = await rpc(sql, 'cfm_records_range_cursor', {
      input_client: 'loadavg-triple', input_start: '2026-10-01T00:00:00Z', input_end: '2026-10-01T00:03:00Z',
      input_cursor: null, input_limit: 10,
    });
    assert.deepEqual(cursor.data.map((row) => row.load5), [0.75, null, 0], 'cursor load5 透传');
    assert.deepEqual(cursor.data.map((row) => row.load15), [0.5, null, 0], 'cursor load15 透传');
    assert.ok('load5' in cursor.data[1] && 'load15' in cursor.data[1], 'cursor null 键不得被剥离');
  } finally { await sql.close(); }
});
