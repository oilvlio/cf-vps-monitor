import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';
import { webcrypto } from 'node:crypto';

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
            adminToken: request.headers.get('X-CF-Monitor-Admin-Token'),
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
    'CF-Connecting-IP': '8.8.4.4',
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
  assert.equal(forward.params.viewer_ip, '8.8.4.4', 'DO must receive the trusted client IP to enforce connection quotas');
  assert.match(forward.params.id, /^monitor-/);
  assert.equal(forward.params.gzip, undefined);
  // 管理员建连时 admin=1 跟着连接走。
  assert.equal(forward.params.admin, '1');
});

test('internal admin credential comes only from the authenticated cookie and never from caller headers', async () => {
  for (const admin of [false, true]) {
    const f = fixture({ admin });
    await call(f.wsRoutes, f.env, '/ws?admin=1', { ...UPGRADE, headers: {
      ...UPGRADE.headers, Cookie: 'cf_monitor_session=real-cookie', 'X-CF-Monitor-Admin-Token': 'forged',
    } });
    assert.equal(f.doCalls[0].adminToken, admin ? 'real-cookie' : null);
    assert.ok(!JSON.stringify(f.doCalls[0].params).includes('real-cookie'));
  }
});

test('native private viewer forwards only authenticated cookie credentials and strips forged internal headers', async () => {
  const secret = 'native-viewer-route-test-secret-at-least-32-bytes';
  const loader = createWorkerLoader({ globals: { crypto: webcrypto } });
  const { createViewerToken } = loader.load('worker/src/auth/viewer-token.ts');
  const { token } = await createViewerToken({ secret, ip: '8.8.4.4', ttlMs: 60_000 });
  for (const admin of [false, true]) {
    const f = fixture({ admin });
    f.env.JWT_SECRET = secret;
    const response = await call(f.wsRoutes, f.env, '/ws/live?include_hidden=1', { ...UPGRADE, headers: {
      ...UPGRADE.headers, Cookie: 'cf_monitor_session=real-cookie', 'X-CF-Monitor-Admin-Token': 'forged',
      'Sec-WebSocket-Protocol': `cf-monitor-viewer, ${token}`,
    } });
    assert.equal(response.status, 200);
    assert.equal(f.doCalls[0].adminToken, admin ? 'real-cookie' : null);
    assert.equal(f.doCalls[0].params.include_hidden, admin ? '1' : undefined);
    assert.ok(!JSON.stringify(f.doCalls[0].params).includes('real-cookie'));
  }
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
