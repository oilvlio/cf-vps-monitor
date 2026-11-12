import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

test('DO location diagnostics report the colo of the DO outbound request', async () => {
  const requests = [];
  const loader = createWorkerLoader({
    globals: {
      fetch: async (input) => {
        requests.push(String(input));
        return new Response('fl=123\ncolo=SIN\nloc=SG\n', { status: 200 });
      },
    },
  });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(createDurableState().state, {});
  const request = new Request('https://do/diagnostics/location');
  Object.defineProperty(request, 'cf', { value: { colo: 'HKG', country: 'HK' } });

  const response = await object.fetch(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cfColo, 'HKG');
  assert.equal(body.cfCountry, 'HK');
  assert.equal(body.traceColo, 'SIN');
  assert.equal(body.traceError, null);
  assert.deepEqual(requests, ['https://www.cloudflare.com/cdn-cgi/trace']);
});

test('DO location diagnostics keep working when the trace request fails', async () => {
  const loader = createWorkerLoader({
    globals: {
      fetch: async () => {
        throw new Error('egress blocked');
      },
    },
  });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(createDurableState().state, {});

  const response = await object.fetch(new Request('https://do/diagnostics/location'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.traceColo, null);
  assert.match(body.traceError, /egress blocked/);
});
