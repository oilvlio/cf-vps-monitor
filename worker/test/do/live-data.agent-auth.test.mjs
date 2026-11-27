import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

test('rotating an auth snapshot revokes the old hash and removal revokes the new hash', async () => {
  const storage = createDurableState();
  const { LiveDataDO } = createWorkerLoader().load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  const post = (path, body) => object.fetch(new Request(`https://do${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const client = { uuid: 'node', name: 'node', hidden: false, token_hash: 'old' };
  await post('/agent-auth', { client });
  await post('/agent-auth', { client: { ...client, token_hash: 'new' } });
  assert.equal((await post('/agent-auth/lookup', { token_hash: 'old' })).status, 404);
  assert.equal((await post('/agent-auth/lookup', { token_hash: 'new' })).status, 200);
  // Old deployments may already contain orphaned snapshots: reject and clean them.
  storage.values.set('agent-auth:orphan', { ...client, token_hash: 'orphan' });
  assert.equal((await post('/agent-auth/lookup', { token_hash: 'orphan' })).status, 404);
  assert.equal(storage.values.has('agent-auth:orphan'), false);
  await post('/agent-auth/remove', { uuid: 'node' });
  assert.equal((await post('/agent-auth/lookup', { token_hash: 'new' })).status, 404);
});
