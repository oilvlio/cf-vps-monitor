/**
 * monitor 主题契约的黄金样本测试。
 *
 * 权威形状来自 worker/test-support/monitor-golden/hub-golden.json（provenance 见
 * 同目录 GOLDEN_SOURCE）。这里只比较形状（键集合 / 值类型）与单位不变量，不比较
 * 具体数值；数值断言留给 monitor-compat.test.mjs 等行为测试。
 *
 * 覆盖四类：
 * 1. 形状：/me、节点、节点 metrics、metrics 行、ping 行、响应包络、WS 帧。
 * 2. 单位与不变量：整数 id、ts 落在 step 网格、秒/天/字节每秒等。
 * 3. 路由级：匿名绝不能拿到 admin:true；随机 query 不能改变内容。
 * 4. WS 与 HTTP 对等：同一节点经 /nodes 路径与 DO 帧路径输出必须完全一致。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const golden = JSON.parse(
  readFileSync(new URL('../../test-support/monitor-golden/hub-golden.json', import.meta.url), 'utf8'),
);

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
    expired_at: '2027-01-11T00:00:00.000Z',
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

const totalsByClient = {
  'node-1': { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  'node-2': { day_rx: 0, day_tx: 0, total_rx: 2e9, total_tx: 1e9 },
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

let adminAllowed = false;
const themeConfigs = new Map();

const loader = createWorkerLoader({
  db: {
    listPingTasks: async () => [
      { id: 1, name: '电信', clients: ['node-1'], all_clients: false, sort_order: 1, type: 'icmp', target: '1.1.1.1', interval_sec: 60 },
    ],
    listClients: async () => clients,
    getTheme: async () => null,
    getSetting: async (_database, key) => themeConfigs.get(key) ?? null,
    setSetting: async (_database, key, value) => themeConfigs.set(key, value),
    getSettingsByKeys: async () => ({ record_persist_interval_sec: '120' }),
    getTrafficTotals: async (_database, uuids) => Object.fromEntries(
      uuids.map(uuid => [uuid, totalsByClient[uuid] ?? { day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 }]),
    ),
    getRecordsByTimeRangeAggregated: async () => [recordRow],
    getPingRecordsForTasksRangeBucketed: async () => ({
      1: [{
        client: 'node-1', task_id: 1, time: new Date(NOW - 60_000).toISOString(),
        value: 42, sample_count: 10, loss_count: 3, min_latency: 30, max_latency: 55,
      }],
    }),
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

const contract = loader.load('worker/src/monitor/contract.ts');
const { monitorCompatRoutes, clearMonitorHistoryCache, clearThemeConfigCache } = loader.load('worker/src/routes/monitor-compat.ts');
const ID1 = contract.monitorNumericId('node-1');
const ID2 = contract.monitorNumericId('node-2');
const get = (path) => monitorCompatRoutes.request(path, { method: 'GET' }, env);

// --- 形状工具 ---
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertTypes(object, spec, label) {
  for (const key of Object.keys(object)) {
    const expected = spec.types[key];
    if (expected === undefined) continue; // 由键集合断言负责多键
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(
      allowed.includes(typeOf(object[key])),
      `${label}.${key} 类型应为 ${allowed.join('|')}，实际 ${typeOf(object[key])}`,
    );
  }
}

function assertExactKeys(object, expectedKeys, label) {
  assert.deepEqual(
    Object.keys(object).sort(),
    [...expectedKeys].sort(),
    `${label} 的键集合与 golden 不一致（契约漂移）`,
  );
}

// --- 1. 形状 ---

// /me 由 buildMonitorMe 产出（/api/me 路由在 public.ts 里与后台会话形状合并）。
{
  const me = contract.buildMonitorMe({ siteUrl: 'https://example.com', siteName: 'Demo', authed: false });
  assertExactKeys(me, golden.endpoints.me.keys, 'me');
  assertTypes(me, golden.endpoints.me, 'me');
  assert.equal(contract.MONITOR_CONTRACT_VERSION, golden.contractVersion, 'CONTRACT_VERSION 与 golden 不一致');
}

// 在线节点：契约函数产出的键集合必须与 hub 的公开 node_view 完全一致。
const onlineClient = clients[0];
const onlineLive = liveBody.data['node-1'];
const onlineStatic = contract.monitorNodeStatic(onlineClient, totalsByClient['node-1']);
const onlineNode = contract.buildMonitorNode({
  client: onlineClient,
  live: onlineLive,
  online: true,
  lastReportMs: onlineLive.lastReportTime,
  traffic: contract.monitorTrafficWithTotals(onlineLive, totalsByClient['node-1']),
  nowMs: NOW,
  siteUrl: 'https://example.com',
});
{
  assertExactKeys(onlineNode, golden.endpoints.node.keys, 'node(online)');
  assertTypes(onlineNode, golden.endpoints.node, 'node(online)');

  assert.ok(onlineNode.metrics, '在线节点必须有 metrics 对象');
  const requiredMetrics = golden.endpoints.nodeMetrics.keys.filter(
    key => !golden.endpoints.nodeMetrics.optional.includes(key),
  );
  for (const key of requiredMetrics) {
    assert.ok(key in onlineNode.metrics, `metrics 缺少 hub 要求的键 ${key}`);
  }
  for (const key of Object.keys(onlineNode.metrics)) {
    assert.ok(
      golden.endpoints.nodeMetrics.keys.includes(key),
      `metrics 出现 hub 不认识的键 ${key}`,
    );
  }
  assertTypes(onlineNode.metrics, golden.endpoints.nodeMetrics, 'node.metrics');
}

// 离线节点：metrics 为 null，其余键不变。
{
  const offlineLive = liveBody.last_known['node-2'];
  const offlineNode = contract.buildMonitorNode({
    client: clients[1],
    live: offlineLive,
    online: false,
    lastReportMs: offlineLive.lastReportTime,
    traffic: contract.monitorTrafficWithTotals(offlineLive, totalsByClient['node-2']),
    nowMs: NOW,
    siteUrl: 'https://example.com',
  });
  assertExactKeys(offlineNode, golden.endpoints.node.keys, 'node(offline)');
  assertTypes(offlineNode, golden.endpoints.node, 'node(offline)');
  assert.equal(offlineNode.metrics, null);
  assert.equal(offlineNode.id, ID2, '离线节点的整数 id 必须与路由映射一致');
  assert.notEqual(ID1, ID2, '不同 UUID 的整数 id 不应冲突');
}

// metrics 行与 ping 行。
{
  const rows = contract.buildMonitorMetricsRows([recordRow], 60);
  assert.equal(rows.length, 1);
  assertExactKeys(rows[0], golden.endpoints.metricsRow.keys, 'metricsRow');
  assertTypes(rows[0], golden.endpoints.metricsRow, 'metricsRow');

  const { ping } = contract.buildMonitorPingRows({
    1: [{
      client: 'node-1', task_id: 1, time: new Date(NOW - 60_000).toISOString(),
      value: 42, sample_count: 10, loss_count: 3, min_latency: 30, max_latency: 55,
    }],
  }, 60);
  assert.equal(ping.length, 1);
  for (const key of golden.endpoints.pingRow.required) {
    assert.ok(key in ping[0], `pingRow 缺少 hub 要求的键 ${key}`);
  }
  for (const key of Object.keys(ping[0])) {
    assert.ok(golden.endpoints.pingRow.keys.includes(key), `pingRow 出现 hub 不认识的键 ${key}`);
  }
  assertTypes(ping[0], golden.endpoints.pingRow, 'pingRow');
}

// /nodes 响应与 WS 帧同形：{admin, nodes}。
{
  const body = await (await get('/nodes')).json();
  assertExactKeys(body, golden.endpoints.wsFrame.keys, 'nodesResponse/wsFrame');
  assertTypes(body, golden.endpoints.wsFrame, 'nodesResponse/wsFrame');
}

// metrics 响应包络。
{
  const body = await (await get(`/nodes/${ID1}/metrics?hours=6&points=1440`)).json();
  assertExactKeys(body, golden.endpoints.metricsEnvelope.keys, 'metricsEnvelope');
  assertTypes(body, golden.endpoints.metricsEnvelope, 'metricsEnvelope');
}

// 主题配置是任意 JSON 对象。
{
  themeConfigs.set('monitor_theme_config:hex', '{"accent":"#fff"}');
  clearThemeConfigCache();
  const body = await (await get('/themes/hex/config')).json();
  assert.equal(typeOf(body), golden.endpoints.themeConfig.type);
}

// --- 2. 单位与不变量 ---
{
  assert.ok(Number.isInteger(onlineNode.id), 'id 必须是整数');
  assert.equal(onlineNode.id, ID1, 'id 必须与路由的整数 id 一致');

  assert.ok(Number.isInteger(onlineNode.last_seen), 'last_seen 必须是整数秒');
  assert.ok(onlineNode.last_seen > 1e9 && onlineNode.last_seen < 1e10, 'last_seen 必须是 Unix 秒而不是毫秒');
  assert.equal(onlineNode.last_seen_ago, 0, '在线节点的 last_seen_ago 是 0');

  const offline = contract.buildMonitorNode({
    client: clients[1],
    live: liveBody.last_known['node-2'],
    online: false,
    lastReportMs: liveBody.last_known['node-2'].lastReportTime,
    traffic: contract.monitorTrafficWithTotals(liveBody.last_known['node-2'], totalsByClient['node-2']),
    nowMs: NOW,
    siteUrl: 'https://example.com',
  });
  assert.ok(Number.isInteger(offline.last_seen_ago), 'last_seen_ago 必须是整数秒');
  // 没有到期日的节点：expires_at / expires_in 都是 null（hub 同样给 null）。
  assert.equal(offline.expires_at, null);
  assert.equal(offline.expires_in, null);
  // 有到期日的节点：YYYY-MM-DD 与整数天数。
  assert.match(onlineNode.expires_at, /^\d{4}-\d{2}-\d{2}$/, 'expires_at 必须是 YYYY-MM-DD');
  assert.ok(Number.isInteger(onlineNode.expires_in), 'expires_in 必须是整数天');

  for (const [key, value] of Object.entries(onlineNode.metrics ?? {})) {
    if (key === 'load') continue;
    assert.equal(typeof value, 'number', `metrics.${key} 必须是数字`);
  }
  assert.ok(Array.isArray(onlineNode.metrics?.load), 'load 必须是三元数组');

  const step = 60;
  const rows = contract.buildMonitorMetricsRows([recordRow], step);
  for (const row of rows) {
    assert.equal(row.ts % step, 0, 'metrics.ts 必须落在 step 网格上');
  }
  const { ping } = contract.buildMonitorPingRows({
    1: [{ client: 'node-1', task_id: 1, time: new Date(NOW - 60_000).toISOString(), value: 42, sample_count: 1, loss_count: 0 }],
  }, step);
  for (const row of ping) {
    assert.equal(row.ts % step, 0, 'ping.ts 必须落在 step 网格上');
  }
}

// --- 3. 路由级：匿名隔离与缓存键稳定性 ---
{
  clearMonitorHistoryCache();
  adminAllowed = false;
  const anonResponse = await get('/nodes');
  assert.equal((await anonResponse.json()).admin, false, '匿名请求绝不能拿到 admin:true');
  assert.match(anonResponse.headers.get('Cache-Control') ?? '', /public/, '匿名 /nodes 可被共享缓存');

  adminAllowed = true;
  const adminResponse = await get('/nodes');
  const adminBody = await adminResponse.json();
  assert.equal(adminBody.admin, true, '管理员会话应拿到 admin:true');
  assert.match(adminResponse.headers.get('Cache-Control') ?? '', /no-store/, '带 admin 位的响应必须禁止共享缓存');
  adminAllowed = false;

  // 随机 query 不能改变内容（主题会带随机参数绕过浏览器缓存）。
  clearMonitorHistoryCache();
  const first = await (await get('/nodes?r=111')).json();
  const second = await (await get('/nodes?r=222')).json();
  assert.deepEqual(first, second, '随机 query 不应影响 /nodes 内容');

  // metrics 同理：随机 query 不应影响历史内容。
  const metricsFirst = await (await get(`/nodes/${ID1}/metrics?hours=6&points=1440&r=111`)).json();
  const metricsSecond = await (await get(`/nodes/${ID1}/metrics?hours=6&points=1440&r=222`)).json();
  assert.deepEqual(metricsFirst, metricsSecond, '随机 query 不应影响 metrics 内容');
}

// --- 4. WS 与 HTTP 对等 ---
{
  // /nodes 路径：buildMonitorNode(PublicClient)。
  const httpNode = contract.buildMonitorNode({
    client: onlineClient,
    live: onlineLive,
    online: true,
    lastReportMs: onlineLive.lastReportTime,
    traffic: contract.monitorTrafficWithTotals(onlineLive, totalsByClient['node-1']),
    nowMs: NOW,
    siteUrl: 'https://example.com',
  });
  // DO 帧路径：静态投影 + 实时条目（与 live-data.ts 的 buildMonitorFrameText 相同）。
  const wsNode = contract.buildMonitorNodeFromStatic({
    node: contract.monitorNodeStatic(onlineClient, contract.monitorTrafficWithTotals(onlineLive, totalsByClient['node-1'])),
    live: onlineLive,
    online: true,
    lastReportMs: onlineLive.lastReportTime,
    traffic: contract.monitorTrafficWithTotals(onlineLive, totalsByClient['node-1']),
    nowMs: NOW,
  });
  assert.deepEqual(wsNode, httpNode, 'WS 帧与 HTTP /nodes 对同一节点必须输出一致（同步漂移）');

  // 离线节点同样对等。
  const offlineLive = liveBody.last_known['node-2'];
  const httpOffline = contract.buildMonitorNode({
    client: clients[1],
    live: offlineLive,
    online: false,
    lastReportMs: offlineLive.lastReportTime,
    traffic: contract.monitorTrafficWithTotals(offlineLive, totalsByClient['node-2']),
    nowMs: NOW,
    siteUrl: 'https://example.com',
  });
  const wsOffline = contract.buildMonitorNodeFromStatic({
    node: contract.monitorNodeStatic(clients[1], contract.monitorTrafficWithTotals(offlineLive, totalsByClient['node-2'])),
    live: offlineLive,
    online: false,
    lastReportMs: offlineLive.lastReportTime,
    traffic: contract.monitorTrafficWithTotals(offlineLive, totalsByClient['node-2']),
    nowMs: NOW,
  });
  assert.deepEqual(wsOffline, httpOffline, '离线节点的 WS 帧与 HTTP 输出必须一致');

  // 对等输出的键集合也在 golden 里。
  assertExactKeys(wsNode, golden.endpoints.node.keys, 'node(ws)');
  assertExactKeys(wsOffline, golden.endpoints.node.keys, 'node(ws,offline)');
}

console.log('monitor contract golden tests passed');
