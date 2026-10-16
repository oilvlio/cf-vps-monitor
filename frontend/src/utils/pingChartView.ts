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

// 削峰平滑：与相邻点均值相差过大的点判为尖峰剔除，再用 EWMA 抹平。
// 原本就缺值（丢包）的点保持 null，不会被回填成假的延迟。
export function cutPeakRows(
  rows: PingChartRow[],
  keys: string[],
  alpha = 0.1,
  windowSize = 15,
  spikeThreshold = 0.3,
): PingChartRow[] {
  if (rows.length === 0 || keys.length === 0) return rows;
  const result = rows.map((row) => ({ ...row }));
  const half = Math.floor(windowSize / 2);
  const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

  for (const key of keys) {
    const missing = new Set<number>();
    result.forEach((row, index) => { if (!isNum(row[key])) missing.add(index); });

    for (let index = 0; index < result.length; index += 1) {
      const current = result[index][key];
      if (!isNum(current)) continue;
      const neighbors: number[] = [];
      for (let p = Math.max(0, index - half); p <= Math.min(result.length - 1, index + half); p += 1) {
        if (p === index) continue;
        const neighbor = result[p][key];
        if (isNum(neighbor)) neighbors.push(neighbor);
      }
      if (neighbors.length < 2) continue;
      const mean = neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
      if (mean > 0 ? Math.abs(current - mean) / mean > spikeThreshold : Math.abs(current) > 10) {
        result[index][key] = null;
      }
    }

    let ewma: number | null = null;
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index][key];
      if (isNum(current)) {
        ewma = ewma == null ? current : alpha * current + (1 - alpha) * ewma;
        result[index][key] = ewma;
      } else if (ewma != null && !missing.has(index)) {
        result[index][key] = ewma;
      }
    }
  }
  return result;
}
