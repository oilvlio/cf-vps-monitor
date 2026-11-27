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
  monitorTrafficMode,
  monitorMonthUsed,
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
} = createWorkerLoader().load('worker/src/monitor/contract.ts');

// --- step: 预算公式与 hub 的 span()（api.rs）一致 ---
// budget = clamp(points || 1440, 60, 1440)
// hours <= 7d: step = 60 * max(1, ceil(hours*3600/60/budget))
// hours >  7d: 读 30 分钟 rollup，输出步长仍按 hub 契约取整小时
//             step = 3600 * max(1, ceil(hours/budget))
assert.equal(monitorStep(6), 60);            // 默认 points=1440
assert.equal(monitorStep(6, 1440), 60);
assert.equal(monitorStep(24, 1440), 60);
assert.equal(monitorStep(24, 120), 720);
assert.equal(monitorStep(168, 1440), 420);   // 7d 仍是分钟步长（DETAIL_DAYS 边界，含）
assert.equal(monitorStep(168, 60), 10080);   // 7d 窗口 + points 下限 60 → 2.8h 步长
assert.equal(monitorStep(169, 1440), 3600);  // 刚过 7d：小时级，整小时步长
assert.equal(monitorStep(720, 1440), 3600);  // 30d：720 个 1 小时点，与 hub 一致
assert.equal(monitorStep(720, 720), 3600);
assert.equal(monitorStep(720, 60), 43200);   // 30d 窗口 + points 下限 60 → 12h 步长
assert.equal(monitorStep(1, 30), 60);        // points 低于下限被夹到 60
assert.equal(monitorStep(1, 99999), 60);     // ...高于上限夹到 1440

// hours clamp：默认 6，[1, 30d]
assert.equal(monitorHours(undefined), 6);
assert.equal(monitorHours('0'), 6);
assert.equal(monitorHours('-5'), 6);
assert.equal(monitorHours(1), 1);
assert.equal(MONITOR_HISTORY_DAYS, 30, 'history_days 与 hub 默认保留期一致');
assert.equal(monitorHours(720), 30 * 24);      // 30 天档位在保留期内，原样返回
assert.equal(monitorHours(99999), MONITOR_HISTORY_DAYS * 24);  // 超出保留期被收到上限

// 每个请求的 step 都是 60s 的整数倍；超过 7d 的窗口是整小时倍数，30 分钟 rollup 桶
// 可以按整倍数重组，且 step 不超过 SQL 桶宽上限（一天）。
for (const hours of [1, 6, 24, 72, 168, 169, 336, 720, 99999]) {
  for (const points of [60, 120, 360, 720, 1440]) {
    const step = monitorStep(hours, points);
    assert.equal(step % 60, 0, `step ${step} 应是 60 的整数倍`);
    assert.ok(step >= 60, 'step 至少一分钟');
    assert.ok(step <= 86400, `step ${step} 不能超过 SQL 桶宽上限（一天）`);
    if (hours > 168) assert.equal(step % 3600, 0, `hours=${hours} 的 step ${step} 应是整小时`);
    // 点数预算：窗口内的桶数不超过预算（向上取整后只会更少）。
    const windowHours = Math.min(hours, 720);
    assert.ok((windowHours * 3600) / step <= Math.max(60, Math.min(points, 1440)) + 1e-9, `hours=${hours} points=${points} 超出点数预算`);
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
// 非整月周期映射成 <n>m（Math.round(days / 30.4375)），monitor 与 LuminaPlus 都按月数解析它。
assert.equal(monitorBillingCycle(60), '2m');
assert.equal(monitorBillingCycle(150), '5m');
assert.equal(monitorBillingCycle(400), '13m');
assert.equal(monitorBillingCycle(360), 'yearly');
// 小于一个月的周期 monitor 没有对应项，按原样透传天数（LuminaPlus 按 days 摊销）。
assert.equal(monitorBillingCycle(7), '7');
assert.equal(monitorBillingCycle(1), '1');

// --- 到期与日期 ---
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
assert.equal(monitorExpiresIn('2026-01-11T00:00:00.000Z', NOW), 10);
assert.equal(monitorExpiresIn('2025-12-30T00:00:00.000Z', NOW), -2);
assert.equal(monitorExpiresIn('', NOW), null);
assert.equal(monitorExpiresIn('nope', NOW), null);
// 日历天：到期时间带时分秒时按日期差算，不按毫秒差向上取整。
assert.equal(
  monitorExpiresIn('2026-01-11T23:00:00.000Z', Date.parse('2026-01-10T13:00:00.000Z')),
  1,
  '到期日与今天是日期差 1 天，不是剩余 34 小时向上取整成 2 天',
);
assert.equal(
  monitorExpiresIn('2026-01-11T23:59:59.000Z', Date.parse('2026-01-11T00:00:01.000Z')),
  0,
  '同一天到期是 0 天，不因不足 24 小时算成 1 天',
);
assert.equal(monitorDate('2026-01-11T05:06:07.000Z'), '2026-01-11');
assert.equal(monitorDate('2026-01-11T00:00:00+00:00'), '2026-01-11');
assert.equal(monitorDate('2026-01-11T23:00:00-05:00'), '2026-01-11', '日期部分不做时区换算');
assert.equal(monitorDate('2026-02-30'), null, '不存在的日期不能进位成 3 月');
assert.equal(monitorDate(''), null);
assert.equal(monitorMonthStart(NOW), '2026-01-01');
// month_start 按节点的 traffic_reset_day 取当前计费周期起始日（UTC 日期）。
assert.equal(monitorMonthStart(NOW, 1), '2026-01-01');
// 今天（2026-01-01）早于本月重置日时，取上个周期的起始日。
assert.equal(monitorMonthStart(NOW, 15), '2025-12-15');
assert.equal(monitorMonthStart(NOW, 31), '2025-12-31');
// 重置日大于当月天数时夹到月末（monitor db.rs 的 period_start 规则）。
assert.equal(
  monitorMonthStart(Date.parse('2026-02-10T00:00:00.000Z'), 30),
  '2026-01-30',
  '2 月 10 日还没到本月重置日，周期开始于 1 月 30 日',
);
assert.equal(monitorMonthStart(Date.parse('2026-02-28T12:00:00.000Z'), 31), '2026-02-28');
assert.equal(monitorMonthStart(Date.parse('2028-02-29T12:00:00.000Z'), 31), '2028-02-29');
assert.equal(monitorMonthStart(Date.parse('2026-04-30T12:00:00.000Z'), 31), '2026-04-30');
assert.equal(
  monitorMonthStart(Date.parse('2026-03-01T00:00:00.000Z'), 31),
  '2026-02-28',
  '3 月 1 日还没到 31 日，周期开始于 2 月末而不是 1 月 31 日',
);

// --- traffic_mode 映射与 month_used 按模式取值 ---
assert.equal(monitorTrafficMode('sum'), 'sum');
assert.equal(monitorTrafficMode('max'), 'max');
assert.equal(monitorTrafficMode('up'), 'up');
assert.equal(monitorTrafficMode('down'), 'down');
// monitor 没有的取值（min / unlimited / bandwidth:* / 空值）归到 sum。
assert.equal(monitorTrafficMode('min'), 'sum');
assert.equal(monitorTrafficMode('unlimited'), 'sum');
assert.equal(monitorTrafficMode('bandwidth:100Mbps'), 'sum');
assert.equal(monitorTrafficMode(''), 'sum');
assert.equal(monitorTrafficMode(null), 'sum');

const trafficPair = { month_rx: 9, month_tx: 5 };
assert.equal(monitorMonthUsed(trafficPair, 'sum'), 14);
assert.equal(monitorMonthUsed(trafficPair, 'max'), 9);
assert.equal(monitorMonthUsed(trafficPair, 'up'), 5);
assert.equal(monitorMonthUsed(trafficPair, 'down'), 9);
// 未知模式按 monitor 的 match 兜底：sum。
assert.equal(monitorMonthUsed(trafficPair, 'min'), 14);

// --- /api/me 形状 ---
const me = buildMonitorMe({ siteUrl: 'https://status.example', siteName: '我的监控', authed: false });
eq(me, {
  authed: false,
  github: false,
  history_days: 30,
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
// 夹具的上报时间比 NOW（1 月 1 日 00:00）早 3 秒，仍属于 12 月那个周期；
// month_start 跟数据走，不会因为请求时刻已经跨月就提前换周期。
assert.equal(online.month_start, '2025-12-01');
assert.equal(online.month_rx, 9 * 1024 ** 3);
assert.equal(online.month_tx, 5 * 1024 ** 3);
assert.equal(online.month_used, 14 * 1024 ** 3);
// 非默认模式：month_used 按模式取值（up 只算上行；max 取较大一边）。
const upMode = buildMonitorNode({
  client: { ...client, traffic_limit_type: 'up' },
  live: onlineLive,
  online: true,
  lastReportMs: NOW - 3000,
  traffic: { month_rx: 9 * 1024 ** 3, month_tx: 5 * 1024 ** 3, day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(upMode.traffic_mode, 'up');
assert.equal(upMode.month_used, 5 * 1024 ** 3);
// cf-vps 独有的 min / bandwidth:* 归到 sum。
assert.equal(
  buildMonitorNode({
    client: { ...client, traffic_limit_type: 'bandwidth:100Mbps' },
    live: onlineLive,
    online: true,
    lastReportMs: NOW - 3000,
    traffic: { month_rx: 9 * 1024 ** 3, month_tx: 5 * 1024 ** 3, day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
    nowMs: NOW,
    siteUrl: 'https://status.example',
  }).traffic_mode,
  'sum',
);
assert.equal(online.last_seen, Math.floor((NOW - 3000) / 1000));
assert.equal(online.last_seen_ago, 3, '在线也按最后一次上报算，3 秒前上报就是 3 秒');

// 在线但上报已经停了（连接还挂着）：last_seen_ago 是真实间隔，不能强行归零。
const stalled = buildMonitorNode({
  client,
  live: onlineLive,
  online: true,
  lastReportMs: NOW - 5 * 3600 * 1000,
  traffic: { month_rx: 9 * 1024 ** 3, month_tx: 5 * 1024 ** 3, day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(stalled.online, true);
assert.equal(stalled.last_seen_ago, 5 * 3600);

// 在线节点的 metrics 子对象
assert.ok(online.metrics);
assert.equal(online.metrics.cpu, 12.5);
eq(online.metrics.load, [0.5, 0.4, 0.3]);
// 探针显式报 load: null（lxcfs 未虚拟化 loadavg 等）时，load 键整个缺省，
// 与 monitor 一致；不能伪装成 [0,0,0]。
const loadUnavailable = buildMonitorNode({
  client,
  live: { ...onlineLive, load: null, load5: null, load15: null },
  online: true,
  lastReportMs: NOW - 3000,
  traffic: { month_rx: 9 * 1024 ** 3, month_tx: 5 * 1024 ** 3, day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.ok(loadUnavailable.metrics);
assert.equal('load' in loadUnavailable.metrics, false, 'load 不可用时该键必须缺省');
assert.equal(online.metrics.mem_total, 2 * 1024 ** 3);
assert.equal(online.metrics.swap_used, 1024 ** 2);
assert.equal(online.metrics.net_rx, 12345);
assert.equal(online.metrics.tcp, 30);
assert.equal(online.metrics.procs, 120);
assert.equal(online.metrics.month_rx, 9 * 1024 ** 3);

// 顶层容量与 metrics 同源：在线时用实时报告（磁盘扩容 / swapoff 立刻反映），
// 离线时才退回库里存的值（与 monitor node_view 的 live() 一致）。
const resized = buildMonitorNode({
  client,
  live: {
    ...onlineLive,
    ram_total: 4 * 1024 ** 3,
    swap_total: 0,
    disk_total: 80 * 1024 ** 3,
  },
  online: true,
  lastReportMs: NOW - 3000,
  traffic: { month_rx: 1, month_tx: 2, day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 },
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(resized.mem_total, 4 * 1024 ** 3);
assert.equal(resized.swap_total, 0, 'swapoff 报告 0 就是 0，不能退回旧值');
assert.equal(resized.disk_total, 80 * 1024 ** 3);
assert.equal(resized.metrics.mem_total, resized.mem_total, '顶层与 metrics 必须是同一个数');
assert.equal(resized.metrics.swap_total, resized.swap_total);
assert.equal(resized.metrics.disk_total, resized.disk_total);
// 离线节点没有实时条目可用：容量保留库里最后存的值。
const offlineResized = buildMonitorNode({
  client,
  live: { ...onlineLive, ram_total: 4 * 1024 ** 3, swap_total: 0, disk_total: 80 * 1024 ** 3 },
  online: false,
  lastReportMs: NOW - 5 * 3600 * 1000,
  nowMs: NOW,
  siteUrl: 'https://status.example',
});
assert.equal(offlineResized.mem_total, 2 * 1024 ** 3);
assert.equal(offlineResized.swap_total, 1024 ** 3);
assert.equal(offlineResized.disk_total, 40 * 1024 ** 3);

// 周期起点以最后一次上报为参考：month_rx/tx 是那次上报时切出来的合计，
// 节点离线后周期不会自己向前滚。
const stalePeriod = buildMonitorNode({
  client: { ...client, traffic_reset_day: 15 },
  live: { ...onlineLive, timestamp: Date.parse('2026-01-20T00:00:00.000Z') },
  online: false,
  lastReportMs: Date.parse('2026-01-20T00:00:00.000Z'),
  traffic: { month_rx: 1, month_tx: 2, day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 },
  nowMs: Date.parse('2026-02-20T00:00:00.000Z'),
  siteUrl: 'https://status.example',
});
assert.equal(stalePeriod.month_start, '2026-01-15', '按 1 月 20 日那次上报算，不是按 2 月 20 日的请求时间');

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
// 桶内 10 个样本丢了 3 个：latency 取中位数，loss 按 ceil(100*3/10)=30 带上；
// 整桶丢包仍是 {latency: null, loss: 100}；窗口丢包率 = 100*5/12，不取整。
const pingResult = buildMonitorPingRows({
  1: [
    {
      client: 'node-1', task_id: 1, time: '2026-01-01T00:01:00.000Z',
      value: 42, sample_count: 10, loss_count: 3, min_latency: 30, max_latency: 55,
    },
    {
      client: 'node-1', task_id: 1, time: '2026-01-01T01:02:00.000Z',
      value: -1, sample_count: 2, loss_count: 2,
    },
  ],
}, 3600);
assert.equal(pingResult.ping.length, 2);
assert.equal(pingResult.ping[0].latency, 42);
assert.equal(pingResult.ping[0].loss, 30, '部分丢包的桶必须带 loss');
eq(pingResult.ping[0].band, [30, 55]);   // hi > lo 才有 band
assert.equal(pingResult.ping[1].latency, null);
assert.equal(pingResult.ping[1].loss, 100);
assert.equal(pingResult.ping[1].band, undefined);
eq(pingResult.loss, { 1: (100 * 5) / 12 }, '窗口丢包率按样本数加权，且不取整');

// latency 向下取整到整数毫秒（monitor 的 Tally::median 是整数除法）。
const fractionalLatency = buildMonitorPingRows({
  4: [{ client: 'n', task_id: 4, time: '2026-01-01T00:01:00.000Z', value: 42.7, sample_count: 3, loss_count: 0 }],
}, 60);
assert.equal(fractionalLatency.ping[0].latency, 42);

// 零丢包的桶不写 loss，也不进窗口字典；1/180 的丢包向上取整为 1，不能被截断成 0。
const lossRounding = buildMonitorPingRows({
  2: [
    { client: 'n', task_id: 2, time: '2026-01-01T00:01:00.000Z', value: 20, sample_count: 180, loss_count: 1 },
    { client: 'n', task_id: 2, time: '2026-01-01T00:02:00.000Z', value: 21, sample_count: 180, loss_count: 0 },
  ],
}, 60);
assert.equal(lossRounding.ping[0].loss, 1, 'ceil 保证 1/180 不会显示成 0');
assert.equal(lossRounding.ping[1].loss, undefined, '零丢包不应带 loss 字段');
eq(lossRounding.loss, { 2: (100 * 1) / 360 });

// loss_count 脏数据被夹在 [0, sample_count]。
const clampedLoss = buildMonitorPingRows({
  3: [{ client: 'n', task_id: 3, time: '2026-01-01T00:01:00.000Z', value: 9, sample_count: 4, loss_count: 99 }],
}, 60);
assert.equal(clampedLoss.ping[0].loss, 100);
eq(clampedLoss.loss, { 3: 100 });

// band 与 step 无关：step=60 且 hi>lo 也给；桶内无波动（hi==lo / 缺 min/max）不给。
const smallStep = buildMonitorPingRows({
  2: [
    { client: 'n', task_id: 2, time: '2026-01-01T00:01:00.000Z', value: 10, min_latency: 5, max_latency: 20 },
    { client: 'n', task_id: 2, time: '2026-01-01T00:02:00.000Z', value: 10, min_latency: 10, max_latency: 10 },
  ],
}, 60);
eq(smallStep.ping[0].band, [5, 20]);
assert.equal(smallStep.ping[1].band, undefined, '零高度带不该出现');

// 空输入
eq(buildMonitorPingRows(null, 60), { ping: [], loss: {} });

// 整窗统计优先：返回的行只覆盖被截断的一段时，顶层 loss 仍用全窗口计数。
const windowLoss = buildMonitorPingRows({
  1: [{ client: 'n', task_id: 1, time: '2026-01-01T00:01:00.000Z', value: 10, sample_count: 5, loss_count: 1 }],
}, 60, undefined, { 1: { samples: 1800, loss_count: 37 } });
assert.equal(windowLoss.ping.length, 1);
eq(windowLoss.loss, { 1: (100 * 37) / 1800 });

// 统计只覆盖部分探测时，其余探测仍按行累计；统计给出的零丢包会覆盖按行的值。
const partialStats = buildMonitorPingRows({
  1: [{ client: 'n', task_id: 1, time: '2026-01-01T00:01:00.000Z', value: 10, sample_count: 10, loss_count: 3 }],
  2: [{ client: 'n', task_id: 2, time: '2026-01-01T00:01:00.000Z', value: 20, sample_count: 10, loss_count: 2 }],
}, 60, undefined, { 1: { samples: 100, loss_count: 7 } });
eq(partialStats.loss, { 1: 7, 2: 20 });
eq(buildMonitorPingRows({
  1: [{ client: 'n', task_id: 1, time: '2026-01-01T00:01:00.000Z', value: 10, sample_count: 10, loss_count: 3 }],
}, 60, undefined, { 1: { samples: 100, loss_count: 0 } }).loss, {});

// 有整窗统计时仍按任务顺序过滤；零丢包的探测不进字典。
eq(buildMonitorPingRows({ 1: [] }, 60, new Map([[2, 0]]), {
  1: { samples: 10, loss_count: 5 },
  2: { samples: 10, loss_count: 0 },
}).loss, {});

// 整窗统计存在但绘图行为空（完全被裁掉）时，仍能给出准确 loss。
const noRows = buildMonitorPingRows(undefined, 60, undefined, { 9: { samples: 4, loss_count: 1 } });
eq(noRows.ping, []);
eq(noRows.loss, { 9: 25 });

// 样本数为 0 的整窗统计不应产生 NaN / 0 除。
eq(buildMonitorPingRows(undefined, 60, undefined, { 9: { samples: 0, loss_count: 0 } }).loss, {});

// 与原版 a_probe_chart_follows_the_panel_order 一致：先按任务顺序，再按 ts。
// 即使 a 在窗口第一个桶就回答，排在前面的 b 仍先出现。
const panelOrder = buildMonitorPingRows({
  1: [
    { client: 'n', task_id: 1, time: '2026-01-01T00:00:00.000Z', value: 10 },
    { client: 'n', task_id: 1, time: '2026-01-01T00:01:00.000Z', value: 10 },
  ],
  2: [{ client: 'n', task_id: 2, time: '2026-01-01T00:01:00.000Z', value: 20 }],
  3: [{ client: 'n', task_id: 3, time: '2026-01-01T00:01:00.000Z', value: 30 }],
}, 60, new Map([[2, 0], [1, 1], [3, 2]]));
const t0 = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
eq(panelOrder.ping.map(row => [row.task_id, row.ts]), [
  [2, t0 + 60], [1, t0], [1, t0 + 60], [3, t0 + 60],
]);

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
