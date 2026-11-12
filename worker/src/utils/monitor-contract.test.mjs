import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

// 被测模块跑在 vm 上下文里，它造出来的对象原型与测试 realm 不同，
// deepStrictEqual 会比原型。JSON 往返一次再比，只比结构。
function eq(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

const {
  MONITOR_HISTORY_DAYS,
  monitorHours,
  monitorStep,
  monitorMetricsRateLimit,
  monitorGridTs,
  monitorBillingCycle,
  monitorExpiresIn,
  monitorDate,
  monitorMonthStart,
  monitorNumericId,
  buildMonitorMe,
  buildMonitorNode,
  buildMonitorMetricsRows,
  buildMonitorPingRows,
  buildMonitorProbes,
  monitorNodeStatic,
  monitorCountryCode,
  monitorTrafficWithTotals,
  monitorTaskIds,
  monitorTasksForClient,
} = createWorkerLoader().load('worker/src/utils/monitor-contract.ts');

// --- step: 预算公式与 preview/hub.js 的 history() 一致（hours 已 clamp 到 7d） ---
// budget = clamp(points || 1440, 60, 1440); step = 60 * max(1, ceil(hours*3600/60/budget))
assert.equal(monitorStep(6), 60);            // 默认 points=1440
assert.equal(monitorStep(6, 1440), 60);
assert.equal(monitorStep(24, 1440), 60);
assert.equal(monitorStep(24, 120), 720);
assert.equal(monitorStep(168, 1440), 420);   // 7d 仍是分钟步长
assert.equal(monitorStep(720, 1440), 420);   // 30d 档位被 clamp 到 7d
assert.equal(monitorStep(720, 60), 10080);   // 7d 窗口 + points 下限 60 → 2.8h 步长
assert.equal(monitorStep(1, 30), 60);        // points 低于下限被夹到 60
assert.equal(monitorStep(1, 99999), 60);     // ...高于上限夹到 1440

// hours clamp：默认 6，[1, 7d]
assert.equal(monitorHours(undefined), 6);
assert.equal(monitorHours('0'), 6);
assert.equal(monitorHours('-5'), 6);
assert.equal(monitorHours(1), 1);
assert.equal(monitorHours(720), 7 * 24);       // 30 天档位被收到 rollup 保留上限
assert.equal(monitorHours(99999), MONITOR_HISTORY_DAYS * 24);

// 每个请求的 step 都是 60s 的整数倍（hours 已 clamp 到 7d，hub 的 3600s 分支走不到）
for (const hours of [1, 6, 24, 72, 168, 169, 720]) {
  for (const points of [60, 120, 360, 720, 1440]) {
    const step = monitorStep(hours, points);
    assert.equal(step % 60, 0, `step ${step} 应是 60 的整数倍`);
    assert.ok(step >= 60, 'step 至少一分钟');
  }
}

// --- 网格吸附 ---
assert.equal(monitorGridTs(1700000000000, 60), Math.floor(1700000000 / 60) * 60);
assert.equal(monitorGridTs('2023-11-14T22:13:20.000Z', 60), Math.floor(1700000000 / 60) * 60);
assert.equal(monitorGridTs(0, 60), 0);
assert.equal(monitorGridTs('nonsense', 60), 0);

// --- billing_cycle：天数 -> monitor 字符串枚举 ---
assert.equal(monitorBillingCycle(30), 'monthly');
assert.equal(monitorBillingCycle(31), 'monthly');
assert.equal(monitorBillingCycle(92), 'quarterly');
assert.equal(monitorBillingCycle(184), 'semiannual');
assert.equal(monitorBillingCycle(365), 'yearly');
assert.equal(monitorBillingCycle(730), 'biennial');
assert.equal(monitorBillingCycle(1095), 'triennial');
assert.equal(monitorBillingCycle(-1), 'once');
assert.equal(monitorBillingCycle(0), 'monthly');
assert.equal(monitorBillingCycle(7), 'monthly');
assert.equal(monitorBillingCycle(1), '60m');

// --- 到期与日期 ---
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
assert.equal(monitorExpiresIn('2026-01-11T00:00:00.000Z', NOW), 10);
assert.equal(monitorExpiresIn('2025-12-30T00:00:00.000Z', NOW), -2);
assert.equal(monitorExpiresIn('', NOW), null);
assert.equal(monitorExpiresIn('nope', NOW), null);
assert.equal(monitorDate('2026-01-11T05:06:07.000Z'), '2026-01-11');
assert.equal(monitorDate(''), null);
assert.equal(monitorMonthStart(NOW), '2026-01-01');

// --- /api/me 形状 ---
const me = buildMonitorMe({ siteUrl: 'https://status.example', siteName: '我的监控', authed: false });
eq(me, {
  authed: false,
  github: false,
  history_days: 7,
  public_page: true,
  site: 'https://status.example',
  site_name: '我的监控',
});

// --- 节点投影 ---
const client = {
  uuid: 'node-1',
  name: '东京 · 软银',
  sort_order: 3,
  hidden: false,
  region: 'JP',
  group: '亚洲',
  public_remark: '三网直连',
  os: 'Debian GNU/Linux 13',
  kernel_version: '6.12.0',
  arch: 'x86_64',
  virtualization: 'kvm',
  cpu_name: 'AMD EPYC 9654',
  cpu_cores: 4,
  mem_total: 2 * 1024 ** 3,
  swap_total: 1024 ** 3,
  disk_total: 40 * 1024 ** 3,
  version: '1.2.0',
  billing_cycle: 30,
  currency: 'CNY',
  price: 29.9,
  expired_at: '2026-01-11T00:00:00.000Z',
  traffic_limit: 1024 * 1024 ** 3,
  traffic_limit_type: 'sum',
  traffic_reset_day: 1,
};

const onlineLive = {
  cpu: 12.5,
  load: 0.5, load5: 0.4, load15: 0.3,
  ram: 1024 ** 3, ram_total: 2 * 1024 ** 3,
  swap: 1024 ** 2, swap_total: 1024 ** 3,
  disk: 2 * 1024 ** 3, disk_total: 40 * 1024 ** 3,
  net_in: 12345, net_out: 6789,
  net_total_up: 5 * 1024 ** 3, net_total_down: 9 * 1024 ** 3,
  connections: 30, connections_udp: 6, process_count: 120,
  uptime: 86400, timestamp: NOW - 5000, lastReportTime: NOW - 3000,
};

const online = buildMonitorNode({
  client,
  live: onlineLive,
  online: true,
  lastReportMs: NOW - 3000,
  traffic: { month_rx: 9 * 1024 ** 3, month_tx: 5 * 1024 ** 3, day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  nowMs: NOW,
  siteUrl: 'https://status.example',
});

assert.equal(online.id, monitorNumericId('node-1'));
assert.ok(Number.isInteger(online.id), 'id 必须是整数（LuminaPlus 等主题会过滤非整数 id）');
assert.ok(online.id > 0);
assert.ok(!('uuid' in online), '内部关联字段 uuid 不能进公开响应');
assert.equal(online.name, '东京 · 软银');
assert.equal(online.sort, 3);
assert.equal(online.public, true);
assert.equal(online.online, true);
assert.equal(online.country, 'JP');
assert.equal(online.group, '亚洲');
assert.equal(online.public_remark, '三网直连');
assert.equal(online.kernel, '6.12.0');
assert.equal(online.virt, 'kvm');
assert.equal(online.cpu_name, 'AMD EPYC 9654');
assert.equal(online.cpu_cores, 4);
assert.equal(online.agent_version, '1.2.0');
assert.equal(online.billing_cycle, 'monthly');
assert.equal(online.expires_at, '2026-01-11');
assert.equal(online.expires_in, 10);
assert.equal(online.traffic_mode, 'sum');
assert.equal(online.traffic_reset_day, 1);
assert.equal(online.month_start, '2026-01-01');
assert.equal(online.month_rx, 9 * 1024 ** 3);
assert.equal(online.month_tx, 5 * 1024 ** 3);
assert.equal(online.month_used, 14 * 1024 ** 3);
assert.equal(online.last_seen, Math.floor((NOW - 3000) / 1000));
assert.equal(online.last_seen_ago, 0);

// 在线节点的 metrics 子对象
assert.ok(online.metrics);
assert.equal(online.metrics.cpu, 12.5);
eq(online.metrics.load, [0.5, 0.4, 0.3]);
assert.equal(online.metrics.mem_total, 2 * 1024 ** 3);
assert.equal(online.metrics.swap_used, 1024 ** 2);
assert.equal(online.metrics.net_rx, 12345);
assert.equal(online.metrics.tcp, 30);
assert.equal(online.metrics.procs, 120);
assert.equal(online.metrics.month_rx, 9 * 1024 ** 3);

// 离线节点：metrics 为 null，last_seen_ago 是已过去秒数
const offline = buildMonitorNode({
  client,
  live: { ...onlineLive, lastReportTime: NOW - 5 * 3600 * 1000 },
  online: false,
  lastReportMs: NOW - 5 * 3600 * 1000,
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(offline.online, false);
assert.equal(offline.metrics, null);
assert.equal(offline.last_seen_ago, 5 * 3600);

// 刚连上还没上报：last_seen=0 / last_seen_ago=null，metrics 也是 null（与 hub 的 fresh 一致）
const fresh = buildMonitorNode({
  client,
  live: null,
  online: true,
  lastReportMs: 0,
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(fresh.last_seen, 0);
assert.equal(fresh.last_seen_ago, null);
assert.equal(fresh.metrics, null);
// 流量缺省全 0
assert.equal(fresh.month_rx, 0);
assert.equal(fresh.total_rx, 0);
assert.equal(fresh.month_used, 0);

// --- metrics 行：封闭桶（均值 + 峰值 + 真实 minutes）---
const metricsTs = Math.floor(Date.parse('2026-01-01T00:01:30.000Z') / 1000);
const metricsRows = buildMonitorMetricsRows([
  {
    ts: metricsTs,
    samples: 2,
    minutes: 2,
    cpu: 10,
    cpu_max: 40,
    mem_used: 100,
    disk_used: 50,
    net_rx: 1000,
    net_tx: 500,
    net_rx_max: 4000,
    net_tx_max: 2000,
    swap_used: 5,
    tcp: 20,
    udp: 4,
    procs: 88,
  },
], 60);
assert.equal(metricsRows.length, 1);
// minutes 被夹在整桶分钟数内：step=60 时最多 1。
assert.equal(metricsRows[0].minutes, 1);
assert.equal(metricsRows[0].cpu, 10);
assert.equal(metricsRows[0].cpu_max, 40);
assert.equal(metricsRows[0].net_rx, 1000);
assert.equal(metricsRows[0].net_rx_max, 4000);
assert.equal(metricsRows[0].net_tx_max, 2000);
assert.equal(metricsRows[0].tcp, 20);
assert.equal(metricsRows[0].procs, 88);
assert.equal(metricsRows[0].ts, monitorGridTs(metricsTs, 60));
for (const key of ['ts', 'minutes', 'cpu', 'cpu_max', 'mem_used', 'disk_used', 'net_rx', 'net_tx', 'net_rx_max', 'net_tx_max', 'swap_used', 'tcp', 'udp', 'procs']) {
  assert.ok(key in metricsRows[0], `metrics 行缺字段 ${key}`);
}

// 宽桶按 SQL 给的 minutes 原样保留（不超过 step/60）。
const wideRows = buildMonitorMetricsRows([
  {
    ts: metricsTs,
    samples: 5,
    minutes: 9,
    cpu: 12,
    cpu_max: 30,
    mem_used: 1,
    disk_used: 2,
    net_rx: 3,
    net_tx: 4,
    net_rx_max: 5,
    net_tx_max: 6,
    swap_used: 0,
    tcp: 1,
    udp: 2,
    procs: 3,
  },
], 600);
assert.equal(wideRows[0].minutes, 9);

// 非法 ts 被丢弃。
assert.equal(buildMonitorMetricsRows([{ ...wideRows[0], ts: 0 }], 60).length, 0);

// --- 静态投影 / 实时条目合入 day_* / total_* ---
const totals = { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 };
const staticNode = monitorNodeStatic(client, totals);
assert.equal(staticNode.day_rx, 100);
assert.equal(staticNode.day_tx, 50);
assert.equal(staticNode.total_rx, 1e12);
assert.equal(staticNode.total_tx, 5e11);

const withTotals = monitorTrafficWithTotals(onlineLive, totals);
assert.equal(withTotals.month_rx, 9 * 1024 ** 3);
assert.equal(withTotals.day_rx, 100);
assert.equal(withTotals.total_tx, 5e11);

// --- 契约 country 只输出 ISO 3166-1 alpha-2 ---
// 主题（如 monitor-theme-hex 的 regionKey）只认两位大写码，否则全部归到「未知地区」。
// cf-vps 的 region 是展示串，国家码在最后一段；已是两位码时原样透传。
assert.equal(monitorCountryCode('JP'), 'JP');
assert.equal(monitorCountryCode('Kwai Chung, HK'), 'HK');
assert.equal(monitorCountryCode('Kwai Chung, Hong Kong, HK'), 'HK');
assert.equal(monitorCountryCode('  City ,  Region ,  sg '), 'SG');
assert.equal(monitorCountryCode('Singapore'), '', '没有国家码的展示串不应猜测');
assert.equal(monitorCountryCode('未知'), '');
assert.equal(monitorCountryCode(''), '');
assert.equal(monitorCountryCode(null), '');
assert.equal(monitorCountryCode(undefined), '');
assert.equal(monitorCountryCode(42), '');
assert.equal(monitorCountryCode('ZZ'), '', 'ISO 未知码按未知地区处理');
assert.equal(monitorCountryCode('XX'), '', '占位码按未知地区处理');
assert.equal(monitorCountryCode('T1'), '', 'Tor 等非 ISO 值不应透传');

// 静态投影吃的是同一条规则：展示串也不会漏进契约。
assert.equal(monitorNodeStatic({ ...client, region: 'Kwai Chung, HK' }, totals).country, 'HK');
assert.equal(monitorNodeStatic({ ...client, region: 'Singapore' }, totals).country, '');

// --- ping 行 ---
const pingResult = buildMonitorPingRows({
  1: [
    { client: 'node-1', task_id: 1, time: '2026-01-01T00:01:00.000Z', value: 42, min_latency: 30, max_latency: 55 },
    { client: 'node-1', task_id: 1, time: '2026-01-01T00:02:00.000Z', value: -1 },
  ],
}, 3600);
assert.equal(pingResult.ping.length, 2);
assert.equal(pingResult.ping[0].latency, 42);
eq(pingResult.ping[0].band, [30, 55]);   // step>60 才有 band
assert.equal(pingResult.ping[1].latency, null);
assert.equal(pingResult.ping[1].loss, 100);
assert.equal(pingResult.ping[1].band, undefined);
eq(pingResult.loss, {});

// step<=60 不带 band
const smallStep = buildMonitorPingRows({
  2: [{ client: 'n', task_id: 2, time: '2026-01-01T00:01:00.000Z', value: 10, min_latency: 5, max_latency: 20 }],
}, 60);
assert.equal(smallStep.ping[0].band, undefined);

// 空输入
eq(buildMonitorPingRows(null, 60), { ping: [], loss: {} });

// 按 ts 再按 task_id 排序
const sorted = buildMonitorPingRows({
  3: [{ client: 'n', task_id: 3, time: '2026-01-01T00:05:00.000Z', value: 1 }],
  1: [{ client: 'n', task_id: 1, time: '2026-01-01T00:05:00.000Z', value: 2 }],
}, 60);
eq(sorted.ping.map(row => row.task_id), [1, 3]);
const prioritySorted = buildMonitorPingRows({
  3: [{ client: 'n', task_id: 3, time: '2026-01-01T00:05:00.000Z', value: 1 }],
  1: [{ client: 'n', task_id: 1, time: '2026-01-01T00:05:00.000Z', value: 2 }],
}, 60, new Map([[3, 0], [1, 1]]));
eq(prioritySorted.ping.map(row => row.task_id), [3, 1], 'same-timestamp rows follow backend task priority');

// --- probes / task ids ---
eq(buildMonitorProbes([{ id: 1, name: '电信' }, { id: 2, name: '联通' }]), { 1: '电信', 2: '联通' });
eq(buildMonitorProbes([{ name: '无 id' }]), {});
eq(monitorTaskIds([{ id: 1 }, { id: 2 }, { id: 2 }, { id: 0 }, { id: -3 }, {}]), [1, 2]);
eq(monitorTasksForClient([
  { id: 1, name: '电信', clients: ['node'], all_clients: false, sort_order: 2 },
  { id: 2, name: '移动', clients: [], all_clients: false, sort_order: 0 },
  { id: 3, name: '联通', clients: ['node'], all_clients: false, sort_order: 1 },
], 'node').map(task => task.id), [3, 1], 'filter unassigned tasks and honor backend order');

// --- 历史限流额度：随节点数放大，但有上下限 ---
{
  // 主题按节点扇出（5s 一轮 ≈ 12 次/分钟/节点，卡片级刷新叠加后实测最高 22）。
  assert.ok(monitorMetricsRateLimit(30) >= 30 * 22);
  assert.ok(monitorMetricsRateLimit(30) > 380, '30 节点整页实测约 380 次/分钟');
  assert.ok(monitorMetricsRateLimit(100) >= 100 * 12);
  // 单调不减、且不越界。
  assert.ok(monitorMetricsRateLimit(30) < monitorMetricsRateLimit(100));
  assert.ok(monitorMetricsRateLimit(0) >= 60);
  assert.ok(monitorMetricsRateLimit(0) <= monitorMetricsRateLimit(1));
  assert.ok(monitorMetricsRateLimit(1_000_000) <= 3000);
  // 非数字/负数走下限，不产生 NaN 或负额度。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const value = monitorMetricsRateLimit(bad);
    assert.ok(Number.isFinite(value) && value >= 60, `额度不应为 ${value}`);
  }
}

// --- 数字 id：稳定、安全整数、互不碰撞 ---
{
  // 同一个 UUID 永远映射到同一个 id（跨进程/重启也不变）。
  assert.equal(monitorNumericId('9f1c4e2a-7b3d-4f0e-9a11-2c3d4e5f6a7b'), monitorNumericId('9f1c4e2a-7b3d-4f0e-9a11-2c3d4e5f6a7b'));
  // 必须是正整数、JS 安全整数：JSON 往返不丢精度，也能进 URL。
  const uuids = Array.from({ length: 500 }, (_, i) => `node-${i}-${(i * 7919).toString(16)}`);
  const ids = uuids.map(monitorNumericId);
  for (const id of ids) {
    assert.ok(Number.isInteger(id), `id 不是整数：${id}`);
    assert.ok(id > 0, `id 不是正数：${id}`);
    assert.ok(Number.isSafeInteger(id), `id 超出安全整数范围：${id}`);
    assert.equal(JSON.parse(JSON.stringify(id)), id);
  }
  assert.equal(new Set(ids).size, ids.length, '500 个 UUID 不应出现碰撞');
  // 空串也有定义（正整数，避免主题里的 `if (!id)` 误判）。
  const emptyId = monitorNumericId('');
  assert.ok(Number.isInteger(emptyId) && emptyId > 0, `空串的 id 应是正整数，实际 ${emptyId}`);
}

console.log('monitor-contract tests passed');
