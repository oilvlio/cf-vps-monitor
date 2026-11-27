import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('Agent WebSocket authenticates the Bearer header and never forwards URL query data', async () => {
  const token = 'b'.repeat(64);
  let forwarded;
  const loader = createWorkerLoader({ db: {
    getClientIdentityByToken: async (_database, value) => {
      assert.equal(value, token);
      return { uuid: 'node', name: 'Node', hidden: false };
    },
    markClientTokenUsed: async () => ({ updated: false }),
  } });
  const { clientRoutes } = loader.load('worker/src/routes/client.ts');
  const response = await clientRoutes.fetch(new Request('https://monitor.test/report?unrelated=discarded', {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
  }), { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: async request => {
    forwarded = new URL(request.url);
    return new Response('upgrade forwarded');
  } }) } });
  assert.equal(response.status, 200);
  assert.equal(forwarded.searchParams.get('id'), 'node');
  assert.equal(forwarded.searchParams.has('token'), false);
  assert.equal(forwarded.searchParams.has('unrelated'), false);
});
