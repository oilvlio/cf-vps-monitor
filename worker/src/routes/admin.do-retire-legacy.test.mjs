import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('admin do-retire-legacy targets the previous object name', async () => {
  const requests = [];
  const env = {
    LIVE_DATA: {
      idFromName: name => ({ name, toString: () => name }),
      get: id => ({
        fetch: async request => {
          requests.push({ object: id.name, url: request.url, method: request.method });
          return Response.json({ closed: 3, total: 3 });
        },
      }),
    },
  };
  const loader = createWorkerLoader({ db: {} });
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');

  const response = await adminRoutes.request('/do-retire-legacy', { method: 'GET' }, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.legacyObjectId, 'global');
  assert.equal(body.closed, 3);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].object, 'global');
  assert.equal(requests[0].url, 'https://do/retire');
  assert.equal(requests[0].method, 'POST');
});
