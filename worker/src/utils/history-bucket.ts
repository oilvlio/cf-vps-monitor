/**
 * 历史查询的分桶口径：详情页路由与 Monitor 契约共用同一份定义，
 * 免得两处各写一套步长，档位之间对不齐。
 */

// 原始点的上限：12h 内按 60s 最小落库间隔最多 720 点，SVG 直接画完全没有压力。
// 前端的区间是 start/end 两次独立取 Date 得到的，会比名义区间多出几毫秒，
// 所以边界留 10 分钟余量，免得 12h 档被偶然判成分桶请求。
export const RAW_HISTORY_MAX_RANGE_MS = 12 * 60 * 60 * 1000 + 10 * 60 * 1000;
export const PING_ROLLUP_BUCKET_SEC = 30 * 60;
// Match the UI's independently sampled start/end timestamps: the nominal 7d
// window may be a few milliseconds wider, but should remain on raw 14-minute buckets.
export const PING_ROLLUP_RANGE_MS = 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

export type PingHistoryPlan = { source: 'raw' | 'rollup'; stepSec: number };

/** Monitor 与内置 Ping 共用的窗口：先吸附请求网格，再按保留期确定最终网格。 */
export function resolveHistoryWindow(
  rangeMs: number,
  requestedStepSec: number,
  rawRetentionHours: number,
  endMs = Date.now(),
  nowMs = Date.now(),
): { start: string; end: string; plan: PingHistoryPlan } {
  const gridStart = (step: number) => Math.floor((Math.floor(endMs / 1000) - rangeMs / 1000) / step) * step * 1000;
  const plan = resolveHistoryPlan(rangeMs, {
    requestedStepSec,
    consumer: 'monitor',
    rangeStartMs: gridStart(requestedStepSec),
    rawRetentionHours,
    nowMs,
    minimumRollupRangeMs: Number.POSITIVE_INFINITY,
  });
  return { start: new Date(gridStart(plan.stepSec)).toISOString(), end: new Date(endMs).toISOString(), plan };
}

/** Resolve the source and grid together; Monitor uses an hourly rollup grid. */
export function resolveHistoryPlan(
  rangeMs: number,
  options: {
    requestedStepSec?: number;
    consumer?: 'public' | 'monitor';
    rangeStartMs?: number;
    rawRetentionHours?: number;
    nowMs?: number;
    minimumRollupRangeMs?: number;
  } = {},
): PingHistoryPlan {
  const nowMs = options.nowMs ?? Date.now();
  const retentionHours = Number.isFinite(options.rawRetentionHours)
    ? Math.max(48, Math.min(720, options.rawRetentionHours!)) : 168;
  const rawCutoff = Math.floor((nowMs - retentionHours * 60 * 60 * 1000) / (PING_ROLLUP_BUCKET_SEC * 1000))
    * PING_ROLLUP_BUCKET_SEC * 1000;
  const minimumRollupRangeMs = options.minimumRollupRangeMs
    ?? (options.rangeStartMs === undefined ? PING_ROLLUP_RANGE_MS : Number.POSITIVE_INFINITY);
  const forceRollup = rangeMs > minimumRollupRangeMs;
  const source = forceRollup || (options.rangeStartMs !== undefined && options.rangeStartMs < rawCutoff)
    ? 'rollup' : 'raw';
  const requested = options.requestedStepSec;
  const defaultStep = rangeMs > 7 * 24 * 60 * 60 * 1000 ? PING_ROLLUP_BUCKET_SEC
    : rangeMs > 3.5 * 24 * 60 * 60 * 1000 ? 840
    : rangeMs > RAW_HISTORY_MAX_RANGE_MS ? 360 : 0;
  const step = requested !== undefined && Number.isFinite(requested)
    ? Math.max(0, requested) : source === 'rollup' ? PING_ROLLUP_BUCKET_SEC : defaultStep;
  if (source === 'raw') return { source, stepSec: step };
  const unit = options.consumer === 'monitor' ? 3600 : PING_ROLLUP_BUCKET_SEC;
  return { source, stepSec: Math.max(unit, Math.ceil(step / unit) * unit) };
}

/** Keep the raw/rollup boundary shared by the built-in API and Monitor adapter. */
export function resolvePingHistoryPlan(rangeMs: number, requestedStepSec = PING_ROLLUP_BUCKET_SEC): PingHistoryPlan {
  return resolveHistoryPlan(rangeMs, { requestedStepSec });
}

/**
 * <=12h 读原始（12h × 60s = 720 点）；12h~3.5d → 360s 桶，3.5d~7d → 840s 桶；
 * >7d 使用 30 分钟 rollup，最多支持 30d（约 1440 个半小时桶）。
 *
 * 原始数据分桶的步长取 120s 的整数倍（6min / 14min），60s 和 120s 的探测间隔都整除，每桶样本数恒定
 * （60s 探测下 6 / 14 个，120s 探测下 3 / 7 个）。每桶至少 3 个样本，中位数才压得住孤立的
 * 尖峰；步长等于探测间隔时桶边界会和采样时刻错位（桶里时有 0 个、时有 2 个），所以短窗口不分桶。
 */
export function historyBucketSec(rangeMs: number): number | null {
  return resolveHistoryPlan(rangeMs).stepSec || null;
}
