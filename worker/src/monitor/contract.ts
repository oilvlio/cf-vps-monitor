/**
 * monitor 主题契约（hub 1.4.2 公开读接口）的纯投影逻辑。
 *
 * 契约以 monitor-probe/themes 仓库的 `preview/hub.js` 为准：那份假 hub 与 hub
 * 本体同步维护（"When the hub's public API changes, this file changes with it."），
 * 是这些形状与单位的权威定义；收录检查会把每个主题装进最新版 hub 再核对，
 * 所以只要能满足它，主题站里的主题就能直接装。
 *
 * 单位约定（与 hub 逐字对齐）：
 * - mem_* / swap_* / disk_* / traffic_limit 为字节
 * - net_rx / net_tx（节点 metrics 与历史行）为字节/秒
 * - *_rx / *_tx 累计量（total_/month_/day_）为字节
 * - last_seen 为 Unix 秒，last_seen_ago 为秒
 * - expires_at 为 YYYY-MM-DD，expires_in 为天数
 *
 * 这里全部是纯函数，不碰 fetch / DB，方便单测。
 */

import type { MonitorMetricsBucket, MonitorTrafficTotals, PingHistoryRecord, PingTask } from '../db/types';
import type { PublicClient } from '../utils/public-client';
import { trafficPeriodStart } from '../utils/traffic-samples';

// 公开历史只暴露 7 天：rollup 的保留时间 record_preserve_time 默认且最大 168h
// （见后台「保留时间」设置），再往前查只会得到空桶。monitor 的 history_days 和
// hours 上限都用它，避免主题提供根本查不到数据的 30 天档位。
export const MONITOR_HISTORY_DAYS = 7;
export const MONITOR_MAX_HOURS = MONITOR_HISTORY_DAYS * 24;
export const MONITOR_POINTS_MIN = 60;
export const MONITOR_POINTS_MAX = 1440;
export const MONITOR_POINTS_DEFAULT = 1440;

/**
 * 当前对齐的 monitor hub 契约版本（对外公开读接口的形状版本）。
 *
 * 权威锚点是 monitor 仓库的 `web-theme.pin`；widget 契约有任何形状变化时，
 * 这里、`worker/test-support/monitor-golden/hub-golden.json` 和 GOLDEN_SOURCE
 * 三处必须一起更新，否则 golden 测试会红灯。
 */
export const MONITOR_CONTRACT_VERSION = '1.4.2';

// monitor 的具名账单周期（main.rs NAMED_CYCLES）：其余长度存为 `<n>m`，上限
// 1200 个月（MAX_CYCLE，100 年）。
const NAMED_BILLING_CYCLES = new Map<number, string>([
  [1, 'monthly'],
  [3, 'quarterly'],
  [6, 'semiannual'],
  [12, 'yearly'],
  [24, 'biennial'],
  [36, 'triennial'],
]);
const MAX_BILLING_MONTHS = 1200;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function numberValue(source: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!source) return null;
  const value = source[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Unix 秒（hub 的采样时间戳单位）；无法解析返回 0。 */
export function unixSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 毫秒与秒都接受：大于 1e11 视为毫秒。
    return Math.floor(value > 1e11 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return unixSeconds(numeric);
  }
  return 0;
}

/** 请求的 hours，clamp 到 [1, 7d]（与 rollup 保留时间一致），默认 6（与 hub 的 history() 一致）。 */
export function monitorHours(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 6;
  return Math.min(MONITOR_MAX_HOURS, Math.max(1, parsed));
}

/**
 * 分桶步长（秒）：按 points 预算向上取整到分钟。
 * 预算公式与 hub 的 history() 一致；因为 hours 已被 clamp 到 7 天，hub 里
 * `hours > 7d` 的 3600s unit 分支永远不会走到。
 *   budget = min(max(points || 1440, 60), 1440)
 *   step   = 60 * max(1, ceil(hours*3600 / 60 / budget))
 */
export function monitorStep(hoursInput: number, pointsInput?: unknown): number {
  const hours = monitorHours(hoursInput);
  const rawPoints = typeof pointsInput === 'number' ? pointsInput : Number(pointsInput);
  const budget = clamp(
    Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : MONITOR_POINTS_DEFAULT,
    MONITOR_POINTS_MIN,
    MONITOR_POINTS_MAX,
  );
  return 60 * Math.max(1, Math.ceil((hours * 3600) / 60 / budget));
}

/**
 * monitor 历史接口的每分钟请求额度。
 *
 * hex 的节点总览会为每张卡片的延迟徽标拉一次 `series=ping` 历史，5s 一轮；实测
 * 30 个节点约 380 次/分钟，个别卡片会因为卡片级刷新叠加到 22 次/分钟。沿用公开
 * 历史的 60 次/分钟会立刻把这种正常浏览打成 429，所以按 30 次/分钟/节点给额度
 * （30 节点 ≈ 900 次/分钟，约为实测峰值的 1.4 倍），并给出下限（小站不因节点少
 * 被卡）和上限（别把额度开到可以被当成压测工具）。进程内历史缓存还会把每个
 * 具体查询的数据库压力压到 10s 一次，HTTP 额度 ≠ 数据库额度。
 */
export function monitorMetricsRateLimit(nodeCount: number): number {
  const perNode = 30;
  const floor = 120;
  const ceiling = 3000;
  const nodes = Number.isFinite(nodeCount) && nodeCount > 0 ? Math.floor(nodeCount) : 0;
  return Math.min(ceiling, Math.max(floor, nodes * perNode));
}

/** 把时间戳吸附到 step 网格（hub 的 ts 都落在网格上）。 */
export function monitorGridTs(timeMsOrSec: number, step: number): number {
  const sec = unixSeconds(timeMsOrSec);
  if (sec <= 0) return 0;
  return Math.floor(sec / step) * step;
}

/**
 * cf-vps 的 billing_cycle 是「天数」（-1 表示一次性，见前端 billing.ts 的
 * BILLING_CYCLE_OPTIONS / formatBillingCycle）。monitor 用的是字符串枚举：
 * 具名周期 monthly / quarterly / semiannual / yearly / biennial / triennial
 * 对应 1/3/6/12/24/36 个月，其余长度存为 `<n>m`（1..=1200 个月，见 monitor
 * 的 main.rs cycle_months / cycle_name）。monitor 的测试同样按月数解析
 * `<n>m`（"60m" 即 60 个月），主题（LuminaPlus normalizeBillingCycle）也是如此。
 *
 * 换算：天数 ≥ 一个月时按 Math.round(days / 30.4375) 取整月数，再映射到
 * 具名周期或 `<n>m`。小于一个月的周期 monitor 没有对应项，按原样透传天数
 * 字符串（LuminaPlus 会按 `kind: "days"` 正确摊销）。未设置（0/空）视为月付。
 */
export function monitorBillingCycle(days: number | null | undefined): string {
  const value = Number(days);
  if (value === -1) return 'once';
  if (!Number.isFinite(value) || value <= 0) return 'monthly';
  const months = Math.round(value / 30.4375);
  if (months < 1) return String(Number.isInteger(value) ? value : Math.round(value));
  const named = NAMED_BILLING_CYCLES.get(months);
  if (named) return named;
  return `${Math.min(months, MAX_BILLING_MONTHS)}m`;
}

/** 到期剩余天数（可为负 / null）。expired_at 为空返回 null。 */
export function monitorExpiresIn(expiredAt: string | null | undefined, nowMs: number): number | null {
  if (!expiredAt) return null;
  const parsed = Date.parse(expiredAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil((parsed - nowMs) / (1000 * 60 * 60 * 24));
}

/** YYYY-MM-DD；空值返回 null。 */
export function monitorDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * cf-vps 的 traffic_limit_type 映射到 monitor 的 traffic_mode。monitor 只有
 * sum / up / down / max 四种（db.rs Traffic::month_used 的 match），cf-vps 额外
 * 的 min / unlimited / bandwidth:* 都归到 sum。
 */
export function monitorTrafficMode(type: string | null | undefined): string {
  switch (type) {
    case 'up':
    case 'down':
    case 'max':
      return type;
    default:
      return 'sum';
  }
}

/**
 * monitor 的 month_used（db.rs Traffic::month_used）：按节点计费的模式从
 * 月累计的 rx / tx 里取值——up 只算上传、down 只算下载、max 取较大一边，其余
 * （sum）两边相加。
 */
export function monitorMonthUsed(
  traffic: Pick<MonitorTraffic, 'month_rx' | 'month_tx'>,
  mode: string,
): number {
  switch (mode) {
    case 'up':
      return traffic.month_tx;
    case 'down':
      return traffic.month_rx;
    case 'max':
      return Math.max(traffic.month_rx, traffic.month_tx);
    default:
      return traffic.month_rx + traffic.month_tx;
  }
}

/**
 * 当前计费周期的起始日（YYYY-MM-DD，按 UTC 日期）。
 *
 * monitor 的 month_start 是「month_rx/tx 所在计费周期的开始」（db.rs
 * period_start(today, reset_day)）。cf-vps 的 month_rx/tx 来自
 * net_total_up/down，是按 traffic_reset_day 切的计费周期合计，所以起始日也要
 * 用同一个 reset_day 算（复用 utils/traffic-samples.ts 的 trafficPeriodStart，
 * 其顺延规则与旧版 Agent 一致：重置日大于当月天数时落到下月 1 日）。
 *
 * 与 monitor 的差异：hub 用 hub 本地时区的「今天」，而 cf-vps 的月流量边界
 * 是 Agent 本地日期、适配器这层拿不到 Agent 的 utc_offset，只能按 UTC 日期
 * 近似（重置日不跨日界时结果一致）。
 */
export function monitorMonthStart(nowMs: number, resetDay?: number | null): string {
  const dateKey = new Date(nowMs).toISOString().slice(0, 10);
  return resetDay == null
    ? `${dateKey.slice(0, 8)}01`
    : trafficPeriodStart(resetDay, dateKey);
}

/**
 * 节点的数字 id。
 *
 * monitor 的契约里 `id` 是**整数**：hub 的假数据是 `1..30`，`/api/nodes/:id/metrics`
 * 的路由正则也只认 `\d+`，主题会据此做判断（例如 LuminaPlus 直接
 * `nodes.filter(n => Number.isInteger(n.id))`，字符串 id 会让它一个节点都不显示）。
 *
 * cf-vps 的客户端主键是 UUID 字符串，所以这里用 53 位哈希把 UUID 映射成一个
 * **稳定**的整数：同一个 UUID 永远得到同一个 id，与节点集合、顺序、增删都无关，
 * 因此详情页在别的节点变动时不会串到另一台机器。53 位空间内即使有上千个节点，
 * 碰撞概率也在 1e-10 量级，不需要额外的去重表。
 */
export function monitorNumericId(uuid: string): number {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let index = 0; index < uuid.length; index++) {
    const code = uuid.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (code + index), 2246822519) >>> 0;
  }
  // 低 21 位与第二个 32 位拼成 53 位，正好是 JS 安全整数的上限内。
  const value = (h1 & 0x1fffff) * 4294967296 + h2;
  return value > 0 ? value : 1;
}

export type MonitorMe = {
  authed: boolean;
  github: boolean;
  history_days: number;
  public_page: boolean;
  site: string;
  site_name: string;
};

export function buildMonitorMe(args: {
  siteUrl: string;
  siteName: string;
  authed: boolean;
}): MonitorMe {
  return {
    authed: args.authed,
    github: false,
    history_days: MONITOR_HISTORY_DAYS,
    public_page: true,
    site: args.siteUrl,
    site_name: args.siteName,
  };
}

export type MonitorProfile = {
  siteName: string;
  siteUrl: string;
  /** 站点公开时区偏移（秒），用于把「今天」对齐到站长本地日。缺省 0。 */
  utcOffsetSec: number;
};

export type MonitorTraffic = {
  month_rx: number;
  month_tx: number;
  day_rx: number;
  day_tx: number;
  total_rx: number;
  total_tx: number;
};

const ZERO_TRAFFIC: MonitorTraffic = { month_rx: 0, month_tx: 0, day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 };

export function emptyMonitorTraffic(): MonitorTraffic {
  return { ...ZERO_TRAFFIC };
}

/**
 * 节点的「静态」部分：只来自数据库，不随实时上报变化。
 *
 * 抽出来是为了让 `/api/ws` 能把它缓存进 Durable Object，之后每帧只合入实时
 * 数据，避免逐帧查库（见 do/live-data.ts 的 monitor 角色）。
 */
export type MonitorNodeStatic = {
  /** 稳定的数字 id（见 monitorNumericId）。 */
  id: number;
  /** 内部关联字段：cf-vps 的客户端 UUID，用来在 LIVE_DATA 里找实时条目。 */
  uuid: string;
  name: string;
  sort: number;
  public: boolean;
  /** ISO 3166-1 alpha-2，识别不出时为空串（见 monitorCountryCode）。 */
  country: string;
  group: string;
  public_remark: string;
  os: string;
  kernel: string;
  arch: string;
  virt: string;
  cpu_name: string;
  cpu_cores: number;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  agent_version: string;
  billing_cycle: string;
  currency: string;
  price: number;
  expires_at: string | null;
  traffic_limit: number;
  traffic_mode: string;
  traffic_reset_day: number;
  day_rx: number;
  day_tx: number;
  total_rx: number;
  total_tx: number;
};

/**
 * monitor 契约的 `country` 必须是 ISO 3166-1 alpha-2（或空串）。
 *
 * 主题按国家码分组：monitor-theme-hex 的 `regionKey` 要求 `/^[A-Z]{2}$/` 且
 * `Intl.DisplayNames` 认得（见 src/lib/groups.ts），其它值一律归到「未知地区」。
 * 参考实现（/root/monitor）直接存 `ipinfo.io/{ip}/country` 返回的两位码。
 *
 * cf-vps 存的 `client.region` 是给面板展示的 `城市, 省/州, 国家码`，两个构造点
 * 都把国家码放在最后一段：
 * - routes/websocket.ts 的 requestRegion：`[cf.city, cf.region, cf.country]`
 * - do/live-data.ts 的 regionFromGeoJsBody：`[city, region, country_code]`
 * 所以取最后一段并校验即可；只接受末段是为了避免把两位数的城市名误当国家码。
 */
export function monitorCountryCode(region: unknown): string {
  const text = typeof region === 'string' ? region.trim() : '';
  if (!text) return '';
  const parts = text.split(',').map(part => part.trim()).filter(Boolean);
  const code = (parts[parts.length - 1] || '').toUpperCase();
  // ZZ（ISO 的「未知」）与 XX（Cloudflare 等使用的占位）都不是真实国家，
  // 主题也会把它们当未知地区，这里直接输出空串。
  return /^[A-Z]{2}$/.test(code) && code !== 'ZZ' && code !== 'XX' ? code : '';
}

export function monitorNodeStatic(
  client: PublicClient,
  traffic?: Pick<MonitorTraffic, 'day_rx' | 'day_tx' | 'total_rx' | 'total_tx'> | null,
): MonitorNodeStatic {
  const price = Number.isFinite(client.price) ? client.price : Number(client.price) || 0;
  return {
    id: monitorNumericId(client.uuid),
    uuid: client.uuid,
    name: client.name,
    sort: client.sort_order ?? 0,
    public: !client.hidden,
    country: monitorCountryCode(client.region),
    group: client.group || '',
    public_remark: client.public_remark || '',
    os: client.os || '',
    kernel: client.kernel_version || '',
    arch: client.arch || '',
    virt: client.virtualization || '',
    cpu_name: client.cpu_name || '',
    cpu_cores: client.cpu_cores || 0,
    mem_total: client.mem_total || 0,
    swap_total: client.swap_total || 0,
    disk_total: client.disk_total || 0,
    agent_version: client.version || '',
    billing_cycle: monitorBillingCycle(client.billing_cycle),
    currency: client.currency || '',
    price,
    expires_at: monitorDate(client.expired_at),
    traffic_limit: client.traffic_limit || 0,
    traffic_mode: monitorTrafficMode(client.traffic_limit_type),
    traffic_reset_day: client.traffic_reset_day || 1,
    day_rx: traffic?.day_rx ?? 0,
    day_tx: traffic?.day_tx ?? 0,
    total_rx: traffic?.total_rx ?? 0,
    total_tx: traffic?.total_tx ?? 0,
  };
}

/**
 * 节点流量。cf-vps 的 `net_total_up/down` 已是**当前计费周期**的合计（见
 * utils/traffic-samples.ts：DB 换算增量后回填 report），所以直接对应 month_*。
 * day_* / total_* 来自 `cfm_traffic_totals`（见 monitorTrafficWithTotals）。
 */
export function monitorTrafficFromLive(
  entry: Record<string, unknown> | null | undefined,
): MonitorTraffic {
  const traffic = emptyMonitorTraffic();
  if (!entry) return traffic;
  traffic.month_rx = numberValue(entry, 'net_total_down') ?? 0;
  traffic.month_tx = numberValue(entry, 'net_total_up') ?? 0;
  return traffic;
}

/** 在实时条目的月流量之上，合入数据库算出的当日 / 累计流量。 */
export function monitorTrafficWithTotals(
  entry: Record<string, unknown> | null | undefined,
  totals: MonitorTrafficTotals | null | undefined,
): MonitorTraffic {
  const traffic = monitorTrafficFromLive(entry);
  if (totals) {
    traffic.day_rx = totals.day_rx;
    traffic.day_tx = totals.day_tx;
    traffic.total_rx = totals.total_rx;
    traffic.total_tx = totals.total_tx;
  }
  return traffic;
}

/** 节点级 metrics 子对象（online 且已有上报时才有）。 */
function buildMonitorLiveMetrics(
  staticNode: Pick<MonitorNodeStatic, 'mem_total' | 'swap_total' | 'disk_total'>,
  live: Record<string, unknown>,
  traffic: MonitorTraffic,
): Record<string, unknown> {
  const memTotal = numberValue(live, 'ram_total') ?? staticNode.mem_total ?? 0;
  const swapTotal = numberValue(live, 'swap_total') ?? staticNode.swap_total ?? 0;
  const diskTotal = numberValue(live, 'disk_total') ?? staticNode.disk_total ?? 0;
  const metrics: Record<string, unknown> = {
    cpu: numberValue(live, 'cpu') ?? 0,
    mem_total: memTotal,
    mem_used: numberValue(live, 'ram') ?? 0,
    swap_total: swapTotal,
    swap_used: numberValue(live, 'swap') ?? 0,
    disk_total: diskTotal,
    disk_used: numberValue(live, 'disk') ?? 0,
    net_rx: numberValue(live, 'net_in') ?? 0,
    net_tx: numberValue(live, 'net_out') ?? 0,
    tcp: numberValue(live, 'connections') ?? 0,
    udp: numberValue(live, 'connections_udp') ?? 0,
    procs: numberValue(live, 'process_count') ?? 0,
    uptime: numberValue(live, 'uptime') ?? 0,
    total_rx: traffic.total_rx,
    total_tx: traffic.total_tx,
    month_rx: traffic.month_rx,
    month_tx: traffic.month_tx,
  };
  // 负载不可用（探针显式报 null，比如 lxcfs 未虚拟化 loadavg 的容器）时整个
  // load 键缺省，与 monitor 一致（agent 没报 load 就没有这个键）；不能伪装成
  // [0,0,0]，主题会把 0 读成「负载 0.00」而不是「无数据」。
  const load1 = numberValue(live, 'load');
  const load5 = numberValue(live, 'load5');
  const load15 = numberValue(live, 'load15');
  if (load1 != null && load5 != null && load15 != null) {
    metrics.load = [load1, load5, load15];
  }
  return metrics;
}

export type BuildMonitorNodeArgs = {
  client: PublicClient;
  /** LIVE_DATA 里该节点的实时条目（data / last_known），缺失表示未上报过。 */
  live?: Record<string, unknown> | null;
  online: boolean;
  /** 最近一次上报的 DO 接收时间（毫秒），0 表示从未上报。 */
  lastReportMs?: number;
  traffic?: MonitorTraffic;
  nowMs: number;
  siteUrl: string;
};

export type MonitorNode = {
  id: number;
  name: string;
  sort: number;
  public: boolean;
  online: boolean;
  metrics: Record<string, unknown> | null;
  /** ISO 3166-1 alpha-2，识别不出时为空串（见 monitorCountryCode）。 */
  country: string;
  group: string;
  public_remark: string;
  os: string;
  kernel: string;
  arch: string;
  virt: string;
  cpu_name: string;
  cpu_cores: number;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  agent_version: string;
  last_seen: number;
  last_seen_ago: number | null;
  billing_cycle: string;
  currency: string;
  price: number;
  expires_at: string | null;
  expires_in: number | null;
  traffic_limit: number;
  traffic_mode: string;
  traffic_reset_day: number;
  month_start: string;
  month_rx: number;
  month_tx: number;
  month_used: number;
  day_rx: number;
  day_tx: number;
  total_rx: number;
  total_tx: number;
};

function stringValue(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

export type BuildMonitorNodeFromStaticArgs = {
  node: MonitorNodeStatic;
  /** LIVE_DATA 里该节点的实时条目（data / last_known），缺失表示未上报过。 */
  live?: Record<string, unknown> | null;
  online: boolean;
  /** 最近一次上报的 DO 接收时间（毫秒），0 表示从未上报。 */
  lastReportMs?: number;
  traffic?: MonitorTraffic;
  nowMs: number;
};

/**
 * 用「静态投影 + 实时条目」拼出一个 monitor node。
 *
 * `/api/nodes` 用 PublicClient 走 `buildMonitorNode`；`/api/ws` 的 Durable Object
 * 缓存静态投影后只合入实时条目，所以两边共用这一个函数，形状不会跑偏。
 *
 * `last_seen` / `last_seen_ago`：hub 对「刚连上还没上报」的节点给 `last_seen: 0,
 * last_seen_ago: null`；在线且有上报给 `now` / `0`；离线给上次上报时间 / 已过去秒数。
 */
export function buildMonitorNodeFromStatic(args: BuildMonitorNodeFromStaticArgs): MonitorNode {
  const { node, live, online, nowMs } = args;
  const traffic = args.traffic ?? monitorTrafficFromLive(live);
  const lastReportMs = Number.isFinite(args.lastReportMs) && (args.lastReportMs as number) > 0
    ? (args.lastReportMs as number)
    : 0;
  const sampleMs = numberValue(live, 'timestamp');
  const seenMs = lastReportMs || (sampleMs != null && sampleMs > 0 ? sampleMs : 0) || 0;

  let lastSeen = 0;
  let lastSeenAgo: number | null = null;
  if (seenMs > 0) {
    lastSeen = Math.floor(seenMs / 1000);
    lastSeenAgo = online ? 0 : Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  }

  // `uuid` 是内部关联用的，不进公开响应（它只在静态投影里存在）。
  const { uuid: _clientUuid, ...publicFields } = node;

  return {
    ...publicFields,
    online,
    metrics: live && online ? buildMonitorLiveMetrics(node, live, traffic) : null,
    last_seen: lastSeen,
    last_seen_ago: lastSeenAgo,
    expires_in: monitorExpiresIn(node.expires_at, nowMs),
    month_start: monitorMonthStart(nowMs, node.traffic_reset_day),
    month_rx: traffic.month_rx,
    month_tx: traffic.month_tx,
    month_used: monitorMonthUsed(traffic, node.traffic_mode),
    day_rx: traffic.day_rx || node.day_rx,
    day_tx: traffic.day_tx || node.day_tx,
    total_rx: traffic.total_rx || node.total_rx,
    total_tx: traffic.total_tx || node.total_tx,
  };
}

/**
 * 把一个公开节点投影成 monitor 的 node 形状。
 */
export function buildMonitorNode(args: BuildMonitorNodeArgs): MonitorNode {
  return buildMonitorNodeFromStatic({
    node: monitorNodeStatic(args.client, args.traffic),
    live: args.live,
    online: args.online,
    lastReportMs: args.lastReportMs,
    traffic: args.traffic,
    nowMs: args.nowMs,
  });
}

export type MonitorMetricsRow = {
  ts: number;
  minutes: number;
  cpu: number;
  cpu_max: number;
  mem_used: number;
  disk_used: number;
  net_rx: number;
  net_tx: number;
  net_rx_max: number;
  net_tx_max: number;
  swap_used: number;
  tcp: number;
  udp: number;
  procs: number;
};

/**
 * 把 `cfm_records_range_aggregated` 的分桶投影成 monitor 的 metrics 行。
 *
 * 每个桶是**封闭**的：`cpu`/`mem_used`/`net_*` 是桶内均值，`*_max` 是桶内峰值，
 * `minutes` 由 SQL 按样本数折算（一条记录覆盖 record_persist_interval_sec 秒），
 * 所以不再拿桶里最新一行冒充整桶，也不会把写入中的分钟算成完整分钟。
 */
export function buildMonitorMetricsRows(
  buckets: readonly MonitorMetricsBucket[],
  step: number,
): MonitorMetricsRow[] {
  const rows: MonitorMetricsRow[] = [];
  const fullMinutes = Math.max(1, Math.round(step / 60));
  for (const bucket of buckets) {
    const ts = monitorGridTs(Number(bucket.ts), step);
    if (ts <= 0) continue;
    const source = bucket as unknown as Record<string, unknown>;
    const cpu = numberValue(source, 'cpu') ?? 0;
    const reportedMinutes = numberValue(source, 'minutes');
    rows.push({
      ts,
      minutes: reportedMinutes != null
        ? Math.min(fullMinutes, Math.max(1, Math.round(reportedMinutes)))
        : fullMinutes,
      cpu,
      cpu_max: numberValue(source, 'cpu_max') ?? cpu,
      mem_used: numberValue(source, 'mem_used') ?? 0,
      disk_used: numberValue(source, 'disk_used') ?? 0,
      net_rx: numberValue(source, 'net_rx') ?? 0,
      net_tx: numberValue(source, 'net_tx') ?? 0,
      net_rx_max: numberValue(source, 'net_rx_max') ?? 0,
      net_tx_max: numberValue(source, 'net_tx_max') ?? 0,
      swap_used: numberValue(source, 'swap_used') ?? 0,
      tcp: numberValue(source, 'tcp') ?? 0,
      udp: numberValue(source, 'udp') ?? 0,
      procs: numberValue(source, 'procs') ?? 0,
    });
  }
  return rows;
}

export type MonitorPingRow = {
  ts: number;
  task_id: number;
  latency: number | null;
  loss?: number;
  band?: [number, number];
};

export type MonitorPingResult = {
  ping: MonitorPingRow[];
  loss: Record<string, number>;
};

/**
 * 把分桶后的 ping 记录投影成 monitor 的 ping 行。
 *
 * 丢包口径与 monitor 的 `db.rs` 对齐：
 * - 逐桶：`ceil(100 × lost / total)`，只在 `lost > 0` 时写 `loss`。向上取整是为了让
 *   “没有 loss 字段”严格表示该桶零丢包：截断会把 1/180 的丢包显示成 0。
 * - 窗口：`100 × Σlost / Σtotal`，不取整；只把有丢包的探测放进顶层 `loss` 字典，
 *   主题按“字典里没有 = 0%”读取。
 *
 * `latency` 是桶内中位数（分桶 RPC 的 value）向下取整到整数毫秒，与 monitor 的
 * `Tally::median`（整数除法）一致。`band` 只在桶内真有波动（hi > lo）时给，
 * 与 step 无关（monitor 的 close_bucket 同一规则）。
 * `total` 取 `sample_count`；原始点没有这个字段时按一个样本计。
 *
 * 注意：分桶 RPC 的 `safe_limit` 最多返回 1000 个桶。窗口/points 让桶数超过上限时，
 * 这里的窗口丢包率只覆盖返回的那部分；需要绝对精确可改用
 * `cfm_ping_stats_for_tasks_range`，它直接对原始样本汇总整个窗口。
 */
export function buildMonitorPingRows(
  byTask: Record<string, PingHistoryRecord[]> | null | undefined,
  step: number,
  taskOrder?: ReadonlyMap<number, number>,
): MonitorPingResult {
  const ping: MonitorPingRow[] = [];
  const loss: Record<string, number> = {};
  if (!byTask) return { ping, loss };
  // 每个探测在整个窗口里的丢包总数 / 样本总数。逐桶 loss 只有商，不能反推分母，
  // 所以必须在读每一行的同一趟里累计。
  const totals = new Map<number, { lost: number; total: number }>();
  for (const [taskIdText, rows] of Object.entries(byTask)) {
    const taskId = Number(taskIdText);
    if (!Number.isInteger(taskId)) continue;
    if (taskOrder && !taskOrder.has(taskId)) continue;
    for (const row of rows ?? []) {
      const timeMs = Date.parse(row.time);
      if (!Number.isFinite(timeMs)) continue;
      const ts = monitorGridTs(timeMs, step);
      const value = Number(row.value);
      const sampleCount = Number(row.sample_count);
      const total = Number.isFinite(sampleCount) && sampleCount > 0 ? sampleCount : 1;
      const allLost = !Number.isFinite(value) || value < 0;
      const lossCount = Number(row.loss_count);
      const lost = allLost
        ? total
        : Math.min(total, Math.max(0, Number.isFinite(lossCount) ? lossCount : 0));
      const tally = totals.get(taskId) ?? { lost: 0, total: 0 };
      tally.lost += lost;
      tally.total += total;
      totals.set(taskId, tally);

      if (allLost) {
        ping.push({ ts, task_id: taskId, latency: null, loss: 100 });
        continue;
      }
      const entry: MonitorPingRow = { ts, task_id: taskId, latency: Math.floor(value) };
      // 部分丢包的桶也要带 loss，否则主题会把整桶当成 0%。
      if (lost > 0) entry.loss = Math.ceil((100 * lost) / total);
      // band 只在桶内真有波动（hi > lo）时给，且不限 step（monitor 的 close_bucket）。
      const min = Number(row.min_latency);
      const max = Number(row.max_latency);
      const lo = Number.isFinite(min) ? min : value;
      const hi = Number.isFinite(max) ? max : value;
      if (hi > lo) entry.band = [Math.floor(Math.min(lo, hi)), Math.floor(Math.max(lo, hi))];
      ping.push(entry);
    }
  }
  ping.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const orderDiff = (taskOrder?.get(a.task_id) ?? Number.MAX_SAFE_INTEGER)
      - (taskOrder?.get(b.task_id) ?? Number.MAX_SAFE_INTEGER);
    return orderDiff || a.task_id - b.task_id;
  });
  for (const [taskId, tally] of totals) {
    if (tally.lost > 0 && tally.total > 0) {
      loss[String(taskId)] = (100 * tally.lost) / tally.total;
    }
  }
  return { ping, loss };
}

export type MonitorProbe = { id: number; name: string };

/** 只保留分配给该节点的任务，并沿用后台维护的显示顺序。 */
export function monitorTasksForClient<T extends Pick<PingTask, 'id' | 'clients' | 'all_clients' | 'sort_order'>>(
  tasks: readonly T[],
  clientUuid: string,
): T[] {
  return tasks
    .filter(task => task.all_clients || task.clients.includes(clientUuid))
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftOrder = left.task.sort_order ?? left.index;
      const rightOrder = right.task.sort_order ?? right.index;
      return leftOrder - rightOrder
        || (left.task.id ?? Number.MAX_SAFE_INTEGER) - (right.task.id ?? Number.MAX_SAFE_INTEGER);
    })
    .map(entry => entry.task);
}

/** 探测点表：`{task_id: name}`。series=metrics 时不返回（与 hub 一致）。 */
export function buildMonitorProbes(tasks: readonly PingTask[]): Record<string, string> {
  const probes: Record<string, string> = {};
  for (const task of tasks) {
    if (typeof task.id === 'number' && Number.isInteger(task.id)) {
      probes[String(task.id)] = task.name;
    }
  }
  return probes;
}

/** ping 任务 id 列表（只取有效的正整数 id）。 */
export function monitorTaskIds(tasks: readonly PingTask[]): number[] {
  const ids = new Set<number>();
  for (const task of tasks) {
    if (typeof task.id === 'number' && Number.isInteger(task.id) && task.id > 0) ids.add(task.id);
  }
  return [...ids];
}

export { numberValue, stringValue };
