import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const NOW = Date.now();
const GIB = 1024 ** 3;

const clients = [
  {
    uuid: 'node-1', name: '东京', sort_order: 1, hidden: false,
    region: 'JP', group: '亚洲', public_remark: '直连',
    os: 'Debian', kernel_version: '6.12.0', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'EPYC', cpu_cores: 2,
    mem_total: 2 * GIB, swap_total: GIB, disk_total: 40 * GIB,
    version: '1.2.0', billing_cycle: 30, currency: 'CNY', price: 29.9,
    expired_at: '2026-01-11T00:00:00.000Z',
    traffic_limit: 1024 * GIB, traffic_limit_type: 'sum', traffic_reset_day: 1,
  },
];

const liveBody = {
  online: ['node-1'],
  count: 1,
  data: {
    'node-1': {
      cpu: 12.5, load: 0.5, load5: 0.4, load15: 0.3,
      ram: GIB, ram_total: 2 * GIB, swap: 0, swap_total: GIB,
      disk: 2 * GIB, disk_total: 40 * GIB,
      net_in: 111, net_out: 222,
      net_total_up: 5 * GIB, net_total_down: 9 * GIB,
      connections: 30, connections_udp: 6, process_count: 120,
      uptime: 3600, timestamp: NOW - 5000, lastReportTime: NOW - 3000,
    },
  },
  timestamp: NOW,
};

let guardCalls = 0;
let liveCalls = 0;
let adminAllowed = false;
let rateLimited = false;

const env = {
  LIVE_DATA: {
    idFromName: () => 'global',
    get: () => ({
      fetch: async request => {
        if (!String(request?.url || '').endsWith('/live')) {
          // 静态投影推送（scheduleMonitorMetaPush），不计入实时读取次数。
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        }
        liveCalls += 1;
        return new Response(JSON.stringify(liveBody), { headers: { 'Content-Type': 'application/json' } });
      },
    }),
  },
};

class FakeCache {
  store = new Map();
  putCount = 0;

  async match(request) {
    const stored = this.store.get(request.url);
    return stored ? stored.clone() : undefined;
  }

  async put(request, response) {
    this.putCount += 1;
    this.store.set(request.url, response.clone());
  }
}

const fakeCache = new FakeCache();

const loader = createWorkerLoader({
  globals: { caches: { default: fakeCache } },
  db: {
    getTrafficTotals: async (_database, uuids) => Object.fromEntries(
      uuids.map(uuid => [uuid, { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 }]),
    ),
  },
  overrides: {
    'worker/src/routes/public.ts': {
      getPublicClientsSnapshot: async () => ({ clients, nodes: [], publicClientIds: new Set(['node-1']) }),
      guardPublicMetadata: async () => {
        guardCalls += 1;
        return rateLimited
          ? new Response(JSON.stringify({ error: 'too many' }), { status: 429 })
          : null;
      },
      guardMonitorMetrics: async () => null,
      hasAdminSession: async () => adminAllowed,
    },
  },
});

const { monitorCompatRoutes } = loader.load('worker/src/routes/monitor-compat.ts');

const get = (query = '', headers) => monitorCompatRoutes.request(
  `/nodes${query}`,
  { method: 'GET', headers },
  env,
);

// --- 匿名首次请求：未命中，正常走限流 + DO，并写入边缘缓存 ---
{
  const res = await get('?probe=first');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Nodes-Cache'), 'miss');
  assert.equal(guardCalls, 1);
  assert.equal(liveCalls, 1);
  assert.equal(fakeCache.putCount, 1);
  const body = await res.json();
  assert.equal(body.admin, false);
  assert.equal(body.nodes.length, 1);
}

// --- 匿名再次请求（带不同随机 query）：命中，跳过限流与 DO，键不会被 query 切碎 ---
{
  const res = await get(`?probe=second-${Date.now()}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Nodes-Cache'), 'hit');
  assert.match(res.headers.get('Server-Timing') || '', /edge-cache;desc="hit"/);
  assert.equal(guardCalls, 1, '缓存命中不应该再触发限流');
  assert.equal(liveCalls, 1, '缓存命中不应该再读 LIVE_DATA DO');
  assert.equal((await res.json()).admin, false);
}

// --- 带管理员会话：绕过缓存，响应不可共享，且不会写入缓存 ---
{
  adminAllowed = true;
  const before = fakeCache.putCount;
  const res = await get('', { Cookie: 'cf_monitor_session=synthetic' });
  adminAllowed = false;
  const body = await res.json();
  assert.equal(body.admin, true);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Nodes-Cache'), null);
  assert.equal(fakeCache.putCount, before, '含 admin 位的响应不能写入共享缓存');
  assert.equal(guardCalls, 2, '管理员请求绕过缓存，照常受限流保护');
}

// --- 被限流的请求不写缓存 ---
{
  const key = [...fakeCache.store.keys()][0];
  fakeCache.store.delete(key);
  const before = fakeCache.putCount;
  rateLimited = true;
  const res = await get('?probe=limited');
  rateLimited = false;
  assert.equal(res.status, 429);
  assert.equal(fakeCache.putCount, before, '429 响应不应进缓存');
}

// --- 过期的缓存条目按未命中处理 ---
{
  const res = await get('?probe=refresh');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Nodes-Cache'), 'miss');
  const key = [...fakeCache.store.keys()][0];
  const stored = fakeCache.store.get(key);
  const headers = new Headers(stored.headers);
  headers.set('X-CF-VPS-Monitor-Nodes-Cached-At', String(Date.now() - 60_000));
  fakeCache.store.set(key, new Response(stored.body, { status: stored.status, headers }));

  guardCalls = 0;
  liveCalls = 0;
  const stale = await get(`?probe=stale-${Date.now()}`);
  assert.equal(stale.headers.get('X-CF-VPS-Monitor-Nodes-Cache'), 'miss');
  assert.equal(guardCalls, 1, '过期条目应重新走限流');
  assert.equal(liveCalls, 1);
}

console.log('monitor nodes anonymous edge cache tests passed');
