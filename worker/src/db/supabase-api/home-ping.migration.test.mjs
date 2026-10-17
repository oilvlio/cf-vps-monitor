import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

async function seed(database) {
  await database.exec(`
    insert into clients (uuid, name) values ('c1', 'node-1'), ('c2', 'node-2');
    insert into ping_tasks (id, name, clients, all_clients, type, target, interval_sec)
    values (1, '电信', '["c1"]'::jsonb, 0, 'icmp', '1.1.1.1', 60),
           (2, '全局', '[]'::jsonb, 1, 'icmp', '8.8.8.8', 60);
  `);
}

test('home ping assignment is validated, listed and cascades', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);

    // 任务 1 只应用到 c1：c2 不能选它，全局任务 2 两边都能选。
    await assert.rejects(() => rpc(database, 'cfm_set_home_ping_task', { input_client: 'c2', input_task_id: 1 }), /task_not_applicable/);
    await assert.rejects(() => rpc(database, 'cfm_set_home_ping_task', { input_client: 'nope', input_task_id: 2 }), /client_not_found/);
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c1', input_task_id: 1 });
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c2', input_task_id: 2 });
    assert.deepEqual(await rpc(database, 'cfm_home_ping_assignments'), { c1: 1, c2: 2 });

    // 一个节点只有一个首页探测点：再设一次是替换，不是追加。
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c1', input_task_id: 2 });
    assert.deepEqual(await rpc(database, 'cfm_home_ping_assignments'), { c1: 2, c2: 2 });

    // 任务被改成不再作用于该节点后，不再返回这条选择。
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c1', input_task_id: 1 });
    await database.exec(`update ping_tasks set clients = '["c2"]'::jsonb where id = 1`);
    assert.deepEqual(await rpc(database, 'cfm_home_ping_assignments'), { c2: 2 });

    // null 取消；删除任务 / 节点时级联清理。
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c2', input_task_id: null });
    assert.deepEqual(await rpc(database, 'cfm_home_ping_assignments'), {});
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c2', input_task_id: 2 });
    await database.exec(`delete from ping_tasks where id = 2`);
    const remaining = await database.query(`select client from client_home_ping where client = 'c2'`);
    assert.equal(remaining.rows.length, 0, 'deleting the task cascades to the assignment');

    await database.exec(`delete from clients where uuid = 'c1'`);
    const orphaned = await database.query(`select client from client_home_ping where client = 'c1'`);
    assert.equal(orphaned.rows.length, 0, 'deleting the client cascades to the assignment');
  } finally {
    await database.close();
  }
});

test('cfm_home_ping_rows returns only the assigned task, oldest first', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);
    await rpc(database, 'cfm_set_home_ping_task', { input_client: 'c1', input_task_id: 1 });
    await database.exec(`
      insert into ping_snapshots (client, time, values_json) values
        ('c1', '2026-10-14T11:00:00Z', '{"1": 50, "2": 10}'::jsonb),
        ('c1', '2026-10-14T11:30:00Z', '{"1": -1, "2": 10}'::jsonb),
        ('c1', '2026-10-14T11:45:00Z', '{"2": 10}'::jsonb),
        ('c2', '2026-10-14T11:30:00Z', '{"1": 77}'::jsonb);
    `);
    const rows = await rpc(database, 'cfm_home_ping_rows', {
      input_start: '2026-10-14T10:00:00Z',
      input_end: '2026-10-14T12:00:00Z',
    });
    assert.deepEqual(Object.keys(rows), ['c1']);
    assert.equal(rows.c1.task_id, 1);
    assert.equal(rows.c1.name, '电信');
    assert.deepEqual(rows.c1.rows.map((r) => r.value), [50, -1]);
  } finally {
    await database.close();
  }
});
