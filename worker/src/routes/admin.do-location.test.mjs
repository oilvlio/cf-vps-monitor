import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('admin do-location proxies the DO location diagnostic', async () => {
  const requests = [];
  const env = {
    LIVE_DATA: {
      idFromName: name => ({ name, toString: () => `id-${name}` }),
      get: () => ({
        fetch: async request => {
          requests.push(request.url);
          return Response.json({ cfColo: 'SIN', traceColo: 'SIN', traceError: null });
        },
      }),
    },
  };
  const loader = createWorkerLoader({ db: {} });
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');

  const response = await adminRoutes.request('/do-location', { method: 'GET' }, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.status, 200);
  assert.equal(body.durableObjectId, 'id-global');
  assert.equal(body.traceColo, 'SIN');
  assert.deepEqual(requests, ['https://do/diagnostics/location']);
});

test('admin do-location reports a DO probe failure as 502', async () => {
  const env = {
    LIVE_DATA: {
      idFromName: name => ({ name, toString: () => `id-${name}` }),
      get: () => ({
        fetch: async () => {
          throw new Error('synthetic DO outage');
        },
      }),
    },
  };
  const loader = createWorkerLoader({ db: {} });
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');

  const response = await adminRoutes.request('/do-location', { method: 'GET' }, env);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'DO location probe failed');
  assert.match(body.detail, /synthetic DO outage/);
});
