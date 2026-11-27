import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePublicClient, mergePublicClientPatch } from './publicClients.ts';
import { normalizePingRecord, pingPlotValue, getPingSeriesP75, getPingTaskSummary } from './pingChart.ts';
import { getExpiryInfo, getExpiryRemaining } from './billing.ts';

test('public client snapshots and patches preserve billing fields and nullable expiry', () => {
  const client = normalizePublicClient({ uuid: 'node', traffic_reset_day: 23, auto_renewal: 1, expired_at: null });
  assert.equal(client.traffic_reset_day, 23);
  assert.equal(client.auto_renewal, true);
  assert.equal(client.expired_at, null);
  const [renamed] = mergePublicClientPatch([client], { clients: { upsert: [{ uuid: 'node', name: 'Renamed' }] } });
  assert.equal(renamed.traffic_reset_day, 23);
  assert.equal(renamed.auto_renewal, true);
  assert.equal(renamed.expired_at, null);
  const [updated] = mergePublicClientPatch([renamed], { clients: { upsert: [{ uuid: 'node', traffic_reset_day: 31, auto_renewal: false, expired_at: '2027-01-01' }] } });
  assert.equal(updated.traffic_reset_day, 31);
  assert.equal(updated.auto_renewal, false);
  assert.equal(updated.expired_at, '2027-01-01');
  const [cleared] = mergePublicClientPatch([updated], { clients: { upsert: [{ uuid: 'node', expired_at: null }] } });
  assert.equal(cleared.expired_at, null);
  assert.equal(cleared.traffic_reset_day, 31);
  assert.equal(normalizePublicClient({ uuid: 'legacy' }).traffic_reset_day, 1);
  assert.equal(getExpiryInfo(null).color, 'gray');
  assert.equal(getExpiryRemaining(null).color, 'gray');
});

test('Ping nullable latency survives normalization and never becomes a zero-ms sample', () => {
  const fields = ['avg_latency', 'min_latency', 'max_latency', 'p50_latency', 'p75_latency'];
  const loss = normalizePingRecord({ time: '2026-01-01T00:00:00Z', value: -1, sample_count: 8,
    ...Object.fromEntries(fields.map(key => [key, null])) });
  for (const field of fields) assert.equal(loss[field], null);
  assert.equal(pingPlotValue(loss), -1);
  assert.equal(getPingSeriesP75([loss]), null);
  assert.equal(getPingTaskSummary([loss]).p75, null);
  const success = { ...loss, value: 42 };
  assert.equal(pingPlotValue(success), 42, 'missing percentile falls back to the measured value');
  assert.equal(getPingSeriesP75([loss, success]), 42);
  assert.equal(pingPlotValue({ ...success, p75_latency: 0 }), 0, 'real zero is preserved');
  assert.equal(getPingSeriesP75([{ ...success, p75_latency: 0 }]), 0);
  const legacy = normalizePingRecord({ time: loss.time, value: 20, avg_latency: Infinity, p75_latency: '0' });
  for (const field of fields) assert.equal(Object.hasOwn(legacy, field), false, field);
});
