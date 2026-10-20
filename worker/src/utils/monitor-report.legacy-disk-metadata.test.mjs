import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { normalizeMonitorReport, toMonitorRecord } = loader.load('worker/src/utils/monitor-report.ts');
const { compactLiveReport } = loader.load('worker/src/utils/live-report-state.ts');
const { toPublicReport } = loader.load('worker/src/utils/public-report.ts');
const time = 1_789_100_000_000;
const sample = { disk: 8_388_608, disk_total: 5_024_000_000, disk_source: 'directory', disk_sampled_at: time, timestamp: time + 120_000 };

test('legacy disk measurement metadata is stripped while measured bytes are retained', () => {
  const normalized = normalizeMonitorReport({ ...sample, scan_path: '/private/root', scan_error: 'private extension' });
  const stored = JSON.parse(JSON.stringify(compactLiveReport(normalized)));
  for (const value of [normalized, compactLiveReport(normalized), toPublicReport(normalized), toPublicReport(compactLiveReport(normalizeMonitorReport(stored)))]) {
    assert.equal(value.disk, 8_388_608);
    assert.equal(value.disk_total, 5_024_000_000);
    assert.equal(value.disk_source, undefined);
    assert.equal(value.disk_sampled_at, undefined);
    assert.equal(value.timestamp, time + 120_000);
  }
  for (const value of [toPublicReport(normalized), toPublicReport(compactLiveReport(normalizeMonitorReport(stored)))]) {
    assert.equal(value.scan_path, undefined);
    assert.equal(value.scan_error, undefined);
  }
});

for (const extra of [
  { disk_source: 'quota' }, { disk_source: null }, { disk_source: undefined },
  { disk_sampled_at: undefined }, { disk_sampled_at: null }, { disk_sampled_at: 0 },
  { disk_sampled_at: -1 }, { disk_sampled_at: time + 0.5 }, { disk_sampled_at: String(time) },
  { disk_sampled_at: 8_640_000_000_000_001 },
]) {
  test(`legacy metadata does not alter a normal disk sample: ${JSON.stringify(extra)}`, () => {
    const report = normalizeMonitorReport({ ...sample, ...extra });
    assert.equal(report.disk, 8_388_608);
    assert.equal(report.disk_total, 5_024_000_000);
    assert.equal(report.disk_source, undefined);
    assert.equal(report.disk_sampled_at, undefined);
    assert.equal(compactLiveReport(report).disk, 8_388_608);
  });
}

test('legacy disk bytes still persist real zero and over-allocation history', () => {
  for (const used of [0, 6_000_000_000]) {
    const value = normalizeMonitorReport({ ...sample, disk: used });
    const record = toMonitorRecord('synthetic-node', '2026-09-11T07:00:00Z', value);
    assert.equal(value.disk, used);
    assert.equal(value.disk_source, undefined);
    assert.equal(record.disk, used);
    assert.equal(record.time, '2026-09-11T07:00:00Z');
  }
  const native = normalizeMonitorReport({ disk: 12, disk_total: 100 });
  assert.equal(native.disk, 12);
  assert.equal(native.disk_source, undefined);
  assert.equal(native.disk_sampled_at, undefined);
});

test('legacy disk history retains measured bytes when capacity is unknown without inventing a percentage', () => {
  for (const used of [0, 8_388_608]) {
    const normalized = normalizeMonitorReport({ ...sample, disk: used, disk_total: null });
    const record = toMonitorRecord('synthetic-node', '2026-09-11T07:00:00Z', normalized);
    assert.equal(record.disk, used);
    assert.equal(record.disk_total, 0, 'zero total keeps the historical percentage unavailable');
    assert.equal(record.time, '2026-09-11T07:00:00Z');
  }
});
