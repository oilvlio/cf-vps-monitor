import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_PING_LOOKBACK_MS,
  HOME_PING_SAMPLE_COUNT,
  buildHomePingNode,
  buildHomePingSummary,
  homePingQueryRange,
} from './home-ping.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 14, 12, 2, 0);
const iso = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();
const source = (rows) => ({ task_id: 7, name: '电信', rows });

test('points are the raw samples, one block per sample, oldest first', () => {
  const node = buildHomePingNode(source([
    // 故意乱序：输出必须按时间升序。
    { time: iso(-1), value: 80 },
    { time: iso(-3), value: 50 },
    { time: iso(-2), value: 65.4 },
  ]));

  assert.deepEqual(node.points, [
    { t: NOW - 3 * MIN, latency_ms: 50 },
    { t: NOW - 2 * MIN, latency_ms: 65 },
    { t: NOW - 1 * MIN, latency_ms: 80 },
  ]);
  assert.equal(node.updated_at, iso(-1));
  assert.equal(node.task_id, 7);
  assert.equal(node.task_name, '电信');
});

test('no aggregation: samples closer than any bucket width stay separate', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ time: iso(-6 + i), value: 100 + i * 10 }));
  const node = buildHomePingNode(source(rows));
  assert.equal(node.points.length, 6);
  assert.deepEqual(node.points.map((p) => p.latency_ms), [100, 110, 120, 130, 140, 150]);
});

test('only the latest N samples are kept', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ time: iso(-40 + i), value: i }));
  const node = buildHomePingNode(source(rows));
  assert.equal(node.points.length, HOME_PING_SAMPLE_COUNT);
  assert.equal(node.points.at(-1).latency_ms, 39);
  assert.equal(node.points[0].latency_ms, 40 - HOME_PING_SAMPLE_COUNT);

  const short = buildHomePingNode(source(rows), 5);
  assert.deepEqual(short.points.map((p) => p.latency_ms), [35, 36, 37, 38, 39]);
});

test('lost / timed out samples become null latency and keep their slot', () => {
  const node = buildHomePingNode(source([
    { time: iso(-3), value: 90 },
    { time: iso(-2), value: -1 },
    { time: iso(-1), value: 120 },
  ]));
  assert.deepEqual(node.points.map((p) => p.latency_ms), [90, null, 120]);

  const lastLost = buildHomePingNode(source([{ time: iso(-2), value: 90 }, { time: iso(-1), value: -1 }]));
  assert.equal(lastLost.points.at(-1).latency_ms, null);
});

test('invalid rows are ignored; empty source gives empty points', () => {
  const node = buildHomePingNode(source([
    { time: 'not-a-date', value: 10 },
    { time: iso(-1), value: Number.NaN },
  ]));
  assert.deepEqual(node.points, []);
  assert.equal(node.updated_at, null);
});

test('node payload no longer carries loss or aggregate fields', () => {
  const node = buildHomePingNode(source([{ time: iso(-1), value: 20 }]));
  assert.deepEqual(Object.keys(node).sort(), ['points', 'task_id', 'task_name', 'updated_at']);
  assert.deepEqual(Object.keys(node.points[0]).sort(), ['latency_ms', 't']);
});

test('summary wraps every node and reports the sample count', () => {
  const summary = buildHomePingSummary({ a: source([{ time: iso(-1), value: 20 }]) }, NOW, 12);
  assert.equal(summary.sample_count, 12);
  assert.equal(summary.generated_at, new Date(NOW).toISOString());
  assert.equal(summary.nodes.a.points.length, 1);
  assert.equal(summary.nodes.a.task_name, '电信');
  assert.equal(buildHomePingSummary({}, NOW).sample_count, HOME_PING_SAMPLE_COUNT);
});

test('query range ends now and looks back far enough for the slowest persist interval', () => {
  const range = homePingQueryRange(NOW);
  assert.equal(range.end, new Date(NOW).toISOString());
  assert.equal(Date.parse(range.start), NOW - HOME_PING_LOOKBACK_MS);
  // 落库间隔上限 3600 秒，24 个采样需要 24 小时。
  assert.ok(HOME_PING_LOOKBACK_MS >= HOME_PING_SAMPLE_COUNT * 3600 * 1000);
});
