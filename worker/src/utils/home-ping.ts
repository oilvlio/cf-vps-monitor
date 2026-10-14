// 首页节点卡片的延迟 / 丢包色块。
//
// 数据来源 ping_snapshots 是「变化日志」而不是定时采样：worker 落库时对连续相同
// 状态做了去重（见 live-data.ts 的 shouldPersistPingResult），只在丢包状态翻转、
// 延迟变化超阈值或满 30 分钟心跳时才写一行。所以不能按「每桶几条记录」来算：
// 一段持续 25 分钟的丢包可能只有 1 行。这里把每行当成「从该时刻起持续到下一行」
// 的一段状态，按时间向前填充后再切桶，延迟和丢包都按覆盖时长加权。

export const HOME_PING_BUCKET_SEC = 300;
export const HOME_PING_BUCKET_COUNT = 24;
// 心跳最长 30 分钟，再留 10 分钟余量；超过这个时间没有新行，说明节点可能已离线，
// 这段时间视为「无数据」而不是继续沿用旧状态。
export const HOME_PING_STALE_MS = 40 * 60 * 1000;
// 查询时要把窗口起点往前多取一段，用来拿到起点之前的最近一行做种子。
export const HOME_PING_LOOKBACK_MS = 60 * 60 * 1000;

const LOSS_VALUE = -1;

export interface HomePingRow {
  time: string;
  value: number;
}

export interface HomePingSource {
  task_id: number;
  name: string;
  rows: HomePingRow[];
}

export interface HomePingPoint {
  /** 桶起点，毫秒时间戳 */
  t: number;
  /** 该桶内成功探测的加权平均延迟；整桶丢包或无数据为 null */
  latency_ms: number | null;
  /** 该桶内丢包时长占已覆盖时长的百分比；无数据为 null */
  loss_percent: number | null;
}

export interface HomePingNode {
  task_id: number;
  task_name: string;
  /** 最近一次探测延迟；最近一次丢包、或已过期时为 null */
  latency_ms: number | null;
  /** 整个窗口内的平均延迟 */
  latency_avg_ms: number | null;
  /** 整个窗口内的丢包百分比 */
  loss_percent: number | null;
  /** 最近一条记录的时间 */
  updated_at: string | null;
  points: HomePingPoint[];
}

export interface HomePingSummary {
  bucket_sec: number;
  bucket_count: number;
  generated_at: string;
  nodes: Record<string, HomePingNode>;
}

interface Segment {
  start: number;
  end: number;
  value: number;
}

function toSegments(rows: HomePingRow[], nowMs: number): Segment[] {
  const points = rows
    .map((row) => ({ time: Date.parse(row.time), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.time) && Number.isFinite(row.value))
    .sort((a, b) => a.time - b.time);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const cap = current.time + HOME_PING_STALE_MS;
    const end = Math.min(next ? next.time : nowMs, cap);
    if (end > current.time) segments.push({ start: current.time, end, value: current.value });
  }
  return segments;
}

export function buildHomePingNode(
  source: HomePingSource,
  nowMs: number,
  bucketSec = HOME_PING_BUCKET_SEC,
  bucketCount = HOME_PING_BUCKET_COUNT,
): HomePingNode {
  const bucketMs = bucketSec * 1000;
  // 最后一个桶是「当前正在进行的桶」，它的右边界对齐到下一个桶起点。
  const lastBucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const firstBucketStart = lastBucketStart - (bucketCount - 1) * bucketMs;
  const segments = toSegments(source.rows, nowMs);

  const points: HomePingPoint[] = [];
  let totalCovered = 0;
  let totalLost = 0;
  let totalOk = 0;
  let totalLatencyWeighted = 0;

  for (let index = 0; index < bucketCount; index += 1) {
    const start = firstBucketStart + index * bucketMs;
    const end = start + bucketMs;
    let covered = 0;
    let lost = 0;
    let ok = 0;
    let latencyWeighted = 0;

    for (const segment of segments) {
      const overlap = Math.min(segment.end, end) - Math.max(segment.start, start);
      if (overlap <= 0) continue;
      covered += overlap;
      if (segment.value === LOSS_VALUE || segment.value < 0) {
        lost += overlap;
      } else {
        ok += overlap;
        latencyWeighted += segment.value * overlap;
      }
    }

    points.push({
      t: start,
      latency_ms: ok > 0 ? Math.round(latencyWeighted / ok) : null,
      loss_percent: covered > 0 ? Math.round((lost / covered) * 1000) / 10 : null,
    });
    totalCovered += covered;
    totalLost += lost;
    totalOk += ok;
    totalLatencyWeighted += latencyWeighted;
  }

  const last = source.rows
    .map((row) => ({ time: Date.parse(row.time), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.time) && Number.isFinite(row.value))
    .sort((a, b) => a.time - b.time)
    .at(-1);
  const fresh = last !== undefined && nowMs - last.time <= HOME_PING_STALE_MS;

  return {
    task_id: source.task_id,
    task_name: source.name,
    latency_ms: fresh && last.value >= 0 ? Math.round(last.value) : null,
    latency_avg_ms: totalOk > 0 ? Math.round(totalLatencyWeighted / totalOk) : null,
    loss_percent: totalCovered > 0 ? Math.round((totalLost / totalCovered) * 1000) / 10 : null,
    updated_at: last ? new Date(last.time).toISOString() : null,
    points,
  };
}

export function buildHomePingSummary(
  sources: Record<string, HomePingSource>,
  nowMs: number,
  bucketSec = HOME_PING_BUCKET_SEC,
  bucketCount = HOME_PING_BUCKET_COUNT,
): HomePingSummary {
  const nodes: Record<string, HomePingNode> = {};
  for (const [uuid, source] of Object.entries(sources)) {
    nodes[uuid] = buildHomePingNode(source, nowMs, bucketSec, bucketCount);
  }
  return {
    bucket_sec: bucketSec,
    bucket_count: bucketCount,
    generated_at: new Date(nowMs).toISOString(),
    nodes,
  };
}

/** 窗口 [start, end]，start 已包含向前回溯的种子区间。 */
export function homePingQueryRange(nowMs: number, bucketSec = HOME_PING_BUCKET_SEC, bucketCount = HOME_PING_BUCKET_COUNT) {
  const bucketMs = bucketSec * 1000;
  const firstBucketStart = Math.floor(nowMs / bucketMs) * bucketMs - (bucketCount - 1) * bucketMs;
  return {
    start: new Date(firstBucketStart - HOME_PING_LOOKBACK_MS).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}
