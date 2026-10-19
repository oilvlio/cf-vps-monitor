import assert from 'node:assert/strict';

const { cutPeakRows, pingRecordLossPercent, latencyHeatColor, lossHeatColor } = await import('./pingChartView.ts');
const { buildPingChartRows } = await import('./pingChart.ts');

// 丢包率：分桶数据按 loss/sample，原始数据负值即 100%。
assert.equal(pingRecordLossPercent({ time: 't', value: 30, sample_count: 10, loss_count: 2 }), 20);
assert.equal(pingRecordLossPercent({ time: 't', value: -1 }), 100);
assert.equal(pingRecordLossPercent({ time: 't', value: 12 }), 0);

// 默认取值保持原行为：负值 -> null。
const task = { id: 1, key: 'a', label: 'A', target: '', type: 'icmp', intervalSec: 60, color: '#fff' };
const series = [{ task, records: [
  { time: '2026-01-01T00:00:00Z', value: 20 },
  { time: '2026-01-01T00:01:00Z', value: -1 },
] }];
assert.deepEqual(buildPingChartRows(series).map((r) => r.a), [20, null]);
assert.deepEqual(buildPingChartRows(series, pingRecordLossPercent).map((r) => r.a), [0, 100]);

// 削峰：尖峰被剔除，丢包空缺保持 null。
const rows = Array.from({ length: 20 }, (_, i) => ({ time: i, a: i === 10 ? 900 : i === 5 ? null : 50 }));
const cut = cutPeakRows(rows, ['a']);
assert.equal(cut[5].a, null);
assert.ok(cut[10].a !== null && cut[10].a < 100, '尖峰应被抹平');

assert.equal(latencyHeatColor(30), 'var(--lp-lat-excellent)');
assert.equal(latencyHeatColor(250), 'var(--lp-lat-critical)');
assert.equal(lossHeatColor(0), 'var(--lp-lat-excellent)');
console.log('pingChartView ok');

// ---- Y 轴刻度 ----
const { buildPingYAxis } = await import('./pingChartView.ts');

// Y 轴：恰好 5 个等距整数刻度
for (const d of [[128, 211], [0, 100], [20, 21], [57.2, 489.9]]) {
  const y = buildPingYAxis(d);
  assert.equal(y.ticks.length, 5);
  const step = y.ticks[1] - y.ticks[0];
  assert.ok(step >= 1);
  assert.ok(y.ticks.every((t, i) => t === y.ticks[0] + step * i));
  assert.ok(y.domain[0] <= d[0] && y.domain[1] >= d[1]);
}
console.log('ping y axis ok');

// ---- 任务卡片统计（Instance 卡片：均值/最小/最大/丢包/P75） ----
const { getPingTaskSummary } = await import('./pingChart.ts');

// 分桶聚合数据：avg 按样本量加权，min/max 取各桶极值，samples 为 sample_count 总和。
const bucketSummary = getPingTaskSummary([
  { time: '2026-01-01T00:00:00Z', value: 55, avg_latency: 50, min_latency: 40, max_latency: 60, sample_count: 10, loss_count: 1, p75_latency: 58 },
  { time: '2026-01-01T00:01:00Z', value: 120, avg_latency: 100, min_latency: 90, max_latency: 130, sample_count: 30, loss_count: 6, p75_latency: 125 },
]);
assert.equal(bucketSummary.latest, 120);
assert.ok(Math.abs(bucketSummary.avg - 87.5) < 1e-9, 'avg 按 sample_count 加权');
assert.equal(bucketSummary.min, 40);
assert.equal(bucketSummary.max, 130);
assert.equal(bucketSummary.p75, 125, '桶数据取桶 P75 的中位');
assert.ok(Math.abs(bucketSummary.loss - (7 / 40) * 100) < 1e-9);
assert.equal(bucketSummary.samples, 40);

// 原始数据（24h 内，没有聚合列）：对 value 做全量统计，负值即丢包。
const rawSummary = getPingTaskSummary([
  { time: '2026-01-01T00:00:00Z', value: 30 },
  { time: '2026-01-01T00:01:00Z', value: 50 },
  { time: '2026-01-01T00:02:00Z', value: -1 },
]);
assert.equal(rawSummary.latest, 50);
assert.equal(rawSummary.avg, 40);
assert.equal(rawSummary.min, 30);
assert.equal(rawSummary.max, 50);
assert.ok(Math.abs(rawSummary.p75 - 45) < 1e-9);
// 末段负值从 00:02 一直到「当前时间」，前面两小段好样本让占比略低于 100。
assert.ok(Math.abs(rawSummary.loss - 100) < 0.01);
assert.equal(rawSummary.samples, 3);

// 全是丢包：latest/avg/min/max 为 null，丢包 100%。
const allLoss = getPingTaskSummary([{ time: '2026-01-01T00:00:00Z', value: -1 }]);
assert.equal(allLoss.latest, null);
assert.equal(allLoss.avg, null);
assert.equal(allLoss.min, null);
assert.equal(allLoss.max, null);
assert.equal(allLoss.loss, 100);
assert.equal(allLoss.samples, 0);
console.log('ping task summary ok');

