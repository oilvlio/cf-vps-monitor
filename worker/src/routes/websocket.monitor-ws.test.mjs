import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

function fixture({ admin = false } = {}) {
  const doCalls = [];
  const env = {
    LIVE_DATA: {
      idFromName: name => name,
      get: () => ({
        fetch: async (request) => {
          const url = new URL(request.url);
          doCalls.push({
            path: url.pathname,
            params: Object.fromEntries(url.searchParams.entries()),
            method: request.method,
            body: request.method === 'POST' ? await request.text() : '',
          });
          return new Response('forwarded', { status: 200 });
        },
      }),
    },
  };
  const loader = createWorkerLoader({
    db: {},
    overrides: {
      'worker/src/routes/public.ts': {
        hasAdminSession: async () => admin,
        invalidatePublicMetadataCache: () => {},
      },
    },
  });
  const { wsRoutes } = loader.load('worker/src/routes/websocket.ts');
  return { wsRoutes, env, doCalls };
}

const UPGRADE = {
  headers: {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    Origin: 'https://example.com',
  },
};

function call(wsRoutes, env, path, init = {}) {
  return wsRoutes.request(`https://example.com${path}`, init, env);
}

test('普通 GET /api/ws 回 426（monitor 契约要求）', async () => {
  const { wsRoutes, env, doCalls } = fixture();
  const response = await call(wsRoutes, env, '/ws');
  assert.equal(response.status, 426);
  assert.match(await response.text(), /WebSocket/);
  // 没有升级就不该消耗 DO
  assert.deepEqual(doCalls, []);
});

test('Origin 不匹配时拒绝升级', async () => {
  const { wsRoutes, env } = fixture();
  const response = await call(wsRoutes, env, '/ws', {
    ...UPGRADE,
    headers: { ...UPGRADE.headers, Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
});

test('升级只按 role=monitor 转发；静态投影由 DO 自派生，不再推送', async () => {
  const { wsRoutes, env, doCalls } = fixture({ admin: true });
  const response = await call(wsRoutes, env, '/ws', UPGRADE);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'forwarded');

  // 只有一次 DO 往返：升级转发。旧的 /monitor-meta 推送已删除。
  assert.equal(doCalls.length, 1);
  assert.equal(doCalls.filter(item => item.path === '/monitor-meta').length, 0);

  const forward = doCalls[0];
  assert.equal(forward.path, '/');
  assert.equal(forward.params.role, 'monitor');
  assert.match(forward.params.id, /^monitor-/);
  assert.equal(forward.params.gzip, undefined);
  // 管理员建连时 admin=1 跟着连接走。
  assert.equal(forward.params.admin, '1');
});

test('多次建连都只转发升级请求，不产生额外 DO 写入', async () => {
  const { wsRoutes, env, doCalls } = fixture();
  await call(wsRoutes, env, '/ws', UPGRADE);
  await call(wsRoutes, env, '/ws', UPGRADE);
  assert.equal(doCalls.length, 2);
  assert.equal(doCalls.filter(item => item.path === '/').length, 2);
  assert.equal(doCalls.filter(item => item.path === '/monitor-meta').length, 0);
});

test('访客建连不带 admin 参数', async () => {
  const { wsRoutes, env, doCalls } = fixture({ admin: false });
  await call(wsRoutes, env, '/ws', UPGRADE);
  const forward = doCalls.find(item => item.path === '/');
  assert.equal(forward.params.admin, undefined);
});

test('?gzip 透传为 DO 的 gzip=1，?gzip=0 不透传', async () => {
  for (const [query, expected] of [['?gzip', '1'], ['?gzip=1', '1'], ['?gzip=0', undefined], ['', undefined]]) {
    const { wsRoutes, env, doCalls } = fixture();
    await call(wsRoutes, env, `/ws${query}`, UPGRADE);
    const forward = doCalls.find(item => item.path === '/');
    assert.equal(forward.params.gzip, expected, `query=${query}`);
  }
});

console.log('websocket monitor route tests passed');
