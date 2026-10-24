import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { historyBucketSec } = createWorkerLoader().load('worker/src/routes/public.ts');
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

for (const [rangeMs, points] of [[DAY, 240], [3 * DAY, 720], [7 * DAY, 720]]) {
  const step = historyBucketSec(rangeMs);
  assert.equal(step % 120, 0, `步长 ${step}s 应是 120s 的整数倍`);
  assert.equal(Math.ceil(rangeMs / 1000 / step), points);
  assert.ok(points <= 1000, '桶数不超过单次返回上限');
}
