import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

// 迁移按「全新安装终态」编写，不再内嵌旧库的幂等修正。这里验证两件事：
// 1) 终态语义下温度（以及任何没带的字段）的「不可用 = null」可以正常写入库；
// 2) 迁移可整体重放（/db-init 重复执行），已写入的历史值原样保留。
test('R-A11 record storage replays migrations and keeps null temp semantics', async () => {
  const sql = await createTestDatabase();
  try {
    await applyApplicationMigrations(sql);
    await sql.exec("insert into clients(uuid, name) values ('temperature-migration', 'Synthetic');");
    for (const [time, temp] of [['2026-09-09T00:01:00Z', null], ['2026-09-09T00:02:00Z', 0]]) {
      await rpc(sql, 'cfm_insert_monitor_record', { input_record: { client: 'temperature-migration', time, cpu: 10, temp } });
    }
    assert.deepEqual((await sql.query("select temp from records where client='temperature-migration' order by time")).rows.map(row => row.temp), [null, 0]);
    await applyApplicationMigrations(sql);
    await sql.exec("insert into records(client,time) values ('temperature-migration','2026-09-09T00:03:00Z')");
    assert.deepEqual((await sql.query("select temp from records where client='temperature-migration' order by time")).rows.map(row => row.temp), [null, 0, null]);
  } finally { await sql.close(); }
});
