import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const root = new URL('../../../', import.meta.url);

function source(path) {
  return readFileSync(new URL(`worker/src/${path}`, root), 'utf8');
}

// 兼容入口薄转发的前提是入口归属于正确的消费者。Agent 的上报 WebSocket 曾挂在
// 前端的实时路由模块里，调整前端协议时会顺带碰到 Agent；这里把归属钉死。
test('Agent WebSocket ingress belongs to the Agent route, not the frontend live route', () => {
  const frontend = source('routes/websocket.ts');
  const agent = source('routes/client.ts');

  assert.ok(
    !frontend.includes("'/clients/report'"),
    '前端实时路由不应再注册 Agent 的 /clients/report',
  );
  assert.doesNotMatch(
    frontend,
    /from '\.\/client'/,
    '前端实时路由不应 import Agent 路由模块',
  );
  assert.match(
    agent,
    /clientRoutes\.get\('\/report'/,
    'Agent 路由应持有 GET /report（与 POST /report 同一路径）',
  );
});

test('shared WebSocket predicates live outside both consumers', () => {
  const helper = source('utils/websocket-request.ts');
  assert.match(helper, /export function isWebSocketUpgrade/);
  assert.match(helper, /export function requestHasValidOrigin/);

  for (const path of ['routes/websocket.ts', 'routes/client.ts']) {
    const text = source(path);
    assert.match(text, /from '\.\.\/utils\/websocket-request'/, `${path} 应复用共享判定`);
    assert.doesNotMatch(text, /^function isWebSocketUpgrade/m, `${path} 不应再各写一份 Upgrade 判定`);
  }
});

test('Agent report GET stays a real route: missing token 401, missing Upgrade 400', async () => {
  const env = { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: async () => Response.json({}) }) } };
  const loader = createWorkerLoader({ db: {
    getClientIdentityByToken: async () => ({ uuid: 'node', name: 'node', hidden: false, token: 'a'.repeat(64) }),
    getClient: async () => ({ uuid: 'node', name: 'node', hidden: false, region: '' }),
    updateClient: async () => {},
    markClientTokenUsed: async () => ({ updated: false, previous_ip: null }),
  } });
  const { clientRoutes } = loader.load('worker/src/routes/client.ts');

  const missing = await clientRoutes.fetch(new Request('https://panel.example.test/report'), env, {});
  assert.equal(missing.status, 401);

  const noUpgrade = await clientRoutes.fetch(new Request('https://panel.example.test/report', {
    headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
  }), env, {});
  assert.equal(noUpgrade.status, 400);
  assert.deepEqual(await noUpgrade.json(), { error: 'WebSocket upgrade required' });
});
