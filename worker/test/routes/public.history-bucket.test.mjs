import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { historyBucketSec } = createWorkerLoader().load('worker/src/routes/public.ts');
const { resolvePingHistoryPlan } = createWorkerLoader().load('worker/src/utils/history-bucket.ts');
const { resolveHistoryPlan } = createWorkerLoader().load('worker/src/utils/history-bucket.ts');
const { publicHistoryCacheKey, publicCacheRequest } = createWorkerLoader({ expose: {
  'worker/src/routes/public.ts': ['publicHistoryCacheKey', 'publicCacheRequest'],
} }).load('worker/src/routes/public.ts');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 12h 以内读原始（含 10 分钟余量：前端 start/end 是两次独立取时间，会比名义区间多几毫秒）
assert.equal(historyBucketSec(4 * HOUR), null);
assert.equal(historyBucketSec(4 * HOUR + 3), null);
assert.equal(historyBucketSec(12 * HOUR), null);
assert.equal(historyBucketSec(12 * HOUR + 5), null);
assert.equal(historyBucketSec(12 * HOUR + 10 * 60 * 1000), null);

// 更长的窗口分桶，每档约 720 点；步长是 120s 的整数倍（60s / 120s 探测间隔都整除）
assert.equal(historyBucketSec(12 * HOUR + 10 * 60 * 1000 + 1), 360);
assert.equal(historyBucketSec(DAY), 360);
assert.equal(historyBucketSec(3 * DAY), 360);
assert.equal(historyBucketSec(3.5 * DAY), 360);
assert.equal(historyBucketSec(3.5 * DAY + 1), 840);
assert.equal(historyBucketSec(7 * DAY), 840);
assert.equal(historyBucketSec(30 * DAY), 1800);

for (const [rangeMs, points] of [[DAY, 240], [3 * DAY, 720], [7 * DAY, 720]]) {
  const step = historyBucketSec(rangeMs);
  assert.equal(step % 120, 0, `步长 ${step}s 应是 120s 的整数倍`);
  assert.equal(Math.ceil(rangeMs / 1000 / step), points);
  assert.ok(points <= 1000, '桶数不超过单次返回上限');
}
assert.equal(JSON.stringify(resolvePingHistoryPlan(7 * DAY, 420)), JSON.stringify({ source: 'raw', stepSec: 420 }));
assert.equal(JSON.stringify(resolvePingHistoryPlan(7 * DAY + 3, 840)), JSON.stringify({ source: 'raw', stepSec: 840 }));
assert.equal(JSON.stringify(resolvePingHistoryPlan(7 * DAY + 10 * 60 * 1000, 840)), JSON.stringify({ source: 'raw', stepSec: 840 }));
assert.equal(JSON.stringify(resolvePingHistoryPlan(7 * DAY + 10 * 60 * 1000 + 1, 840)), JSON.stringify({ source: 'rollup', stepSec: 1800 }));
assert.equal(JSON.stringify(resolvePingHistoryPlan(8 * DAY, 3600)), JSON.stringify({ source: 'rollup', stepSec: 3600 }));
assert.equal(JSON.stringify(resolvePingHistoryPlan(30 * DAY, 10080)), JSON.stringify({ source: 'rollup', stepSec: 10800 }));

for (const [range, options, expected] of [
  [12 * HOUR + 5, {}, { source: 'raw', stepSec: 0 }],
  [7 * DAY + 5, {}, { source: 'raw', stepSec: 1800 }],
  [8 * DAY, {}, { source: 'rollup', stepSec: 1800 }],
  [8 * DAY, { requestedStepSec: 1801 }, { source: 'rollup', stepSec: 3600 }],
  [8 * DAY, { requestedStepSec: 3601, consumer: 'monitor' }, { source: 'rollup', stepSec: 7200 }],
  [30 * DAY, { requestedStepSec: 10080, consumer: 'monitor' }, { source: 'rollup', stepSec: 10800 }],
]) {
  assert.equal(JSON.stringify(resolveHistoryPlan(range, options)), JSON.stringify(expected));
}

const nowMs = Date.parse('2026-11-22T12:17:00Z');
const cutoff = Date.parse('2026-11-20T12:00:00Z');
for (const [start, retention, range, source, step] of [
  [cutoff, 48, 3 * DAY, 'raw', 360],
  [cutoff - 1, 48, 3 * DAY, 'rollup', 1800],
  [nowMs - 3 * DAY, 48, 3 * DAY, 'rollup', 1800],
  [nowMs - 3 * DAY, 168, 3 * DAY, 'raw', 360],
  [nowMs - 20 * DAY, 720, 20 * DAY, 'raw', 1800],
  [nowMs - 20 * DAY, 168, 8 * DAY, 'rollup', 1800],
  [nowMs - 3 * DAY, 720, 3 * DAY, 'raw', 360],
  [nowMs - 8 * DAY, 720, 8 * DAY, 'raw', 1800],
]) {
  const plan = resolveHistoryPlan(range, { rangeStartMs: start, rawRetentionHours: retention, nowMs });
  assert.equal(plan.source, source);
  assert.equal(plan.stepSec, step);
}

const cacheContext = { req: { url: 'https://example.test/api/records/ping?uuid=node&start=old' } };
assert.notEqual(
  publicHistoryCacheKey(cacheContext, 'records-ping', '48'),
  publicHistoryCacheKey(cacheContext, 'records-ping', '168'),
  'memory history cache keys include the source-retention version',
);
const edgeKey = new URL(publicCacheRequest(cacheContext, '48').url);
assert.equal(edgeKey.searchParams.get('__history_retention'), '48');
