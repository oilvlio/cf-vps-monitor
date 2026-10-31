// 流量统计（Worker 侧的纯逻辑）
//
// Agent 只上报各网卡的内核累计读数（report.traffic_sample）。Worker 负责：
//   1. 校验并限幅这些读数；
//   2. 按约 2 分钟一次的节奏把样本交给 Supabase（cfm_traffic_apply_samples），由数据库在一个事务里
//      换算增量、累加到 Agent 本地日期的日桶、更新读数，并返回当前计费周期 [重置日, 今天] 的合计；
//   3. 用这个合计覆盖 report 的 net_total_up/down，下游（实时推送、records、公开接口）无需感知。
// 这里只放不依赖 DO / 数据库的部分，便于单测。

type JsonObject = Record<string, unknown>;

export interface TrafficCounterPair {
  up: number;
  down: number;
}

export interface TrafficSample {
  ts: number;
  boot: number;
  scope: string;
  utc_offset: number;
  interfaces: Record<string, TrafficCounterPair>;
}

export interface TrafficImportDay {
  date: string;
  up: number;
  down: number;
}

export interface TrafficImportBaseline {
  scope: string;
  boot: number;
  interfaces: Record<string, TrafficCounterPair>;
}

export interface TrafficImport {
  days: TrafficImportDay[];
  baseline: TrafficImportBaseline | null;
}

/**
 * 两次落库之间的最小间隔。名义上约 2 分钟（与 ping record 同节奏），取 100 秒是为了容忍 Agent 采样抖动：
 * 空闲时 Agent 每 120 秒采一次，若门槛恰好是 120 秒，稍快一点的样本会被跳过、实际变成每 240 秒一次。
 * 被跳过的样本不会丢流量：读数是累计的，下一次落库时的差值已经包含了这段增量。
 */
export const TRAFFIC_APPLY_MIN_GAP_MS = 100_000;

/** 与数据库约束一致：计数器 / 日增量的上限（约 1PB），防止异常值污染合计。 */
export const MAX_TRAFFIC_BYTES = 1_000_000_000_000_000;
const MAX_INTERFACES = 64;
const MAX_INTERFACE_NAME_LENGTH = 64;
const MAX_SCOPE_LENGTH = 64;
const MAX_IMPORT_DAYS = 400;
/** UTC 偏移的合法范围：UTC-12 到 UTC+14。 */
const MIN_UTC_OFFSET_SECONDS = -12 * 3600;
const MAX_UTC_OFFSET_SECONDS = 14 * 3600;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), MAX_TRAFFIC_BYTES);
}

function dateKeyToUtcMs(key: string): number | null {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  // 往返校验：拒绝 2026-02-31 这类会被 Date 自动进位的日期。
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

export function isValidDateKey(key: unknown): key is string {
  return typeof key === 'string' && dateKeyToUtcMs(key) !== null;
}

/** 样本所在的 Agent 本地日期（YYYY-MM-DD）：UTC 时间加上 Agent 上报的偏移。 */
export function localDateKey(tsMs: number, utcOffsetSeconds: number): string {
  return new Date(tsMs + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

export function normalizeResetDay(value: unknown): number {
  const day = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(31, Math.max(1, day));
}

/** 重置日大于当月天数时顺延到下月 1 日（与旧版 Agent 的实现一致）。 */
function actualResetDate(year: number, monthIndex: number, resetDay: number): number {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return resetDay <= daysInMonth ? Date.UTC(year, monthIndex, resetDay) : Date.UTC(year, monthIndex + 1, 1);
}

/** 包含 dateKey 的计费周期的起始日（YYYY-MM-DD）。 */
export function trafficPeriodStart(resetDay: number, dateKey: string): string {
  const currentMs = dateKeyToUtcMs(dateKey);
  if (currentMs === null) throw new RangeError(`invalid date key: ${dateKey}`);
  const day = normalizeResetDay(resetDay);
  const current = new Date(currentMs);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const thisMonth = actualResetDate(year, month, day);
  const previous = new Date(Date.UTC(year, month - 1, 1));
  const startMs = currentMs >= thisMonth ? thisMonth : actualResetDate(previous.getUTCFullYear(), previous.getUTCMonth(), day);
  return new Date(startMs).toISOString().slice(0, 10);
}

function parseInterfaces(value: unknown): Record<string, TrafficCounterPair> | null {
  if (!isRecord(value)) return null;
  const interfaces: Record<string, TrafficCounterPair> = {};
  let count = 0;
  for (const [name, counter] of Object.entries(value)) {
    if (!isRecord(counter) || name === '' || name.length > MAX_INTERFACE_NAME_LENGTH) continue;
    const up = toBytes(counter.up);
    const down = toBytes(counter.down);
    if (up === null || down === null) continue;
    interfaces[name] = { up, down };
    count += 1;
    if (count >= MAX_INTERFACES) break;
  }
  return count > 0 ? interfaces : null;
}

/**
 * 解析 report.traffic_sample。ts 由调用方给出（沿用 report 自己的时间戳规则，保证和 records 一致）。
 * 格式不对、没有任何可用网卡读数时返回 null，调用方按「这份 report 没有流量样本」处理。
 */
export function parseTrafficSample(value: unknown, ts: number): TrafficSample | null {
  if (!isRecord(value) || !Number.isFinite(ts) || ts <= 0) return null;
  const scope = typeof value.scope === 'string' ? value.scope : '';
  if (scope === '' || scope.length > MAX_SCOPE_LENGTH) return null;
  const interfaces = parseInterfaces(value.interfaces);
  if (!interfaces) return null;
  const boot = toBytes(value.boot) ?? 0;
  const rawOffset = typeof value.utc_offset === 'number' && Number.isFinite(value.utc_offset) ? Math.trunc(value.utc_offset) : 0;
  const utcOffset = Math.min(MAX_UTC_OFFSET_SECONDS, Math.max(MIN_UTC_OFFSET_SECONDS, rawOffset));
  return { ts: Math.floor(ts), boot, scope, utc_offset: utcOffset, interfaces };
}

/** 汇总一批 report 里的流量样本：按时间升序，同一时间戳只保留最后一个。 */
export function collectTrafficSamples(reports: JsonObject[], timestampOf: (report: JsonObject) => number): TrafficSample[] {
  const byTs = new Map<number, TrafficSample>();
  for (const report of reports) {
    if (report.traffic_sample === undefined) continue;
    const sample = parseTrafficSample(report.traffic_sample, timestampOf(report));
    if (sample) byTs.set(sample.ts, sample);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 从按时间升序的样本里挑出这次要交给数据库的：跳过已经处理过的（ts 不大于 lastAppliedTs），
 * 其余按「距上一个入选样本至少 minGapMs」稀疏化。lastAppliedTs 为 undefined（DO 刚启动 / 首次见到该节点）
 * 时第一个样本一定入选，这样月度流量立刻有值。
 */
export function selectDueSamples(samples: TrafficSample[], lastAppliedTs: number | undefined, minGapMs: number): TrafficSample[] {
  const due: TrafficSample[] = [];
  let last = lastAppliedTs;
  for (const sample of samples) {
    if (last !== undefined && sample.ts <= last) continue;
    if (last === undefined || sample.ts - last >= minGapMs) {
      due.push(sample);
      last = sample.ts;
    }
  }
  return due;
}

/** 取一批 report 里第一个 traffic_import（Agent 只把它挂在信封的第一份 report 上）。 */
export function parseTrafficImport(reports: JsonObject[]): TrafficImport | null {
  const raw = reports.map(report => report.traffic_import).find(isRecord);
  if (!raw) return null;
  const days: TrafficImportDay[] = [];
  if (Array.isArray(raw.days)) {
    for (const entry of raw.days.slice(0, MAX_IMPORT_DAYS)) {
      if (!isRecord(entry) || !isValidDateKey(entry.date)) continue;
      const up = toBytes(entry.up);
      const down = toBytes(entry.down);
      if (up === null || down === null) continue;
      days.push({ date: entry.date, up, down });
    }
  }
  let baseline: TrafficImportBaseline | null = null;
  if (isRecord(raw.baseline)) {
    const scope = typeof raw.baseline.scope === 'string' ? raw.baseline.scope : '';
    const interfaces = parseInterfaces(raw.baseline.interfaces);
    if (scope !== '' && scope.length <= MAX_SCOPE_LENGTH && interfaces) {
      baseline = { scope, boot: toBytes(raw.baseline.boot) ?? 0, interfaces };
    }
  }
  return days.length > 0 || baseline ? { days, baseline } : null;
}
