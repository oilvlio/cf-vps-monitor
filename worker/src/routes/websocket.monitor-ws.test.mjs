import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const GIB = 1024 ** 3;
const CLIENT = {
  uuid: 'node-1', name: '东京', sort_order: 1, hidden: false,
  region: 'JP', group: '亚洲', public_remark: '直连',
  os: 'Debian', kernel_version: '6.12.0', arch: 'x86_64', virtualization: 'kvm',
  cpu_name: 'EPYC', cpu_cores: 2,
  mem_total: 2 * GIB, swap_total: GIB, disk_total: 40 * GIB,
  version: '1.2.0', billing_cycle: 30, currency: 'CNY', price: 29.9,
  expired_at: '2030-01-11T00:00:00.000Z',
  traffic_limit: 1024 * GIB, traffic_limit_type: 'sum', traffic_reset_day: 1,
};

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
    db: {
      getTrafficTotals: async (_database, clients) => Object.fromEntries(
        clients.map(uuid => [uuid, { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 }]),
      ),
    },
    overrides: {
      'worker/src/routes/public.ts': {
        getPublicClientsSnapshot: async () => ({
          clients: [CLIENT],
          nodes: [],
          publicClientIds: new Set([CLIENT.uuid]),
        }),
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
  // 没有升级就不该消耗 DO / 查元数据
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

test('升级时先推静态投影给 DO，再按 role=monitor 转发', async () => {
  const { wsRoutes, env, doCalls } = fixture({ admin: true });
  const response = await call(wsRoutes, env, '/ws', UPGRADE);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'forwarded');

  assert.equal(doCalls.length, 2);
  const [meta, forward] = doCalls;

  assert.equal(meta.path, '/monitor-meta');
  assert.equal(meta.method, 'POST');
  const body = JSON.parse(meta.body);
  // admin 不进共享 meta（会被广播给所有访客），而是作为该连接的属性。
  assert.equal(body.admin, undefined);
  assert.equal(body.nodes.length, 1);
  const node = body.nodes[0];
  // 推进去的是静态投影：不含实时字段，含 monitor 枚举/单位已换算的静态字段
  assert.ok(Number.isInteger(node.id), 'id 必须是整数');
  assert.equal(node.uuid, 'node-1');
  assert.equal(node.billing_cycle, 'monthly');
  assert.equal(node.traffic_limit, 1024 * GIB);
  assert.equal(node.expires_at, '2030-01-11');
  assert.equal(node.currency, 'CNY');
  // day_* / total_* 也来自数据库，随静态投影推进 DO。
  assert.equal(node.day_rx, 100);
  assert.equal(node.day_tx, 50);
  assert.equal(node.total_rx, 1e12);
  assert.equal(node.total_tx, 5e11);
  for (const unexpected of ['online', 'metrics', 'last_seen', 'month_rx', 'month_tx']) {
    assert.ok(!(unexpected in node), `静态投影不应含 ${unexpected}`);
  }

  assert.equal(forward.path, '/');
  assert.equal(forward.params.role, 'monitor');
  assert.match(forward.params.id, /^monitor-/);
  assert.equal(forward.params.gzip, undefined);
  // 管理员建连时 admin=1 跟着连接走。
  assert.equal(forward.params.admin, '1');
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
