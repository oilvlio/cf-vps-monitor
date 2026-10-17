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

// ---- 断点桥接 / 孤立点 / Y 轴刻度 ----
const { buildPingGapLayers, buildPingYAxis, pingGapThresholdMs, pingSolidKey, pingDashKey } = await import('./pingChartView.ts');

// 阈值：不低于 3 个探测周期
assert.equal(pingGapThresholdMs([0, 60000], 60), 180000);

// 任务 a：0,1,2 分钟连续，随后 30 分钟没数据，再 1 个孤立点，再 30 分钟后又 2 个连续点。
const min = 60000;
const at = (m) => m * min;
const rowsIn = [0, 1, 2, 32, 62, 63].map((m) => ({ time: at(m), a: 50 }));
// 另一任务 b 的行穿插在中间（a 在这些行上为 null）：不能因此断线。
rowsIn.splice(1, 0, { time: at(0.5), a: null });
const layers = buildPingGapLayers(rowsIn, [{ key: 'a', intervalSec: 60 }], false);
const byTime = (t) => layers.rows.find((r) => r.time === at(t));
assert.equal(byTime(0.5)[pingSolidKey('a')], 50, '穿插行应被实线桥接');
assert.equal(byTime(0.5).a, null, '原始字段不被改写');
assert.equal(byTime(2)[pingDashKey('a')], 50, '长缺口起点进入虚线层');
assert.equal(byTime(32)[pingDashKey('a')], 50);
assert.equal(byTime(32)[pingSolidKey('a')], 50);
assert.ok(layers.isolated.get('a').has(at(32)), '前后都隔了很久的点是孤立点');
assert.ok(!layers.isolated.get('a').has(at(1)));
// 孤立点 32 → 62 之间也是长缺口，应有虚线
assert.equal(byTime(62)[pingDashKey('a')], 50);

// 全部连线：没有虚线层
const all = buildPingGapLayers(rowsIn, [{ key: 'a', intervalSec: 60 }], true);
assert.ok(all.rows.every((r) => r[pingDashKey('a')] === undefined));

// 单点序列是孤立点
const single = buildPingGapLayers([{ time: 1, a: 10 }], [{ key: 'a', intervalSec: 60 }], false);
assert.ok(single.isolated.get('a').has(1));

// Y 轴：恰好 5 个等距刻度
for (const d of [[128, 211], [0, 100], [20, 21], [57.2, 489.9]]) {
  const y = buildPingYAxis(d);
  assert.equal(y.ticks.length, 5);
  const step = y.ticks[1] - y.ticks[0];
  assert.ok(step >= 1);
  assert.ok(y.ticks.every((t, i) => t === y.ticks[0] + step * i));
  assert.ok(y.domain[0] <= d[0] && y.domain[1] >= d[1]);
}
console.log('gap layers ok');
