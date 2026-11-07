import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

async function seed(database, count) {
  for (let i = 1; i <= count; i += 1) {
    await rpc(database, 'cfm_create_ping_task', {
      input_task: { name: `task-${i}`, type: 'icmp', target: `1.1.1.${i}`, all_clients: true },
    });
  }
}

async function storedOrder(database) {
  const result = await database.query('select id from ping_tasks order by sort_order asc, id asc');
  return result.rows.map((row) => row.id);
}

// 回归：手动排序保存后又回退成按 id 升序（SELECT DISTINCT 不保序）。
test('cfm_reorder_ping_tasks persists the exact submitted order', async () => {
  const database = await createTestDatabase();
  try {
    for (const count of [4, 12, 30]) {
      await database.exec('truncate ping_tasks restart identity cascade');
      await seed(database, count);
      const ids = Array.from({ length: count }, (_, index) => index + 1);

      // 最后一个拖到最前，第 3 个拖到末尾。
      const desired = [count, ...ids.slice(0, count - 1)].filter((id) => id !== 3).concat(3);
      await rpc(database, 'cfm_reorder_ping_tasks', { input_ids: desired });
      assert.deepEqual(await storedOrder(database), desired, `count=${count}`);

      // 完全倒序。
      const reversed = [...ids].reverse();
      await rpc(database, 'cfm_reorder_ping_tasks', { input_ids: reversed });
      assert.deepEqual(await storedOrder(database), reversed, `count=${count} reversed`);
    }
  } finally {
    await database.close();
  }
});

test('cfm_reorder_ping_tasks keeps first occurrence of duplicates and appends omitted tasks in current order', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database, 6);
    await rpc(database, 'cfm_reorder_ping_tasks', { input_ids: [5, 2, 5, 3, 2] });
    // 5,2,3 在前（去重后保留首次出现的位置），其余未提交的按原有顺序接在后面。
    assert.deepEqual(await storedOrder(database), [5, 2, 3, 1, 4, 6]);
  } finally {
    await database.close();
  }
});
