import { fetchWithBootstrapRetry } from './api.ts';

export interface PingTask {
  id: number | string;
  name?: string;
  type?: string;
  target?: string;
  clients?: string[] | string;
  all_clients?: boolean | number | string;
  interval?: number;
  interval_sec?: number;
}

export interface PingRecord {
  time: string;
  value: number;
  task_id?: number | string;
  sample_count?: number;
  success_count?: number;
  loss_count?: number;
  /** 延迟单位为 ms；没有成功样本时为 null，旧响应可能省略字段。 */
  avg_latency?: number | null;
  min_latency?: number | null;
  max_latency?: number | null;
  p50_latency?: number | null;
  p75_latency?: number | null;
}

/** 整个时间窗口的统计（服务端对原始样本计算）。延迟类字段在没有成功样本时为 null。 */
export interface PingTaskStats {
  samples: number;
  successCount: number;
  lossCount: number;
  /** 丢包率（0-100）。 */
  lossRate: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p75: number | null;
  /** 成功样本延迟的样本标准差（ms），不足 2 个样本时为 null。 */
  jitter: number | null;
}

export interface NormalizedPingTask {
  id: number;
  key: string;
  label: string;
  target: string;
  type: string;
  intervalSec: number;
  color: string;
}

export interface PingTaskSeries {
  task: NormalizedPingTask;
  records: PingRecord[];
}

export type PingChartRow = {
  time: number;
  [key: string]: number | null;
};

const pingSeriesColors = [
  '#FF1744',
  '#00C853',
  '#2979FF',
  '#FF9100',
  '#D500F9',
  '#00B8D4',
  '#FFD600',
  '#651FFF',
  '#FF4081',
  '#64DD17',
];

const demoTaskColorOrder = [
  'Demo - Cloudflare ICMP',
  'Demo - IPv6 DNS',
  'Demo - HTTPS 443',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pingTaskFromRecord(record: Record<string, unknown>): PingTask {
  const clients = Array.isArray(record.clients)
    ? record.clients.filter((client): client is string => typeof client === 'string')
    : stringValue(record.clients);
  return {
    id: typeof record.id === 'number' || typeof record.id === 'string' ? record.id : '',
    name: stringValue(record.name),
    type: stringValue(record.type),
    target: stringValue(record.target),
    clients,
    all_clients: typeof record.all_clients === 'boolean' ||
      typeof record.all_clients === 'number' ||
      typeof record.all_clients === 'string'
      ? record.all_clients
      : undefined,
    interval: numberValue(record.interval),
    interval_sec: numberValue(record.interval_sec),
  };
}

function getTaskColor(task: PingTask, index: number) {
  const demoIndex = demoTaskColorOrder.findIndex((name) => name === task.name);
  const colorIndex = demoIndex >= 0 ? demoIndex : index + demoTaskColorOrder.length;
  return pingSeriesColors[colorIndex % pingSeriesColors.length];
}

function toClients(value: PingTask['clients']): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function isAllClients(value: PingTask['all_clients']) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function hasValidPingTaskId(task: PingTask) {
  const id = Number(task.id);
  return Number.isFinite(id) && id > 0;
}

export function pingTaskAppliesToClient(task: unknown, uuid: string) {
  const record = asRecord(task);
  if (!record) return false;
  const pingTask = pingTaskFromRecord(record);
  if (!hasValidPingTaskId(pingTask)) return false;
  const clients = toClients(pingTask.clients);
  return isAllClients(pingTask.all_clients) || clients.length === 0 || clients.includes(uuid);
}

export function normalizePingTask(task: unknown, index: number): NormalizedPingTask | null {
  const record = asRecord(task);
  if (!record) return null;
  const pingTask = pingTaskFromRecord(record);
  const id = Number(pingTask.id);
  if (!hasValidPingTaskId(pingTask)) return null;

  const target = (pingTask.target || pingTask.name || `Task ${id}`).trim();
  const type = (pingTask.type || 'ping').toUpperCase();
  const intervalSec = Number(pingTask.interval_sec || pingTask.interval || 60);

  return {
    id,
    key: `task_${id}`,
    label: (pingTask.name || target).trim(),
    target,
    type,
    intervalSec: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60,
    color: getTaskColor(pingTask, index),
  };
}

export function normalizePingRecord(payload: unknown): PingRecord | null {
  const record = asRecord(payload);
  if (!record || typeof record.time !== 'string' || !Number.isFinite(new Date(record.time).getTime())) {
    return null;
  }
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return null;
  const taskId = record.task_id;
  const normalized: PingRecord = {
    time: record.time,
    value: record.value,
    ...(typeof taskId === 'number' || typeof taskId === 'string' ? { task_id: taskId } : {}),
    ...(typeof record.sample_count === 'number' ? { sample_count: record.sample_count } : {}),
    ...(typeof record.success_count === 'number' ? { success_count: record.success_count } : {}),
    ...(typeof record.loss_count === 'number' ? { loss_count: record.loss_count } : {}),
  };
  for (const key of ['avg_latency', 'min_latency', 'max_latency', 'p50_latency', 'p75_latency'] as const) {
    const value = record[key];
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) normalized[key] = value;
  }
  return normalized;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function normalizePingTaskStats(payload: unknown): Record<string, PingTaskStats> {
  const source = asRecord(payload);
  const result: Record<string, PingTaskStats> = {};
  if (!source) return result;
  for (const [taskId, raw] of Object.entries(source)) {
    const item = asRecord(raw);
    if (!item) continue;
    const samples = finiteOrNull(item.samples);
    if (samples === null) continue;
    result[taskId] = {
      samples,
      successCount: finiteOrNull(item.success_count) ?? 0,
      lossCount: finiteOrNull(item.loss_count) ?? 0,
      lossRate: finiteOrNull(item.loss_rate),
      avg: finiteOrNull(item.avg_latency),
      min: finiteOrNull(item.min_latency),
      max: finiteOrNull(item.max_latency),
      p50: finiteOrNull(item.p50_latency),
      p75: finiteOrNull(item.p75_latency),
      jitter: finiteOrNull(item.jitter),
    };
  }
  return result;
}

export function normalizePingRecords(payload: unknown): PingRecord[] {
  const record = asRecord(payload);
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : [];
  return records.flatMap((item) => {
    const record = normalizePingRecord(item);
    return record ? [record] : [];
  });
}

function findAnchor(anchors: number[], timestamp: number, toleranceMs: number) {
  for (const anchor of anchors) {
    if (Math.abs(anchor - timestamp) <= toleranceMs) return anchor;
  }
  return null;
}

/**
 * 曲线上实际画的延迟值。
 * - 原始点：就是 value。
 * - 分桶点（带 sample_count）：取桶内 P75。中位数会把短促的劣化抹平，
 *   P75 对偶发尖峰仍不敏感，却能让持续的变差体现在曲线上。
 * - 丢包（value < 0，整桶都没有成功样本）原样返回，由调用方当作缺口处理。
 */
export function pingPlotValue(record: PingRecord): number {
  const value = Number(record.value);
  if (!(value >= 0)) return value;
  if (Number(record.sample_count) > 0) {
    const p75 = numberValue(record.p75_latency);
    if (p75 !== undefined && p75 >= 0) return p75;
  }
  return value;
}

// pick 缺省时取曲线值（丢包记为 null）；丢包率视图传入自己的取值函数，复用同一套时间锚点对齐。
export function buildPingChartRows(
  series: PingTaskSeries[],
  pick: (record: PingRecord) => number | null = (record) => {
    const value = pingPlotValue(record);
    return value < 0 ? null : value;
  },
) {
  const validIntervals = series
    .map((item) => item.task.intervalSec)
    .filter((value) => Number.isFinite(value) && value > 0);
  const minInterval = validIntervals.length ? Math.min(...validIntervals) : 60;
  const toleranceMs = Math.min(1500, Math.max(800, Math.floor(minInterval * 1000 * 0.4)));
  const anchors: number[] = [];
  const grouped: Record<number, PingChartRow> = {};

  for (const item of series) {
    for (const record of item.records) {
      const timestamp = new Date(record.time).getTime();
      if (!Number.isFinite(timestamp)) continue;

      const anchor = findAnchor(anchors, timestamp, toleranceMs);
      const useTimestamp = anchor ?? timestamp;
      if (!grouped[useTimestamp]) {
        grouped[useTimestamp] = { time: useTimestamp };
        if (anchor === null) anchors.push(useTimestamp);
      }
      grouped[useTimestamp][item.task.key] = pick(record);
    }
  }

  return Object.values(grouped).sort((a, b) => Number(a.time) - Number(b.time));
}

function getLatestPingTimestamp(series: PingTaskSeries[]) {
  const timestamps = series.flatMap((item) =>
    item.records
      .map((record) => new Date(record.time).getTime())
      .filter((timestamp) => Number.isFinite(timestamp)),
  );
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function limitPingSeriesToRecentRange(series: PingTaskSeries[], rangeHours?: number) {
  if (!rangeHours || rangeHours <= 0) return series;

  const latest = getLatestPingTimestamp(series);
  if (!latest) return series;

  const cutoff = latest - rangeHours * 3600000;
  return series.map((item) => ({
    ...item,
    records: item.records.filter((record) => {
      const timestamp = new Date(record.time).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= latest;
    }),
  }));
}

export function getPingTimeDomain(series: PingTaskSeries[], rangeHours?: number): [number | string, number | string] {
  const latest = getLatestPingTimestamp(series);
  if (!latest || !rangeHours || rangeHours <= 0) return ['dataMin', 'dataMax'];
  return [latest - rangeHours * 3600000, latest];
}

export function getPingValues(series: PingTaskSeries[]) {
  return series.flatMap((item) =>
    item.records
      .map((record) => pingPlotValue(record))
      .filter((value) => Number.isFinite(value) && value >= 0),
  );
}

export function getPingSeriesWithRecords(series: PingTaskSeries[]) {
  return series.filter((item) => item.records.length > 0);
}

export function getPingYAxisDomain(series: PingTaskSeries[]): [number, number] {
  const values = getPingValues(series);
  if (values.length === 0) return [0, 100];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const padding = range > 0 ? Math.max(5, range * 0.35) : Math.max(8, max * 0.25);
  const lower = Math.max(0, min - padding);
  const upper = max + padding;

  if (upper - lower < 12) {
    const extra = (12 - (upper - lower)) / 2;
    return [Math.max(0, lower - extra), upper + extra];
  }

  return [lower, upper];
}

export function getPingSeriesAverage(records: PingRecord[]): number | null {
  const chronological = records
    .map((record) => pingPlotValue(record))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (chronological.length === 0) return null;

  const sum = chronological.reduce((total, value) => total + value, 0);
  return sum / chronological.length;
}

export function getPingSeriesP75(records: PingRecord[]): number | null {
  // 分桶聚合数据：每个桶已带 p75_latency，直接取其中位数展示。
  const bucketP75s = records
    .map((record) => record.p75_latency)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (bucketP75s.length > 0) {
    bucketP75s.sort((a, b) => a - b);
    return bucketP75s[Math.floor(bucketP75s.length / 2)];
  }

  const values = records
    .map((record) => Number(record.value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) return null;

  values.sort((a, b) => a - b);
  const rank = (values.length - 1) * 0.75;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return values[lower];

  return values[lower] + (values[upper] - values[lower]) * (rank - lower);
}

// 分桶聚合数据：每个桶已带 loss_count/sample_count，直接加权汇总。
// 旧响应可能缺少计数，且旧版曾压缩连续同状态样本，记录条数不一定等于探测次数。
// 缺少计数时按“每条记录代表的时间段”估算：一条记录的持续时间 = 它到下一条记录
// （或窗口末尾）之间的时间差，丢包率 = 丢包时长 / 总时长。
export function getPingLossRate(records: PingRecord[], windowEndMs?: number): number | null {
  const withCounts = records.filter(
    (r) => Number.isFinite(r.loss_count) && Number.isFinite(r.sample_count) && (r.sample_count as number) > 0,
  );
  if (withCounts.length > 0) {
    const totalSamples = withCounts.reduce((sum, r) => sum + (r.sample_count as number), 0);
    const totalLoss = withCounts.reduce((sum, r) => sum + (r.loss_count as number), 0);
    if (totalSamples <= 0) return null;
    return (totalLoss / totalSamples) * 100;
  }

  const points = records
    .map((record) => ({
      timestamp: new Date(record.time).getTime(),
      value: Number(record.value),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (points.length === 0) return null;

  const endMs = Number.isFinite(windowEndMs) ? (windowEndMs as number) : Date.now();

  let totalMs = 0;
  let lostMs = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const segmentEnd = next ? next.timestamp : endMs;
    const duration = Math.max(0, segmentEnd - current.timestamp);
    if (duration === 0) continue;

    totalMs += duration;
    if (current.value < 0) lostMs += duration;
  }

  if (totalMs <= 0) {
    // 兜底：所有记录时间戳重合（比如只有一条），退化成按条数算。
    const lostCount = points.filter((point) => point.value < 0).length;
    return (lostCount / points.length) * 100;
  }

  return (lostMs / totalMs) * 100;
}

export function formatPingLossRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value <= 0) return '0%';
  // 小于 1% 的丢包也值得展示，避免被四舍五入抹平成 0%。
  return value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

export function formatPingMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '-';
  return `${Math.round(numberValue)} ms`;
}

// 带一位小数的延迟文案（整数不带小数点）：分桶后的中位数、p75、抖动都是不取整的，
// 用 formatPingMs 的四舍五入会把它们又压回阶梯。
export function formatPingMsDetail(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '-';
  return Number.isInteger(numberValue) ? `${numberValue} ms` : `${numberValue.toFixed(1)} ms`;
}

export interface PingTaskSummary {
  /** 最后一条有效延迟（>=0），对任务卡片「最新」值。 */
  latest: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p75: number | null;
  loss: number | null;
  /** 延迟标准差（ms）：越大越不稳定。分桶数据且没有服务端统计时无法还原，为 null。 */
  jitter: number | null;
}

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// 任务卡片统计。有服务端统计（整个窗口、对原始样本计算）时直接用它，数字与图上
// 画的点（分桶/截断）无关；没有时（统计请求失败）退回用前端手上的点估算：
// 分桶数据用 avg/min/max_latency 列（avg 按样本量加权），原始数据对 value 全量统计。
export function getPingTaskSummary(records: PingRecord[], stats?: PingTaskStats | null): PingTaskSummary {
  const isPositive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

  let latest: number | null = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const value = pingPlotValue(records[i]);
    if (isPositive(value)) {
      latest = value;
      break;
    }
  }

  if (stats) {
    return {
      latest,
      avg: stats.avg,
      min: stats.min,
      max: stats.max,
      p75: stats.p75,
      loss: stats.lossRate,
      jitter: stats.jitter,
    };
  }

  let avg: number | null = null;
  let min: number | null = null;
  let max: number | null = null;
  let jitter: number | null = null;

  const bucketRows = records.filter((record) => isPositive(record.avg_latency));
  if (bucketRows.length > 0) {
    let weighted = 0;
    let weight = 0;
    for (const record of bucketRows) {
      const count = Number(record.sample_count);
      const w = Number.isFinite(count) && count > 0 ? count : 1;
      weighted += (record.avg_latency as number) * w;
      weight += w;
    }
    if (weight > 0) avg = weighted / weight;
    const mins = records.map((record) => record.min_latency).filter(isPositive);
    const maxs = records.map((record) => record.max_latency).filter(isPositive);
    if (mins.length > 0) min = Math.min(...mins);
    if (maxs.length > 0) max = Math.max(...maxs);
  } else {
    const values = records.map((record) => Number(record.value)).filter(isPositive);
    if (values.length > 0) {
      avg = values.reduce((sum, value) => sum + value, 0) / values.length;
      min = Math.min(...values);
      max = Math.max(...values);
      jitter = sampleStdDev(values);
    }
  }

  return {
    latest,
    avg,
    min,
    max,
    p75: getPingSeriesP75(records),
    loss: getPingLossRate(records),
    jitter,
  };
}

// StrictMode 的两个调用共享窗口请求；取消一个等待者不会取消另一个等待者。
const pingWindowInFlight = new Map<string, Promise<unknown>>();

function fetchPingWindow(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  let shared = pingWindowInFlight.get(url);
  if (!shared) {
    shared = (async () => {
      const response = await fetchWithBootstrapRetry(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })().finally(() => {
      pingWindowInFlight.delete(url);
    });
    pingWindowInFlight.set(url, shared);
  }
  if (!signal) return shared;
  const pending = shared;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function fetchPingTaskWindow(
  uuid: string,
  {
    points = 1440,
    maxTasks = 8,
    hours = 6,
    includeHidden = false,
    signal,
  }: {
    points?: number;
    maxTasks?: number;
    hours?: number;
    includeHidden?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ series: PingTaskSeries[]; stats: Record<string, PingTaskStats> }> {
  const query = new URLSearchParams({ uuid, hours: String(hours), points: String(points), max_tasks: String(maxTasks) });
  if (includeHidden) query.set('include_hidden', '1');
  const data = asRecord(await fetchPingWindow(`/api/records/ping/window?${query}`, signal));
  if (!data || !Array.isArray(data.tasks) || !asRecord(data.records) || !asRecord(data.stats)) {
    throw new Error('无效的 Ping 窗口响应');
  }
  const tasks = data.tasks
    .map((task, index) => normalizePingTask(task, index))
    .filter((task): task is NormalizedPingTask => Boolean(task));
  const records = asRecord(data.records)!;
  return {
    series: tasks.map(task => ({ task, records: normalizePingRecords(records[String(task.id)]) })),
    stats: normalizePingTaskStats(data.stats),
  };
}
