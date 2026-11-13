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
let metricsGuardCalls = 0;
let metricsRateLimited = false;
let metricsRecordCalls = 0;

const env = {
  LIVE_DATA: {
    idFromName: () => 'global',
    get: () => ({
      fetch: async request => {
        if (!String(request?.url || '').endsWith('/live')) {
          // 其它 DO 路径（如后台快照），不计入实时读取次数。
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
    listPingTasks: async () => [
      {
        id: 1, name: '电信', clients: ['node-1'], all_clients: false, sort_order: 1,
        type: 'icmp', target: '1.1.1.1', interval_sec: 60,
      },
    ],
    getSettingsByKeys: async () => ({ record_persist_interval_sec: '120' }),
    getRecordsByTimeRangeAggregated: async () => {
      metricsRecordCalls += 1;
      return [];
    },
    getPingRecordsForTasksRangeBucketed: async () => ({}),
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
      guardMonitorMetrics: async () => {
        metricsGuardCalls += 1;
        return metricsRateLimited
          ? new Response(JSON.stringify({ error: 'too many' }), { status: 429 })
          : null;
      },
      hasAdminSession: async () => adminAllowed,
    },
  },
});

const { monitorCompatRoutes } = loader.load('worker/src/routes/monitor-compat.ts');
const { monitorNumericId } = loader.load('worker/src/monitor/contract.ts');
const NODE_ID = monitorNumericId('node-1');

const get = (query = '', headers) => monitorCompatRoutes.request(
  `/nodes${query}`,
  { method: 'GET', headers },
  env,
);

const getMetrics = (query = '', headers) => monitorCompatRoutes.request(
  `/nodes/${NODE_ID}/metrics${query}`,
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

// --- 匿名 /metrics 首次请求：未命中，写边缘缓存；键忽略随机 query ---
{
  const beforePut = fakeCache.putCount;
  metricsGuardCalls = 0;
  metricsRecordCalls = 0;
  const res = await getMetrics('?hours=2&points=720&series=metrics&probe=first');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Metrics-Cache'), 'miss');
  assert.equal(fakeCache.putCount, beforePut + 1, '首次 metrics 应写入边缘缓存');
  assert.equal(metricsGuardCalls, 1);
  assert.equal(metricsRecordCalls, 1);
  assert.match(res.headers.get('Server-Timing') || '', /query;dur=/);
}

// --- 匿名 /metrics 再次请求（不同随机 query）：命中，跳过限流与数据库 ---
{
  const guardBefore = metricsGuardCalls;
  const recordBefore = metricsRecordCalls;
  const res = await getMetrics(`?hours=2&points=720&series=metrics&probe=second-${Date.now()}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Metrics-Cache'), 'hit');
  assert.match(res.headers.get('Server-Timing') || '', /edge-cache;desc="hit"/);
  assert.equal(metricsGuardCalls, guardBefore, '边缘缓存命中不应再走限流');
  assert.equal(metricsRecordCalls, recordBefore, '边缘缓存命中不应再查数据库');
}

// --- 带管理员会话：绕过 metrics 边缘缓存，且不写入 ---
{
  adminAllowed = true;
  const beforePut = fakeCache.putCount;
  const guardBefore = metricsGuardCalls;
  const res = await getMetrics('?hours=2&points=720&series=metrics&probe=admin');
  adminAllowed = false;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CF-VPS-Monitor-Metrics-Cache'), null);
  assert.equal(fakeCache.putCount, beforePut, '管理员响应不能写入共享缓存');
  assert.equal(metricsGuardCalls, guardBefore + 1, '管理员请求绕过缓存，照常受限流保护');
}

// --- 被限流的 /metrics 不写边缘缓存 ---
{
  const beforePut = fakeCache.putCount;
  metricsRateLimited = true;
  const res = await getMetrics('?hours=6&points=720&series=metrics');
  metricsRateLimited = false;
  assert.equal(res.status, 429);
  assert.equal(fakeCache.putCount, beforePut, '429 响应不应进缓存');
}

// --- 过期的 metrics 边缘缓存条目按未命中处理 ---
{
  const first = await getMetrics('?hours=7&points=720&series=ping');
  assert.equal(first.headers.get('X-CF-VPS-Monitor-Metrics-Cache'), 'miss');
  metricsGuardCalls = 0;

  const key = [...fakeCache.store.keys()]
    .find(candidate => candidate.includes('/metrics') && candidate.includes('hours=7'));
  assert.ok(key, '应能找到 hours=7 的 metrics 缓存条目');
  const stored = fakeCache.store.get(key);
  const headers = new Headers(stored.headers);
  headers.set('X-CF-VPS-Monitor-Metrics-Cached-At', String(Date.now() - 60_000));
  fakeCache.store.set(key, new Response(stored.body, { status: stored.status, headers }));

  const stale = await getMetrics(`?hours=7&points=720&series=ping&probe=stale-${Date.now()}`);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('X-CF-VPS-Monitor-Metrics-Cache'), 'miss');
  assert.equal(metricsGuardCalls, 1, '过期条目应重新走限流');
}

console.log('monitor nodes anonymous edge cache tests passed');
