/**
 * monitor 主题契约（hub 1.4.3 公开读接口）的纯投影逻辑。
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
import { RECORD_RETENTION_MAX_HOURS } from '../settings/schema';
import { toPublicClient, type PublicClient } from '../utils/public-client';
import { resolveHistoryPlan } from '../utils/history-bucket';

// 公开历史窗口上限为 30 天（RECORD_RETENTION_MAX_HOURS = 720h）。原始记录默认保留
// 168h，更早的数据由 rollup 提供；实际可查记录仍取决于保留设置与采集时间。
// monitor 的 history_days 和 hours 上限都用这个窗口上限。
// 后台把保留时间调低时 history_days 仍报这个值（与保留上限对齐，不随设置动态变化）。
export const MONITOR_HISTORY_DAYS = RECORD_RETENTION_MAX_HOURS / 24;
export const MONITOR_MAX_HOURS = MONITOR_HISTORY_DAYS * 24;
// hub 的 DETAIL_DAYS：窗口超过它使用 30 分钟 rollup；再按整小时倍数合并，保持 monitorStep 的契约。
export const MONITOR_DETAIL_DAYS = 7;
export const MONITOR_POINTS_MIN = 60;
export const MONITOR_POINTS_MAX = 1440;
export const MONITOR_POINTS_DEFAULT = 1440;

/**
 * 当前对齐的 monitor hub 契约版本（对外公开读接口的形状版本）。
 *
 * 基线分三处分别记录，互不替代：
 * - hub commit：monitor 仓库 `2477cef8425d21580eb5ac98c23f03efc7da2a6a`
 *   （node_view() / period_start() 的对照提交）；
 * - 默认主题 pin：monitor/web-theme.pin 的
 *   `v1.4.3 78c83ea0343d0ac06507528407eae93af0773239fdefae54024ca9d16a54c0a8`；
 * - golden 形状：`worker/test-support/monitor-golden/hub-golden.json` 与同目录
 *   GOLDEN_SOURCE 记录的来源。
 *
 * 主题 pin 带来形状变化时，这里的版本号、`hub-golden.json` 的 contractVersion
 * 和 GOLDEN_SOURCE 必须一起更新，否则 golden 测试会红灯。
 */
export const MONITOR_CONTRACT_VERSION = '1.4.3';

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
    // 数字字符串先按秒/毫秒解释，避免 Date.parse 把 '1' 等值当作日历日期。
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return unixSeconds(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

/** 请求的 hours，clamp 到 [1, 30d]（与历史保留时间一致），默认 6（与 hub 的 history() 一致）。 */
export function monitorHours(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 6;
  return Math.min(MONITOR_MAX_HOURS, Math.max(1, parsed));
}

/**
 * 分桶步长（秒）：按 points 预算向上取整到分钟。
 * 与 hub 的 span()（api.rs）一致：
 *   budget = min(max(points || 1440, 60), 1440)
 *   hours <= 7d：unit = 60s，step = 60 * max(1, ceil(hours*3600 / 60 / budget))
 *   hours >  7d：unit = 3600s（读 30 分钟 rollup 后合并），step = 3600 * max(1, ceil(hours / budget))
 * 长窗口步长取整小时，保证 rollup 桶合并后不会跨两个输出点。
 */
export function monitorStep(hoursInput: number, pointsInput?: unknown): number {
  const hours = monitorHours(hoursInput);
  const rawPoints = typeof pointsInput === 'number' ? pointsInput : Number(pointsInput);
  const budget = clamp(
    Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : MONITOR_POINTS_DEFAULT,
    MONITOR_POINTS_MIN,
    MONITOR_POINTS_MAX,
  );
  const unit = hours > MONITOR_DETAIL_DAYS * 24 ? 3600 : 60;
  const requestedStepSec = unit * Math.max(1, Math.ceil((hours * 3600) / unit / budget));
  return resolveHistoryPlan(hours * 3_600_000, { requestedStepSec, consumer: 'monitor' }).stepSec;
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
/** monitor 整页历史请求的上限；原生绑定只能固定额度，本地降级仍按节点数精确计算。 */
export const MONITOR_METRICS_RATE_LIMIT_CEILING = 3000;

export function monitorMetricsRateLimit(nodeCount: number): number {
  const perNode = 30;
  const floor = 120;
  const nodes = Number.isFinite(nodeCount) && nodeCount > 0 ? Math.floor(nodeCount) : 0;
  return Math.min(MONITOR_METRICS_RATE_LIMIT_CEILING, Math.max(floor, nodes * perNode));
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

/** 把 UTC 毫秒格式化成契约里的日期（YYYY-MM-DD）。 */
function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 校验并返回 UTC 的 YYYY-MM-DD 零点毫秒；不是真实存在的日期返回 null。 */
function utcDateMs(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? ms
    : null;
}

// 日期字段（expires_at / month_start）的语义是「日历上的那一天」，不是精确到毫秒
// 的时刻。monitor 的 db.rs 把 expires_at 存成 TEXT 日期、month_start 存成
// DATE，主题也只按日期显示；这里同样先取日期部分，避免把带时区的时间戳换算成
// UTC 后跨到前一天 / 后一天。
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/;

/**
 * 到期剩余天数（可为负 / null），按**日历天**计算。
 *
 * monitor 的 node_view 用 `(expires_at - now.date_naive()).num_days()`：今天与
 * 到期日都是日期，差多少天就是多少天。旧的实现按毫秒差向上取整，带时分秒的
 * 到期时间在跨日边界会多算一天；这里改成与 hub 同口径的日期差。expired_at 为空
 * 或不是合法日期返回 null。
 */
export function monitorExpiresIn(expiredAt: string | null | undefined, nowMs: number): number | null {
  const expiresAt = monitorDate(expiredAt);
  if (!expiresAt || !Number.isFinite(nowMs)) return null;
  const now = new Date(nowMs);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiryMs = Date.parse(`${expiresAt}T00:00:00.000Z`);
  if (!Number.isFinite(expiryMs)) return null;
  return Math.round((expiryMs - todayMs) / (1000 * 60 * 60 * 24));
}

/**
 * 契约日期（YYYY-MM-DD）；空值 / 非法日期返回 null。
 *
 * 带日期前缀的字符串（DB 的 timestamptz 序列化成 `2026-01-11T00:00:00+00:00`）
 * 直接保留其中的日历日期，不做时区换算；没有日期前缀的 ISO 时间戳才交给
 * Date.parse 后取 UTC 日期。
 */
export function monitorDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const prefixed = DATE_PREFIX.exec(text);
  if (prefixed) {
    const ms = utcDateMs(Number(prefixed[1]), Number(prefixed[2]), Number(prefixed[3]));
    return ms === null ? null : utcDateKey(ms);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return utcDateKey(parsed);
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
 * monitor 的 month_start 是「month_rx/tx 所在计费周期的开始」，由 db.rs 的
 * period_start(today, reset_day) 计算：把 reset_day 夹到当月最后一天，今天已过
 * 起始日就取本月，否则取上一个月的对应日。这里逐条复刻该规则——尤其是
 * reset_day=31 遇到 2 月 / 30 天月份时，起点是当月最后一天，而不是下月 1 日。
 *
 * 参考时间由调用方给：节点有上报时间时用它，而不是请求时刻。监控数据里的
 * month_rx/tx 是最后一次上报时按计费周期切出来的合计，离线节点停在旧周期；
 * 用「现在」算会把一个早已离线、数据属于上个月的节点标成新周期。
 *
 * 与 monitor 的差异：hub 用 hub 本地时区的「今天」，而 cf-vps 的月流量边界是
 * Agent 本地日期、适配器这层拿不到 Agent 的 utc_offset，只能按 UTC 日期近似
 * （重置日不跨日界时结果一致）。
 */
export function monitorMonthStart(referenceMs: number, resetDay?: number | null): string {
  const reference = new Date(Number.isFinite(referenceMs) ? referenceMs : 0);
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const day = reference.getUTCDate();
  const reset = resetDay == null || !Number.isFinite(Number(resetDay))
    ? 1
    : clamp(Math.trunc(Number(resetDay)), 1, 31);
  const daysThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const startThisMonth = Math.min(reset, daysThisMonth);
  if (day >= startThisMonth) {
    return utcDateKey(Date.UTC(year, month, startThisMonth));
  }
  // 本月还没到重置日：周期开始于上一个月的「同一天」，同样夹到月末。
  const previous = new Date(Date.UTC(year, month - 1, 1));
  const previousYear = previous.getUTCFullYear();
  const previousMonth = previous.getUTCMonth();
  const daysPreviousMonth = new Date(Date.UTC(previousYear, previousMonth + 1, 0)).getUTCDate();
  return utcDateKey(Date.UTC(previousYear, previousMonth, Math.min(reset, daysPreviousMonth)));
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
 * last_seen_ago: null`；只要有过上报，`last_seen_ago` 就是 hub 时钟上距那次上报
 * 的秒数——在线不等于「刚刚上报」，断流但仍挂着连接的节点也应显示真实的间隔。
 *
 * 顶层 `mem_total` / `swap_total` / `disk_total` 与 `metrics` 里的同名值同源：
 * 在线且有实时条目时用实时值（hub 的 node_view 也把报告当作权威，否则卡片和
 * 详情页会对同一台机器显示两种容量），离线时才用库里存的最后值。
 *
 * `month_start` 以最后一次上报时间为参考：`month_rx/tx` 是那次上报时按计费周期
 * 切出来的合计，节点离线后不会自己滚到新周期。
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
    lastSeenAgo = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  }

  const metrics = live && online ? buildMonitorLiveMetrics(node, live, traffic) : null;
  const capacity = (key: 'mem_total' | 'swap_total' | 'disk_total'): number => {
    const reported = metrics ? numberValue(metrics, key) : null;
    return reported != null ? reported : node[key];
  };

  // `uuid` 是内部关联用的，不进公开响应（它只在静态投影里存在）。
  const { uuid: _clientUuid, ...publicFields } = node;

  return {
    ...publicFields,
    mem_total: capacity('mem_total'),
    swap_total: capacity('swap_total'),
    disk_total: capacity('disk_total'),
    online,
    metrics,
    last_seen: lastSeen,
    last_seen_ago: lastSeenAgo,
    expires_in: monitorExpiresIn(node.expires_at, nowMs),
    // Traffic totals are accumulated using the Agent's local calendar date. The
    // ingestion path attaches its exact period start; only legacy reports fall
    // back to a UTC projection because they do not carry that source metadata.
    month_start: monitorDate(stringValue(live, 'traffic_period_start'))
      ?? monitorMonthStart(seenMs > 0 ? seenMs : nowMs, node.traffic_reset_day),
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

/**
 * DO 的 monitor 静态投影：admin 元数据（完整 db.Client 行）→ 公开节点 → 静态节点。
 *
 * 这是 Worker 侧 `getPublicClientsSnapshot`（toPublicClient 白名单 → buildMonitorNode）
 * 的对等路径：admin 行在这里同样先过 toPublicClient（去掉 token / token_hash，把
 * has_ipv4 收敛成布尔位）。hidden 节点默认过滤，保证不随帧广播给访客；只有管理员
 * 连接的那份投影传 `includeHidden`，此时 hidden 节点以 `public: false` 出现，字段
 * 仍然只有 toPublicClient 白名单里的那些（与内置前台 include_hidden 同口径）。
 * 两条路径的对等性由 contract.parity.test.mjs 盯着：同一行原始数据走两边，输出
 * 的 node JSON 必须完全一致。
 */
export function buildMonitorStaticNodesFromClients(
  rawClients: Iterable<unknown>,
  totals?: Record<string, Pick<MonitorTraffic, 'day_rx' | 'day_tx' | 'total_rx' | 'total_tx'>> | null,
  includeHidden = false,
): MonitorNodeStatic[] {
  const nodes: MonitorNodeStatic[] = [];
  for (const raw of rawClients) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const client = toPublicClient(raw as Parameters<typeof toPublicClient>[0]);
    if (!client.uuid || (client.hidden && !includeHidden)) continue;
    nodes.push(monitorNodeStatic(client, totals?.[client.uuid]));
  }
  // 与 /api/nodes 的排序一致：sort_order 升序，同序按名字。
  nodes.sort((left, right) => left.sort - right.sort || left.name.localeCompare(right.name));
  return nodes;
}

export type MonitorMetricsRow = {
  ts: number;
  minutes: number;
  cpu: number;
  cpu_max: number;
  mem_used: number;
  disk_used: number | null;
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
      disk_used: numberValue(source, 'disk_used'),
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

/** `cfm_ping_stats_*` 的整窗结果：只有构造 loss 需要的两个计数。 */
export type MonitorPingWindowStats = {
  samples?: unknown;
  loss_count?: unknown;
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
 * 窗口值优先用 `windowStats`（`cfm_ping_stats_*` 对整个窗口的汇总），它不受
 * 绘图桶 limit 的截断影响。没有提供时才退回归档在分桶行里的计数——那条路径
 * 只覆盖实际返回的桶，不能当精确值。
 *
 * `latency` 是桶内中位数（分桶 RPC 的 value）向下取整到整数毫秒，与 monitor 的
 * `Tally::median`（整数除法）一致。`band` 只在桶内真有波动（hi > lo）时给，
 * 与 step 无关（monitor 的 close_bucket 同一规则）。
 * `total` 取 `sample_count`；原始点没有这个字段时按一个样本计。
 */
export function buildMonitorPingRows(
  byTask: Record<string, PingHistoryRecord[]> | null | undefined,
  step: number,
  taskOrder?: ReadonlyMap<number, number>,
  windowStats?: Record<string, MonitorPingWindowStats> | null,
): MonitorPingResult {
  const ping: MonitorPingRow[] = [];
  const loss: Record<string, number> = {};
  if (!byTask && !windowStats) return { ping, loss };
  // 每个探测在整个窗口里的丢包总数 / 样本总数。逐桶 loss 只有商，不能反推分母，
  // 所以必须在读每一行的同一趟里累计。整窗统计覆盖到的探测以统计为准；没覆盖到
  // 的（例如统计 RPC 的任务数上限）才退回这条按行累计的路径。
  const totals = new Map<number, { lost: number; total: number }>();
  for (const [taskIdText, rows] of Object.entries(byTask ?? {})) {
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
    const orderDiff = (taskOrder?.get(a.task_id) ?? Number.MAX_SAFE_INTEGER)
      - (taskOrder?.get(b.task_id) ?? Number.MAX_SAFE_INTEGER);
    if (orderDiff) return orderDiff;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.task_id - b.task_id;
  });
  // 整窗统计是权威值：即使绘图桶被 limit 截断，这里仍覆盖整个窗口。
  // 统计没覆盖到的探测继续用按行累计，避免统计 RPC 的任务上限让它们整条消失。
  const authoritative = new Set<number>();
  if (windowStats) {
    for (const [taskIdText, stats] of Object.entries(windowStats)) {
      const taskId = Number(taskIdText);
      if (!Number.isInteger(taskId)) continue;
      if (taskOrder && !taskOrder.has(taskId)) continue;
      const samples = Number(stats?.samples);
      const lost = Number(stats?.loss_count);
      if (!Number.isFinite(samples) || samples <= 0) continue;
      authoritative.add(taskId);
      if (Number.isFinite(lost) && lost > 0) {
        loss[String(taskId)] = (100 * lost) / samples;
      } else {
        delete loss[String(taskId)];
      }
    }
  }
  for (const [taskId, tally] of totals) {
    if (authoritative.has(taskId)) continue;
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
