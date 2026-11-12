import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

// 路由里 nowMs 取真实时钟，所以实时载荷的时间戳也要相对当前时间构造。
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
  {
    uuid: 'node-2', name: '离线节点', sort_order: 2, hidden: false,
    region: 'US', group: '', public_remark: '',
    os: 'Debian', kernel_version: '6.1', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'Xeon', cpu_cores: 1,
    mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    version: '1.0.0', billing_cycle: 365, currency: 'USD', price: 5,
    expired_at: '', traffic_limit: 0, traffic_limit_type: 'sum', traffic_reset_day: 1,
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
  last_known: {
    'node-2': {
      cpu: 0, net_total_up: GIB, net_total_down: 2 * GIB, timestamp: NOW - 5 * 3600 * 1000,
      lastReportTime: NOW - 5 * 3600 * 1000,
    },
  },
  timestamp: NOW,
};

const env = {
  LIVE_DATA: {
    idFromName: () => 'global',
    get: () => ({ fetch: async () => new Response(JSON.stringify(liveBody), { headers: { 'Content-Type': 'application/json' } }) }),
  },
};

const recordRow = {
  ts: Math.floor((NOW - 60_000) / 60_000) * 60,
  samples: 2,
  minutes: 2,
  cpu: 10,
  cpu_max: 35,
  mem_used: 100,
  disk_used: 50,
  net_rx: 1000,
  net_tx: 500,
  net_rx_max: 4000,
  net_tx_max: 1500,
  swap_used: 5,
  tcp: 20,
  udp: 4,
  procs: 88,
};

const totalsByClient = {
  'node-1': { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  'node-2': { day_rx: 0, day_tx: 0, total_rx: 2e9, total_tx: 1e9 },
};

const recordCalls = [];
let adminAllowed = false;
let pingRecordTaskIds = [];
const monitorThemeConfigs = new Map();

const loader = createWorkerLoader({
  db: {
    listPingTasks: async () => [
      { id: 1, name: '电信', clients: ['node-1'], all_clients: false, sort_order: 2, type: 'icmp', target: '1.1.1.1', interval_sec: 60 },
      { id: 2, name: '移动', clients: ['node-2'], all_clients: false, sort_order: 3, type: 'icmp', target: '2.2.2.2', interval_sec: 60 },
      { id: 3, name: '联通', clients: ['node-1'], all_clients: false, sort_order: 1, type: 'icmp', target: '3.3.3.3', interval_sec: 60 },
      { id: 4, name: '未分配', clients: [], all_clients: false, sort_order: 0, type: 'icmp', target: '4.4.4.4', interval_sec: 60 },
    ],
    listClients: async () => clients,
    getTheme: async (_database, short) => (short === 'hex' ? { config_json: '{"accent":"#fff"}' } : null),
    getSetting: async (_database, key) => monitorThemeConfigs.get(key) ?? null,
    setSetting: async (_database, key, value) => monitorThemeConfigs.set(key, value),
    getSettingsByKeys: async () => ({ record_persist_interval_sec: '120' }),
    getTrafficTotals: async (_database, clients) => Object.fromEntries(
      clients.map(uuid => [uuid, totalsByClient[uuid] ?? { day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 }]),
    ),
    getRecordsByTimeRangeAggregated: async (_database, client) => {
      recordCalls.push(client);
      return [recordRow];
    },
    getPingRecordsForTasksRangeBucketed: async (_database, _client, taskIds) => {
      pingRecordTaskIds = taskIds;
      return ({
        1: [
          { client: 'node-1', task_id: 1, time: new Date(NOW - 60_000).toISOString(), value: 42, min_latency: 30, max_latency: 55 },
          { client: 'node-1', task_id: 1, time: new Date(NOW - 1_800_000).toISOString(), value: -1 },
        ],
        2: [{ client: 'node-1', task_id: 2, time: new Date(NOW - 60_000).toISOString(), value: 5 }],
        3: [{ client: 'node-1', task_id: 3, time: new Date(NOW - 60_000).toISOString(), value: 15 }],
      });
    },
  },
  overrides: {
    'worker/src/routes/public.ts': {
      getPublicClientsSnapshot: async () => ({ clients, nodes: [], publicClientIds: new Set(clients.map(c => c.uuid)) }),
      guardPublicMetadata: async () => null,
      guardMonitorMetrics: async () => null,
      hasAdminSession: async () => adminAllowed,
    },
  },
});

const { monitorCompatRoutes, clearMonitorHistoryCache } = loader.load('worker/src/routes/monitor-compat.ts');
const { monitorNumericId } = loader.load('worker/src/utils/monitor-contract.ts');
// 契约里的 id 是整数（UUID 经 monitorNumericId 映射），路径与查找都用这个。
const ID1 = monitorNumericId('node-1');
const ID2 = monitorNumericId('node-2');
const get = path => monitorCompatRoutes.request(path, { method: 'GET' }, env);

// --- /ping-tasks mirrors Monitor's admin-only task shape ---
{
  const unauthorized = await get('/ping-tasks');
  assert.equal(unauthorized.status, 401, 'ping task targets must not be public');
  adminAllowed = true;
  const response = await get('/ping-tasks');
  adminAllowed = false;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.tasks[0].interval, 60);
  assert.equal(body.tasks[0].target, '1.1.1.1');
  assert.deepEqual(body.tasks[0].nodes, [ID1]);
}

// --- /nodes ---
{
  const res = await get('/nodes');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=4/);
  assert.match(res.headers.get('Cache-Control'), /s-maxage=4/);
  const body = await res.json();
  assert.equal(body.admin, false);
  assert.equal(body.nodes.length, 2);

  const node = body.nodes.find(n => n.id === ID1);
  assert.ok(Number.isInteger(node.id), 'id 必须是整数');
  assert.equal(node.online, true);
  assert.equal(node.billing_cycle, 'monthly');
  assert.equal(node.currency, 'CNY');
  assert.equal(node.month_rx, 9 * GIB);      // net_total_down = 本计费周期下行
  assert.equal(node.month_tx, 5 * GIB);
  assert.equal(node.month_used, 14 * GIB);
  // day_* / total_* 来自 cfm_traffic_totals（批量）。
  assert.equal(node.day_rx, 100);
  assert.equal(node.day_tx, 50);
  assert.equal(node.total_rx, 1e12);
  assert.equal(node.total_tx, 5e11);
  // month_start 取的是「当前」计费月首日，用真实时钟，所以只校验形状与当月。
  assert.match(node.month_start, /^\d{4}-\d{2}-01$/);
  assert.equal(node.month_start, `${new Date().toISOString().slice(0, 8)}01`);
  assert.equal(node.last_seen_ago, 0);
  assert.equal(node.traffic_mode, 'sum');
  assert.ok(node.metrics, '在线节点应有 metrics');
  assert.equal(node.metrics.tcp, 30);

  const offline = body.nodes.find(n => n.id === ID2);
  assert.equal(offline.online, false);
  assert.equal(offline.metrics, null);
  assert.equal(offline.billing_cycle, 'yearly');
  // 路由用自己的 Date.now() 计算「已过去秒数」，与夹具的 NOW 可能差几百毫秒到几秒
  // （并行跑测试时更明显），所以给一个窄区间而不是精确值。
  assert.ok(
    offline.last_seen_ago >= 5 * 3600 && offline.last_seen_ago <= 5 * 3600 + 10,
    `last_seen_ago 应约为 5h，实际 ${offline.last_seen_ago}`,
  );
  assert.equal(offline.month_rx, 2 * GIB);   // 离线也读 last_known 的周期合计
  assert.equal(offline.day_rx, 0);
  assert.equal(offline.total_rx, 2e9);
  assert.equal(offline.expires_at, null);
}

// --- /nodes/:id/metrics 默认（metrics + ping） ---
{
  const res = await get(`/nodes/${ID1}/metrics?hours=24&points=1440`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.step, 60);
  assert.equal(body.metrics.length, 1);
  assert.equal(body.metrics[0].cpu, 10);
  assert.equal(body.metrics[0].cpu_max, 35);
  assert.equal(body.metrics[0].net_rx_max, 4000);
  assert.equal(body.metrics[0].minutes, 1);
  for (const key of ['ts', 'minutes', 'cpu', 'cpu_max', 'mem_used', 'disk_used', 'net_rx', 'net_tx', 'net_rx_max', 'net_tx_max', 'swap_used', 'tcp', 'udp', 'procs']) {
    assert.ok(key in body.metrics[0], `metrics 行缺 ${key}`);
  }
  assert.equal(body.ping.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(pingRecordTaskIds)), [3, 1], 'query only assigned tasks in backend order');
  assert.deepEqual(body.ping.filter(row => row.ts === body.ping.at(-1).ts).map(row => row.task_id), [3, 1]);
  const lost = body.ping.find(row => row.latency === null);
  assert.equal(lost.loss, 100);
  assert.deepEqual(body.probes, { 1: '电信', 3: '联通' });
  assert.deepEqual(body.loss, {});
  // 数字 id 必须被换回 UUID 再查库。
  assert.deepEqual(recordCalls, ['node-1']);
}

// --- series=ping：不要 metrics ---
{
  const body = await (await get(`/nodes/${ID1}/metrics?hours=24&points=120&series=ping`)).json();
  assert.equal(body.step, 720);              // 86400/60/120 -> 12 分钟
  assert.deepEqual(body.metrics, []);
  assert.equal(body.ping.length, 3);
  assert.deepEqual(body.probes, { 1: '电信', 3: '联通' });
}

// --- series=metrics：不要 ping / probes ---
{
  const body = await (await get(`/nodes/${ID1}/metrics?hours=24&series=metrics`)).json();
  assert.equal(body.metrics.length, 1);
  assert.deepEqual(body.ping, []);
  assert.deepEqual(body.probes, {});
}

// --- 相同查询 10s 内只触达一次数据库（主题按节点扇出轮询） ---
{
  clearMonitorHistoryCache();
  recordCalls.length = 0;
  const path = `/nodes/${ID1}/metrics?hours=24&points=1&series=metrics`;
  const first = await get(path);
  const firstBody = await first.json();
  const second = await get(path);
  const secondBody = await second.json();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody, firstBody);
  assert.equal(recordCalls.length, 1, '重复查询应命中进程内缓存');
  assert.match(second.headers.get('Cache-Control'), /max-age=10/);
  // 不同 series 不能被同一份缓存冒充。
  const pingBody = await (await get(`/nodes/${ID1}/metrics?hours=24&points=1&series=ping`)).json();
  assert.deepEqual(pingBody.metrics, [], 'series=ping 返回的 metrics 应为空');
  assert.ok(pingBody.ping.length > 0, 'series=ping 应返回 ping 数据');
  assert.equal(recordCalls.length, 1, 'series=ping 不查 records');
}

// --- 未知节点：空但形状完整 ---
{
  const res = await get('/nodes/missing/metrics?hours=6');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.metrics, []);
  assert.deepEqual(body.ping, []);
  assert.deepEqual(body.probes, {});
  assert.deepEqual(body.loss, {});
  assert.equal(body.step, 60);
}

// --- 用 UUID 直接当 id 不再匹配（契约里 id 是整数）---
{
  const body = await (await get('/nodes/node-1/metrics?hours=6')).json();
  assert.deepEqual(body.metrics, [], 'UUID 不是合法 id，应查不到节点');
}

// --- /themes/:short/config ---
{
  assert.deepEqual(await (await get('/themes/hex/config')).json(), { accent: '#fff' });
  assert.deepEqual(await (await get('/themes/unknown/config')).json(), {});

  const path = '/themes/LuminaPlus/config';
  const config = { chart: { smooth: true }, colors: ['#123456', '#abcdef'] };
  const denied = await monitorCompatRoutes.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }, env);
  assert.equal(denied.status, 401, 'writing theme config requires an administrator session');

  adminAllowed = true;
  try {
    const saved = await monitorCompatRoutes.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }, env);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).success, true);

    const loaded = await get(path);
    assert.equal(loaded.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await loaded.json(), config);
  } finally {
    adminAllowed = false;
  }

  adminAllowed = true;
  try {
    const invalid = await monitorCompatRoutes.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    }, env);
    assert.equal(invalid.status, 400, 'configuration must be a JSON object');
  } finally {
    adminAllowed = false;
  }
}

// --- 限流/守卫短路也返回既有响应（这里 guard 返回 null，正常走到数据层）---
{
  const limitedLoader = createWorkerLoader({
    db: {},
    overrides: {
      'worker/src/routes/public.ts': {
        getPublicClientsSnapshot: async () => ({ clients: [], nodes: [], publicClientIds: new Set() }),
        guardPublicMetadata: async () => new Response(JSON.stringify({ error: 'too many' }), { status: 429 }),
        guardMonitorMetrics: async () => new Response(JSON.stringify({ error: 'too many' }), { status: 429 }),
        hasAdminSession: async () => false,
      },
    },
  });
  const routes = limitedLoader.load('worker/src/routes/monitor-compat.ts').monitorCompatRoutes;
  assert.equal((await routes.request('/nodes', { method: 'GET' }, env)).status, 429);
  assert.equal((await routes.request(`/nodes/${ID1}/metrics?hours=6`, { method: 'GET' }, env)).status, 429);
}

// --- 管理员会话的 /nodes 不进共享缓存 ---
{
  const adminLoader = createWorkerLoader({
    db: {
      getTrafficTotals: async () => ({}),
    },
    overrides: {
      'worker/src/routes/public.ts': {
        getPublicClientsSnapshot: async () => ({ clients, nodes: [], publicClientIds: new Set(clients.map(c => c.uuid)) }),
        guardPublicMetadata: async () => null,
        guardMonitorMetrics: async () => null,
        hasAdminSession: async () => true,
      },
    },
  });
  const adminRoutes = adminLoader.load('worker/src/routes/monitor-compat.ts').monitorCompatRoutes;
  const res = await adminRoutes.request('/nodes', { method: 'GET' }, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).admin, true);
  assert.match(res.headers.get('Cache-Control'), /private/);
  assert.doesNotMatch(res.headers.get('Cache-Control'), /public/);
}

console.log('monitor-compat route tests passed');
