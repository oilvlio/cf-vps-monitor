import assert from 'node:assert/strict';
import test from 'node:test';
import { generateToken } from '../src/auth/jwt.ts';
import { generateMfaToken } from '../src/auth/mfa-token.ts';
import { createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';
import { rpc } from '../../scripts/test-support/postgres.mjs';

test('Ping tasks can be created unassigned and ticked per client afterwards', { timeout: 180000 }, async t => {
  const f = await createRuntimeFixture();
  t.after(() => f.close());
  await rpc(f.database, 'cfm_create_initial_admin', {
    p_uuid: 'assign-admin', p_username: 'assign-admin', p_password_hash: 'synthetic-unused-password-hash',
  });
  const user = (await f.database.query('select uuid, username, session_version from users')).rows[0];
  const identity = { userId: user.uuid, username: user.username, sessionVersion: user.session_version };
  const session = await generateToken(user.uuid, user.username, user.session_version, runtimeSecrets);
  const stepUp = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets);
  const csrf = 'a'.repeat(32);
  const headers = {
    'Content-Type': 'application/json', Origin: 'https://panel.example.test', 'CF-Connecting-IP': '1.1.1.1',
    Cookie: `cf_monitor_session=${session}; cf_monitor_csrf=${csrf}; cf_monitor_mfa_stepup=${stepUp}`, 'X-CSRF-Token': csrf,
  };
  await f.database.query("insert into clients(uuid,name,token) values ('node-a','Node A','synthetic-a'),('node-b','Node B','synthetic-b')");
  const post = (path, body) => f.fetch(`/api/admin/ping/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const rows = async () => (await f.database.query('select id, clients, all_clients from ping_tasks order by id')).rows;

  // 1. 不分配任何服务器也能创建
  let response = await post('add', { name: 'Unbound', type: 'icmp', target: '1.1.1.1', all_clients: false, clients: [] });
  assert.equal(response.status, 200, await response.clone().text());
  const unbound = (await response.json()).task;
  assert.deepEqual(unbound.clients, []);
  assert.equal(unbound.all_clients, false);

  response = await post('add', { name: 'Second', type: 'icmp', target: '8.8.8.8', all_clients: false, clients: ['node-b'] });
  assert.equal(response.status, 200, await response.clone().text());
  const second = (await response.json()).task;

  response = await post('add', { name: 'Global', type: 'icmp', target: '9.9.9.9', all_clients: true, clients: [] });
  assert.equal(response.status, 200, await response.clone().text());
  const global = (await response.json()).task;

  // 2. 按服务器勾选：node-a 勾选 Unbound 与 Second
  response = await post('assign', { client: 'node-a', tasks: [unbound.id, second.id], base: [] });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).changed, 2);
  let state = await rows();
  assert.deepEqual(state.find(r => r.id === unbound.id).clients, ['node-a']);
  assert.deepEqual(state.find(r => r.id === second.id).clients.sort(), ['node-a', 'node-b']);

  // 3. 只应用差量：node-a 取消 Unbound；Second 在 base 中不存在，不受影响
  response = await post('assign', { client: 'node-a', tasks: [second.id], base: [unbound.id, second.id] });
  assert.equal(response.status, 200, await response.clone().text());
  state = await rows();
  assert.deepEqual(state.find(r => r.id === unbound.id).clients, []);
  assert.deepEqual(state.find(r => r.id === second.id).clients.sort(), ['node-a', 'node-b']);

  // 4. 过期的 base 不会覆盖他处的分配：node-b 此刻仍在 Second 里
  response = await post('assign', { client: 'node-a', tasks: [], base: [] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changed, 0);
  assert.deepEqual((await rows()).find(r => r.id === second.id).clients.sort(), ['node-a', 'node-b']);

  // 5. 拒绝：全局任务、不存在的服务器、格式错误
  response = await post('assign', { client: 'node-a', tasks: [global.id], base: [] });
  assert.equal(response.status, 400);
  response = await post('assign', { client: 'missing', tasks: [], base: [] });
  assert.equal(response.status, 404);
  response = await post('assign', { client: 'node-a', tasks: 'nope', base: [] });
  assert.equal(response.status, 400);
});
