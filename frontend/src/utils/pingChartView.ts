import type { PingChartRow, PingRecord } from './pingChart.ts';

// 单条记录的丢包率（0-100）。分桶聚合数据带 sample_count / loss_count；
// 原始数据只有 value，负值即丢包。
export function pingRecordLossPercent(record: PingRecord): number | null {
  const samples = Number(record.sample_count);
  const lost = Number(record.loss_count);
  if (Number.isFinite(samples) && samples > 0 && Number.isFinite(lost)) {
    return Math.min(100, Math.max(0, (lost / samples) * 100));
  }
  const value = Number(record.value);
  if (!Number.isFinite(value)) return null;
  return value < 0 ? 100 : 0;
}

// 延迟档位色：与 LuminaPlus 同一套离散阶梯，一眼分得出 53ms 和 91ms。
export function latencyHeatColor(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'var(--lp-text-3)';
  if (ms <= 60) return 'var(--lp-lat-excellent)';
  if (ms <= 100) return 'var(--lp-lat-good)';
  if (ms <= 160) return 'var(--lp-lat-moderate)';
  if (ms <= 200) return 'var(--lp-lat-elevated)';
  return 'var(--lp-lat-critical)';
}

export function lossHeatColor(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent) || percent < 0) return 'var(--lp-text-3)';
  if (percent <= 0) return 'var(--lp-lat-excellent)';
  if (percent <= 1) return 'var(--lp-lat-good)';
  if (percent <= 3) return 'var(--lp-lat-moderate)';
  if (percent <= 10) return 'var(--lp-lat-elevated)';
  return 'var(--lp-lat-critical)';
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 削峰：只把「明显高出邻近中位数」的尖峰点压回邻近中位数，其余点一律原样保留。
//
// 判定同时要求绝对和相对两个条件（取较大者）：偏离 > max(minRiseMs, riseRatio × 邻近中位数)。
// 3 ms 基线上 ±1 ms 的正常抖动不会被当成尖峰；100 ms 的线要高出 50% 才算。
// 邻近中位数不受尖峰本身影响，连续两三个尖峰也能被压住。
// 只处理向上的尖峰；缺值（丢包）的点保持 null，不回填成假的延迟。
export function clampPingSpikes(
  rows: PingChartRow[],
  keys: string[],
  windowSize = 15,
  minRiseMs = 5,
  riseRatio = 0.5,
): PingChartRow[] {
  if (rows.length === 0 || keys.length === 0) return rows;
  const half = Math.floor(windowSize / 2);
  const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const result = rows.map((row) => ({ ...row }));

  for (const key of keys) {
    // 先按原值判定、再统一落笔，避免前面压低的点反过来影响后面的邻近中位数。
    const clamped = new Map<number, number>();
    for (let index = 0; index < rows.length; index += 1) {
      const current = rows[index][key];
      if (!isNum(current)) continue;
      const neighbors: number[] = [];
      for (let p = Math.max(0, index - half); p <= Math.min(rows.length - 1, index + half); p += 1) {
        if (p === index) continue;
        const neighbor = rows[p][key];
        if (isNum(neighbor)) neighbors.push(neighbor);
      }
      if (neighbors.length < 3) continue;
      const median = medianOf(neighbors);
      if (current - median > Math.max(minRiseMs, median * riseRatio)) clamped.set(index, median);
    }
    for (const [index, value] of clamped) result[index][key] = value;
  }
  return result;
}

/** 延迟 Y 轴：固定 5 个等距整数刻度（含两端），domain 取刻度首尾。 */
export function buildPingYAxis(domain: [number, number]): { domain: [number, number]; ticks: number[] } {
  const lo = Math.max(0, Math.floor(domain[0]));
  const rawHi = Math.max(lo + 4, Math.ceil(domain[1]));
  const step = Math.max(1, Math.ceil((rawHi - lo) / 4));
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + step * i);
  return { domain: [ticks[0], ticks[4]], ticks };
}
