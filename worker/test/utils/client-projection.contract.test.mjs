import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

test('public REST and metadata projections preserve billing fields and exclude administrative extensions', () => {
  const loader = createWorkerLoader();
  const { toPublicClient } = loader.load('worker/src/utils/public-client.ts');
  const { projectClientMetadata, projectAgentClientMetadata } = loader.load('worker/src/utils/client-metadata.ts');
  const client = { uuid: 'node', traffic_reset_day: 23, auto_renewal: false, expired_at: null,
    token: 'private-token', token_hash: 'private-hash', remark: 'private-remark', future_admin_field: 'secret' };
  for (const result of [toPublicClient(client), projectClientMetadata(client, false), projectClientMetadata(client, true)]) {
    assert.equal(result.traffic_reset_day, 23);
    assert.equal(result.auto_renewal, false);
    assert.equal(result.expired_at, null);
    for (const key of ['token', 'token_hash', 'future_admin_field']) assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(Object.hasOwn(toPublicClient(client), 'remark'), false);
  const patch = projectClientMetadata({ uuid: 'node', name: 'Renamed' }, false);
  for (const key of ['traffic_reset_day', 'auto_renewal', 'expired_at']) assert.equal(Object.hasOwn(patch, key), false);
  const agent = projectAgentClientMetadata(client);
  for (const key of ['traffic_reset_day', 'auto_renewal', 'expired_at']) assert.equal(Object.hasOwn(agent, key), false);
});

test('durable Agent auth snapshot and HTTP parser preserve reset day and nullable expiry across cold restart', async () => {
  const loader = createWorkerLoader({ expose: { 'worker/src/routes/client.ts': ['normalizeLiveAgentAuthClient'] } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const { normalizeLiveAgentAuthClient } = loader.load('worker/src/routes/client.ts');
  const storage = createDurableState();
  const object = new LiveDataDO(storage.state, {});
  const client = { uuid: 'node', token: 'private-token', token_hash: 'hash', traffic_reset_day: 23, auto_renewal: true, expired_at: null };
  const response = await object.fetch(new Request('https://do/agent-auth', { method: 'POST', body: JSON.stringify({ client }) }));
  assert.equal(response.status, 200);
  await storage.drain();
  const cold = new LiveDataDO(storage.state, {});
  const lookup = await cold.fetch(new Request('https://do/agent-auth/lookup', { method: 'POST', body: JSON.stringify({ token_hash: 'hash' }) }));
  assert.equal(lookup.status, 200);
  const snapshot = (await lookup.json()).client;
  for (const row of [snapshot, normalizeLiveAgentAuthClient(snapshot)]) {
    assert.equal(row.traffic_reset_day, 23);
    assert.equal(row.auto_renewal, true);
    assert.equal(row.expired_at, null);
    assert.equal(row.token, '');
  }
  await storage.drain();
});

test('Monitor timestamps accept numeric seconds, milliseconds and ISO strings without calendar coercion', () => {
  const { unixSeconds } = createWorkerLoader().load('worker/src/monitor/contract.ts');
  for (const value of [1, '1', ' 1 ', 1.9, '1.9']) assert.equal(unixSeconds(value), 1);
  for (const value of [1767225600, '1767225600', 1767225600123, '1767225600123', '2026-01-01T00:00:00Z']) {
    assert.equal(unixSeconds(value), 1767225600);
  }
  for (const value of [null, undefined, '', ' ', 'invalid', NaN, Infinity, -1, '-1', 0, '0']) assert.equal(unixSeconds(value), 0);
});
