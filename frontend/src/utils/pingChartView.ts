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

// ---------------------------------------------------------------------------
// 断点处理：缺口用虚线桥接，前后都没有记录的孤立点画成圆点。
//
// 各任务的记录时间并不对齐（共用一组时间行，某任务在别人的行上为 null），
// 所以不能把 null 一概当作"断了"。这里按每个任务自己的记录间隔判断：
// 相邻两条记录间隔不超过阈值 → 实线连接；超过阈值 → 虚线连接（真的有一段没数据）。
// 桥接用的值只是几何插值，只写进 `~b` / `~d` 两个绘图专用字段，
// 原始字段不动，tooltip 读到的仍是真实采样值。
// ---------------------------------------------------------------------------

export const pingSolidKey = (key: string) => `${key}~b`;
export const pingDashKey = (key: string) => `${key}~d`;

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 缺口阈值：取该任务实际记录间隔中位数的 3 倍，且不低于 3 个探测周期。 */
export function pingGapThresholdMs(times: number[], intervalSec: number): number {
  const floor = Math.max(1, intervalSec) * 1000 * 3;
  if (times.length < 3) return floor;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  return Math.max(floor, gaps[Math.floor(gaps.length / 2)] * 3);
}

export interface PingGapLayers {
  rows: PingChartRow[];
  /** key -> 孤立点的时间戳集合 */
  isolated: Map<string, Set<number>>;
}

export function buildPingGapLayers(
  rows: PingChartRow[],
  tasks: Array<{ key: string; intervalSec: number }>,
  connectAll: boolean,
): PingGapLayers {
  const out = rows.map((row) => ({ ...row }));
  const isolated = new Map<string, Set<number>>();

  for (const { key, intervalSec } of tasks) {
    const idx: number[] = [];
    out.forEach((row, i) => { if (isNum(row[key])) idx.push(i); });
    const times = idx.map((i) => Number(out[i].time));
    const threshold = connectAll ? Infinity : pingGapThresholdMs(times, intervalSec);
    const iso = new Set<number>();
    isolated.set(key, iso);

    const solid = pingSolidKey(key);
    const dash = pingDashKey(key);

    for (let n = 0; n < idx.length; n += 1) {
      const here = idx[n];
      out[here][solid] = out[here][key];
      const gapBefore = n > 0 ? times[n] - times[n - 1] : Infinity;
      const gapAfter = n < idx.length - 1 ? times[n + 1] - times[n] : Infinity;
      if (gapBefore > threshold && gapAfter > threshold) iso.add(times[n]);
      if (idx.length === 1) iso.add(times[n]);
      if (n === idx.length - 1) break;

      const next = idx[n + 1];
      const target = gapAfter <= threshold ? solid : dash;
      const v0 = out[here][key] as number;
      const v1 = out[next][key] as number;
      const t0 = times[n];
      const t1 = times[n + 1];
      out[here][target] = v0;
      out[next][target] = v1;
      for (let r = here + 1; r < next; r += 1) {
        const ratio = t1 === t0 ? 0 : (Number(out[r].time) - t0) / (t1 - t0);
        out[r][target] = v0 + (v1 - v0) * ratio;
      }
    }
  }
  return { rows: out, isolated };
}

/** 延迟 Y 轴：固定 5 个等距整数刻度（含两端），domain 取刻度首尾。 */
export function buildPingYAxis(domain: [number, number]): { domain: [number, number]; ticks: number[] } {
  const lo = Math.max(0, Math.floor(domain[0]));
  const rawHi = Math.max(lo + 4, Math.ceil(domain[1]));
  const step = Math.max(1, Math.ceil((rawHi - lo) / 4));
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + step * i);
  return { domain: [ticks[0], ticks[4]], ticks };
}
