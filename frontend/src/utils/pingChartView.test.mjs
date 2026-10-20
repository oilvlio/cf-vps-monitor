import assert from 'node:assert/strict';

const { clampPingSpikes, pingRecordLossPercent, latencyHeatColor, lossHeatColor } = await import('./pingChartView.ts');
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

// 削峰：只压尖峰点，丢包空缺保持 null，其余点原样保留（不做平滑）。
{
  const rows = Array.from({ length: 20 }, (_, i) => ({ time: i, a: i === 10 ? 900 : i === 5 ? null : 50 }));
  const cut = clampPingSpikes(rows, ['a']);
  assert.equal(cut[5].a, null, '丢包空缺保持 null');
  assert.equal(cut[10].a, 50, '尖峰被压回邻近中位数');
  rows.forEach((row, i) => { if (i !== 10) assert.equal(cut[i].a, row.a, `非尖峰点 ${i} 必须原样保留`); });
  assert.equal(rows[10].a, 900, '不修改入参');
}

// 3ms 基线上 ±1ms 的整数抖动不是尖峰；真正的尖峰（>=10ms）才被压掉，基线点一个不动。
{
  const jitter = [3, 2, 4, 3, 3, 2, 3, 4, 3, 2, 3, 4, 3, 3, 2, 3, 4, 3, 2, 3];
  const rows = jitter.map((a, i) => ({ time: i, a }));
  rows[8].a = 42; rows[9].a = 38; // 连续两个尖峰
  const cut = clampPingSpikes(rows, ['a']);
  assert.ok(cut[8].a <= 4 && cut[9].a <= 4, '连续尖峰也被压住');
  jitter.forEach((a, i) => { if (i !== 8 && i !== 9) assert.equal(cut[i].a, a, `基线抖动点 ${i} 不应被当成尖峰`); });
}

// 相对阈值：100ms 的线要高出 50% 才算尖峰。
{
  const rows = Array.from({ length: 20 }, (_, i) => ({ time: i, a: 100 }));
  rows[6].a = 140; rows[12].a = 190;
  const cut = clampPingSpikes(rows, ['a']);
  assert.equal(cut[6].a, 140, '+40% 不算尖峰');
  assert.equal(cut[12].a, 100, '+90% 压回');
}

// 邻居不足（序列太短）时不动；向下的凹陷不算尖峰。
assert.deepEqual(clampPingSpikes([{ time: 0, a: 5 }, { time: 1, a: 900 }], ['a']), [{ time: 0, a: 5 }, { time: 1, a: 900 }]);
{
  const rows = Array.from({ length: 20 }, (_, i) => ({ time: i, a: i === 7 ? 1 : 60 }));
  assert.equal(clampPingSpikes(rows, ['a'])[7].a, 1);
}

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

// 分桶聚合数据（没有服务端统计时的退路）：avg 按样本量加权，min/max 取各桶极值；抖动无法从桶还原，为 null。
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
assert.equal(bucketSummary.jitter, null);

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
// 抖动：成功样本 [30, 50] 的样本标准差。
assert.ok(Math.abs(rawSummary.jitter - Math.sqrt(200)) < 1e-9);

// 全是丢包：latest/avg/min/max 为 null，丢包 100%。
const allLoss = getPingTaskSummary([{ time: '2026-01-01T00:00:00Z', value: -1 }]);
assert.equal(allLoss.latest, null);
assert.equal(allLoss.avg, null);
assert.equal(allLoss.min, null);
assert.equal(allLoss.max, null);
assert.equal(allLoss.loss, 100);
assert.equal(allLoss.jitter, null);
console.log('ping task summary ok');


// ---- 服务端统计优先 ----
{
  const { normalizePingTaskStats, formatPingMsDetail } = await import('./pingChart.ts');
  const stats = normalizePingTaskStats({
    '7': { samples: 1305, success_count: 1305, loss_count: 0, loss_rate: 0, avg_latency: 2.84, min_latency: 1, max_latency: 46, p50_latency: 3, p75_latency: 3.2, jitter: 1.37 },
    '8': { samples: 10, success_count: 0, loss_count: 10, loss_rate: 100, avg_latency: null, min_latency: null, max_latency: null, p50_latency: null, p75_latency: null, jitter: null },
    '9': { bogus: true },
  });
  assert.deepEqual(Object.keys(stats), ['7', '8'], '缺 samples 的条目被丢弃');
  assert.equal(stats['7'].jitter, 1.37);
  assert.equal(stats['8'].avg, null);
  assert.deepEqual(normalizePingTaskStats(null), {});

  const records = [
    { time: '2026-01-01T00:00:00Z', value: 3.5, avg_latency: 99, min_latency: 90, max_latency: 130, sample_count: 5 },
    { time: '2026-01-01T00:06:00Z', value: 4.25 },
  ];
  const summary = getPingTaskSummary(records, stats['7']);
  assert.equal(summary.latest, 4.25, '最新值仍取曲线上最后一个有效点');
  assert.equal(summary.avg, 2.84);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 46);
  assert.equal(summary.p75, 3.2);
  assert.equal(summary.loss, 0);
  assert.equal(summary.jitter, 1.37);
  assert.equal(getPingTaskSummary(records, stats['8']).loss, 100);

  assert.equal(formatPingMsDetail(3), '3 ms');
  assert.equal(formatPingMsDetail(3.04), '3.0 ms');
  assert.equal(formatPingMsDetail(3.26), '3.3 ms');
  assert.equal(formatPingMsDetail(-1), '-');
  assert.equal(formatPingMsDetail(null), '-');
}

// ---- 分桶的 p50 透传、极值带取值 ----
{
  const { normalizePingRecord, buildPingChartRows, pingBandPicks, pingSeriesHasBand } = await import('./pingChart.ts');
  const rec = normalizePingRecord({ time: '2026-01-01T00:00:00Z', value: 3.5, p50_latency: 3.5, p75_latency: 4.1, min_latency: 2, max_latency: 48, avg_latency: 5.2 });
  assert.equal(rec.p50_latency, 3.5);
  const bandTask = { id: 1, key: 'a', label: 'A', target: '', type: 'icmp', intervalSec: 60, color: '#fff' };
  const bucketed = [{ task: bandTask, records: [
    rec,
    { time: '2026-01-01T00:06:00Z', value: -1, sample_count: 6, loss_count: 6 },
  ] }];
  assert.equal(pingSeriesHasBand(bucketed), true);
  const rows = buildPingChartRows(bucketed, undefined, pingBandPicks);
  assert.deepEqual(rows.map((r) => [r.a, r.a__lo, r.a__hi]), [[3.5, 2, 48], [null, null, null]], '丢包桶没有区间');
  assert.equal(pingSeriesHasBand([{ task: bandTask, records: [{ time: '2026-01-01T00:00:00Z', value: 3 }] }]), false, '原始点没有极值带');
  assert.deepEqual(buildPingChartRows([{ task: bandTask, records: [{ time: '2026-01-01T00:00:00Z', value: 3 }] }]).map((r) => Object.keys(r).sort()), [['a', 'time']], '不传 extraPicks 不多出列');
}
console.log('ping stats / band ok');
