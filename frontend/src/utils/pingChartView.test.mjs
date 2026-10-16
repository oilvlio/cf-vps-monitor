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
