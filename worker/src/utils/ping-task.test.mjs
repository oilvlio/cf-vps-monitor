import assert from 'node:assert/strict';

const { validatePingTaskInput } = await import('./ping-task.ts');

const baseTask = {
  name: 'icmp',
  type: 'icmp',
  interval_sec: 120,
  all_clients: true,
};

assert.equal(
  validatePingTaskInput({ ...baseTask, target: 'example.com:80' }).ok,
  false,
);

assert.equal(
  validatePingTaskInput({ ...baseTask, target: 'example.com' }).ok,
  true,
);

assert.equal(
  validatePingTaskInput({ ...baseTask, target: '2606:4700:4700::1111' }).ok,
  true,
);

// 定向任务允许暂不绑定任何服务器
{
  const result = validatePingTaskInput({ ...baseTask, target: 'example.com', all_clients: false, clients: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.task.clients, []);
  assert.equal(result.task.all_clients, false);
}

// 按服务器分配：只应用相对 base 的差量
{
  const { planClientPingAssignment } = await import('./ping-task.ts');
  const task = (id, clients, all_clients = false) => ({ id, name: `t${id}`, type: 'icmp', target: 'x.com', interval_sec: 60, clients, all_clients });
  const tasks = [task(1, ['a']), task(2, ['b']), task(3, []), task(4, [], true)];

  // 勾选 3、取消 1；2 不在 base 中，即使 desired 没有它也不会被动到
  let plan = planClientPingAssignment(tasks, 'a', [3], [1]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.updates, [{ id: 1, clients: [] }, { id: 3, clients: ['a'] }]);

  // 已经在别处加上的分配不会被过期列表移除：1 已含 a、base 里没有 → 不变
  plan = planClientPingAssignment(tasks, 'a', [], []);
  assert.deepEqual(plan, { ok: true, updates: [] });

  // 重复勾选是幂等的
  plan = planClientPingAssignment(tasks, 'a', [1], []);
  assert.deepEqual(plan, { ok: true, updates: [] });

  // 全局任务不能逐台调整
  assert.equal(planClientPingAssignment(tasks, 'a', [4], []).ok, false);
  assert.equal(planClientPingAssignment(tasks, 'a', [], [4]).ok, false);

  // 添加时任务已被删除 → 报错；取消时任务已被删除 → 忽略
  assert.equal(planClientPingAssignment(tasks, 'a', [99], []).ok, false);
  assert.deepEqual(planClientPingAssignment(tasks, 'a', [], [99]), { ok: true, updates: [] });
}
