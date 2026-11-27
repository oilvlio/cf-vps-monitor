/**
 * monitor 派生路径的对等测试。
 *
 * 同一行原始 client 数据（含 token / token_hash / 内网 IP / 隐藏节点）必须在这
 * 两条路径上产出完全一致的 monitor node JSON：
 * - Worker /api/nodes：getPublicClientsSnapshot（toPublicClient 白名单 → 过滤
 *   hidden → 排序）→ buildMonitorNode；
 * - DO /api/ws 帧：buildMonitorStaticNodesFromClients（toPublicClient + hidden
 *   过滤 + 同一排序）→ buildMonitorNodeFromStatic。
 *
 * 并断言两条路径的输出都不携带 token / token_hash / ipv4 / hidden 等私有字段，
 * 隐藏节点绝不出现在帧里。fix 与 /api/nodes、buildMonitorFrameText 的实参口径
 * 保持一致（见 do/live-data.ts 与 monitor/services/nodes.ts）。
 */
import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader({ db: {} });
const contract = loader.load('worker/src/monitor/contract.ts');
const publicClient = loader.load('worker/src/utils/public-client.ts');

const NOW = Date.parse('2027-06-01T00:00:00.000Z');
const GIB = 1024 ** 3;

// 完整的 db.Client 原始行：带 token、内网 IP、备注、IP 标签，故意留一个 hidden
// 节点和一个没有 sort_order 的节点（排序退化到 0）。
const RAW_CLIENTS = [
  {
    uuid: 'node-1', name: '东京', sort_order: 2, hidden: false,
    region: '东京, 东京都, JP', group: '亚洲', public_remark: '直连', remark: '私人备注',
    os: 'Debian', kernel_version: '6.12.0', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'EPYC', cpu_cores: 2, gpu_name: '',
    mem_total: 2 * GIB, swap_total: GIB, disk_total: 40 * GIB,
    version: '1.2.0', billing_cycle: 30, currency: 'CNY', price: 29.9,
    auto_renewal: true, expired_at: '2027-12-01T00:00:00.000Z',
    traffic_limit: 1024 * GIB, traffic_limit_type: 'max', traffic_reset_day: 5,
    token: 'agent-token-secret', token_hash: 'sha256:deadbeef',
    ipv4: '10.0.0.7', ipv6: 'fe80::1',
    tags: '生产;ipv4;直连',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z',
  },
  {
    uuid: 'node-2', name: '法兰克福', hidden: false,
    region: 'DE', group: '', public_remark: '',
    os: 'Alpine', kernel_version: '6.6', arch: 'aarch64', virtualization: 'lxc',
    cpu_name: 'Ampere', cpu_cores: 4, gpu_name: '',
    mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    version: '1.0.0', billing_cycle: 365, currency: 'USD', price: 5,
    auto_renewal: false, expired_at: '',
    traffic_limit: 0, traffic_limit_type: 'sum', traffic_reset_day: 1,
    token: 'other-token-secret', token_hash: 'sha256:feedface',
    ipv4: '198.51.100.9', ipv6: '',
    tags: '',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z',
  },
  {
    // 隐藏节点：留在元数据里，但两条路径都必须把它滤掉。
    uuid: 'node-hidden', name: '隐藏节点', sort_order: 1, hidden: true,
    region: 'JP', group: '', public_remark: '',
    os: 'Debian', kernel_version: '6.1', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'Xeon', cpu_cores: 1, gpu_name: '',
    mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    version: '1.0.0', billing_cycle: 30, currency: 'CNY', price: 5,
    auto_renewal: false, expired_at: '',
    traffic_limit: 0, traffic_limit_type: 'sum', traffic_reset_day: 1,
    token: 'hidden-token-secret', token_hash: 'sha256:cafebabe',
    ipv4: '192.168.1.5', ipv6: '',
    tags: '',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z',
  },
];

// 实时条目：node-1 在线（data），node-2 离线（last_known）。
const LIVE = {
  online: ['node-1'],
  data: {
    'node-1': {
      cpu: 12.5, load: 0.5, load5: 0.4, load15: 0.3,
      ram: GIB, ram_total: 3 * GIB, swap: 0, swap_total: 0,
      disk: 2 * GIB, disk_total: 42 * GIB,
      net_in: 111, net_out: 222,
      net_total_up: 5 * GIB, net_total_down: 9 * GIB,
      connections: 30, connections_udp: 6, process_count: 120,
      uptime: 3600, timestamp: NOW - 5000, lastReportTime: NOW - 3000,
    },
  },
  last_known: {
    'node-2': {
      cpu: 0, net_total_up: GIB, net_total_down: 2 * GIB,
      timestamp: NOW - 5 * 3600 * 1000, lastReportTime: NOW - 5 * 3600 * 1000,
    },
  },
};

const TOTALS = {
  'node-1': { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  'node-2': { day_rx: 0, day_tx: 0, total_rx: 2e9, total_tx: 1e9 },
  'node-hidden': { day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 },
};

/** Worker /api/nodes 路径（getPublicClientsSnapshot → loadNodes 的投影口径）。 */
function workerPathNodes(rows) {
  const clients = rows
    .map(row => publicClient.toPublicClient(row))
    .filter(client => client.uuid && !client.hidden)
    .sort((left, right) => {
      const orderDiff = (left.sort_order || 0) - (right.sort_order || 0);
      return orderDiff !== 0 ? orderDiff : left.name.localeCompare(right.name);
    });
  return clients.map((client) => {
    const live = LIVE.data[client.uuid] ?? LIVE.last_known[client.uuid] ?? null;
    return contract.buildMonitorNode({
      client,
      live,
      online: LIVE.online.includes(client.uuid),
      lastReportMs: typeof live?.lastReportTime === 'number' ? live.lastReportTime : 0,
      traffic: contract.monitorTrafficWithTotals(live, TOTALS[client.uuid]),
      nowMs: NOW,
      siteUrl: 'https://example.com',
    });
  });
}

/** DO /api/ws 帧路径（buildMonitorStaticNodes → buildMonitorFrameText 的口径）。 */
function doPathNodes(rows) {
  return contract.buildMonitorStaticNodesFromClients(rows, TOTALS).map((node) => {
    const live = LIVE.data[node.uuid] ?? LIVE.last_known[node.uuid] ?? null;
    const online = LIVE.online.includes(node.uuid);
    return contract.buildMonitorNodeFromStatic({
      node,
      live,
      online,
      lastReportMs: typeof live?.lastReportTime === 'number' ? live.lastReportTime : 0,
      // 与 buildMonitorFrameText 一致：day_*/total_* 来自静态投影里的 totals。
      traffic: contract.monitorTrafficWithTotals(live, {
        day_rx: node.day_rx,
        day_tx: node.day_tx,
        total_rx: node.total_rx,
        total_tx: node.total_tx,
      }),
      nowMs: NOW,
    });
  });
}

const httpNodes = workerPathNodes(RAW_CLIENTS);
const wsNodes = doPathNodes(RAW_CLIENTS);

// 1. 对等：同一行原始数据走两条路径，输出 JSON 必须完全相等。
// （deepStrictEqual 会对 vm 加载器里产出的数组原型较真，这里统一过 JSON 往返。）
assert.equal(
  JSON.stringify(wsNodes),
  JSON.stringify(httpNodes),
  'DO 静态投影路径与 Worker 快照路径对同一行数据必须产出一致的 node JSON',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(wsNodes)),
  JSON.parse(JSON.stringify(httpNodes)),
);

// 2. 私有字段绝不进输出：token / token_hash / ipv4 / 内部备注 / hidden 位都不在帧里。
const frame = JSON.stringify({ admin: false, nodes: wsNodes });
for (const forbidden of ['"token"', 'ipv4', 'ipv6', '"remark":', '"hidden"']) {
  assert.ok(!frame.includes(forbidden), `帧里不能出现 ${forbidden}（派生路径泄漏）`);
}

// 3. 隐藏节点被两条路径同时过滤；没有 sort_order 的节点排序退化到 0（排最前）。
assert.deepEqual(
  JSON.parse(JSON.stringify(wsNodes.map(node => node.name))),
  ['法兰克福', '东京'],
  'hidden 节点必须被过滤，缺 sort_order 的节点排在前面',
);
assert.ok(!frame.includes('隐藏节点'));

// 4. 静态字段的口径抽查（两边同值，只查一份）。
const tokyo = wsNodes.find(node => node.name === '东京');
assert.equal(tokyo.country, 'JP', 'region 末段的国家码必须被识别');
assert.equal(tokyo.billing_cycle, 'monthly');
assert.equal(tokyo.traffic_mode, 'max');
assert.equal(tokyo.month_rx, 9 * GIB);
assert.equal(tokyo.month_tx, 5 * GIB);
assert.equal(tokyo.month_used, Math.max(9 * GIB, 5 * GIB), 'traffic_mode=max 取较大一边');
assert.equal(tokyo.day_rx, TOTALS['node-1'].day_rx);
assert.equal(tokyo.total_tx, TOTALS['node-1'].total_tx);
assert.equal(tokyo.last_seen_ago, 3, '在线节点也按最后一次上报算已过去秒数');
assert.equal(tokyo.online, true);
// 顶层容量与实时 metrics 同源（两条路径都走共享投影函数）。
assert.equal(tokyo.mem_total, tokyo.metrics.mem_total);
assert.equal(tokyo.swap_total, tokyo.metrics.swap_total);
assert.equal(tokyo.disk_total, tokyo.metrics.disk_total);
assert.equal(tokyo.mem_total, 3 * GIB, '在线时顶层容量取实时报告');
assert.equal(tokyo.swap_total, 0, '在线时实时 0 覆盖库里旧值');
assert.equal(tokyo.disk_total, 42 * GIB);

const frankfurt = wsNodes.find(node => node.name === '法兰克福');
assert.equal(frankfurt.country, 'DE');
assert.equal(frankfurt.online, false);
assert.equal(frankfurt.metrics, null);
assert.equal(frankfurt.month_rx, 2 * GIB, '离线节点保留 last_known 的周期流量');
assert.equal(frankfurt.last_seen_ago, 5 * 3600);

console.log('monitor contract parity tests passed');
