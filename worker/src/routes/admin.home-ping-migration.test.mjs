import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

// 回归：新迁移 9_home_ping_task 没执行时，后台编辑弹窗曾因为读取首页探测点失败而
// 把整个任务下拉框清空。接口必须给出明确的 503 + 迁移提示，前端据此单独提示。
function loadAdmin(db) {
  return createWorkerLoader({ db }).load('worker/src/routes/admin.ts').adminRoutes;
}
const migrationMissing = Object.assign(new Error('Supabase RPC cfm_home_ping_assignments failed: 404 PGRST202'), { status: 404 });

test('GET /home-ping explains a missing migration instead of a bare 500', async () => {
  const admin = loadAdmin({ getHomePingAssignments: async () => { throw migrationMissing; } });
  const response = await admin.fetch(new Request('https://panel.example.test/home-ping'), {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'migration_required');
  assert.match(body.error, /9_home_ping_task/);
});

test('POST /clients/:uuid/home-ping explains a missing migration too', async () => {
  const admin = loadAdmin({
    listPingTasks: async () => [{ id: 1, name: 'Synthetic', all_clients: true, clients: [] }],
    setHomePingTask: async () => { throw migrationMissing; },
    insertAuditLog: async () => {},
  });
  const response = await admin.fetch(new Request('https://panel.example.test/clients/node-a/home-ping', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: 1 }),
  }), {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'migration_required');
});

test('an unrelated database failure stays a generic 500', async () => {
  const admin = loadAdmin({ getHomePingAssignments: async () => { throw new Error('connection reset'); } });
  const response = await admin.fetch(new Request('https://panel.example.test/home-ping'), {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 500);
});
