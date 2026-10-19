import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_PING_STALE_MS,
  buildHomePingNode,
  buildHomePingSummary,
  homePingQueryRange,
} from './home-ping.ts';

const MIN = 60_000;
// 对齐到 5 分钟边界，方便按桶断言。
const NOW = Date.UTC(2026, 9, 14, 12, 2, 0);
const iso = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();
const source = (rows) => ({ task_id: 7, name: '电信', rows });

test('sparse change log is forward-filled: a lone loss row covers its whole span', () => {
  // 12:02 是 NOW。最后一个桶 12:00-12:05；-40 分钟处丢包，-10 分钟处恢复。
  const node = buildHomePingNode(source([
    { time: iso(-60), value: 50 },
    { time: iso(-40), value: -1 },
    { time: iso(-10), value: 80 },
  ]), NOW);

  assert.equal(node.points.length, 24);
  const byOffset = (minutes) => node.points.find((p) => p.t === Date.UTC(2026, 9, 14, 12, 0) + minutes * MIN);
  // 11:20 - 11:50 之间整桶丢包，只有一行记录也要整段算丢包。
  assert.equal(byOffset(-35).loss_percent, 100);
  assert.equal(byOffset(-35).latency_ms, null);
  // 11:00 的桶在丢包行（11:22）之前是正常的，之后丢包，按时长加权。
  assert.equal(byOffset(-60).loss_percent, 0);
  // 恢复之后正常。
  assert.equal(byOffset(0).loss_percent, 0);
  assert.equal(byOffset(0).latency_ms, 80);
  assert.ok(node.loss_percent > 0 && node.loss_percent < 100);
});

test('seed row before the window carries into the first bucket until it goes stale', () => {
  // 窗口起点约在 -115 分钟；种子行在 -130 分钟，40 分钟内仍然有效，所以第一桶应沿用它。
  const node = buildHomePingNode(source([{ time: iso(-130), value: 130 }]), NOW);
  assert.equal(node.points[0].latency_ms, 130);
  assert.equal(node.points[0].loss_percent, 0);
  // 种子行在 -90 分钟过期，之后没有新数据的桶是「无数据」，不是沿用旧状态。
  const afterStale = node.points.find((p) => p.t === Date.UTC(2026, 9, 14, 12, 0) - 60 * MIN);
  assert.equal(afterStale.latency_ms, null);
  assert.equal(afterStale.loss_percent, null);
  assert.equal(node.latency_ms, null, 'stale last row must not be reported as current latency');
});

test('a row older than the heartbeat window stops covering time', () => {
  const node = buildHomePingNode(source([{ time: iso(-100), value: 60 }]), NOW);
  const covered = node.points.filter((p) => p.latency_ms !== null);
  const spanMin = covered.length * 5;
  assert.ok(spanMin <= HOME_PING_STALE_MS / MIN + 10, `covered ${spanMin} minutes`);
  assert.equal(node.latency_ms, null);
});

test('current latency is the latest row; lost latest row yields null latency', () => {
  const ok = buildHomePingNode(source([{ time: iso(-20), value: 90 }, { time: iso(-3), value: 156.4 }]), NOW);
  assert.equal(ok.latency_ms, 156);
  assert.equal(ok.loss_percent, 0);

  const lost = buildHomePingNode(source([{ time: iso(-20), value: 90 }, { time: iso(-3), value: -1 }]), NOW);
  assert.equal(lost.latency_ms, null);
  assert.ok(lost.loss_percent > 0);
});

test('summary wraps every node and reports bucket geometry', () => {
  const summary = buildHomePingSummary({ a: source([{ time: iso(-1), value: 20 }]) }, NOW, 300, 12);
  assert.equal(summary.bucket_sec, 300);
  assert.equal(summary.bucket_count, 12);
  assert.equal(summary.nodes.a.points.length, 12);
  assert.equal(summary.nodes.a.task_name, '电信');
});

test('query range looks back before the first bucket to find a seed row', () => {
  const range = homePingQueryRange(NOW);
  assert.ok(Date.parse(range.start) < NOW - 24 * 5 * MIN);
  assert.equal(range.end, new Date(NOW).toISOString());
});
