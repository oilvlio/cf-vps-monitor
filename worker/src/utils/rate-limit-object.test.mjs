import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('RATE_LIMIT stubs suffix the object name and use an APAC location hint', () => {
  const calls = [];
  const namespace = {
    idFromName: name => ({ name, toString: () => name }),
    get: (id, options) => {
      calls.push({ name: id.name, options });
      return { id };
    },
  };
  const loader = createWorkerLoader();
  const { RATE_LIMIT_OBJECT_NAMES, rateLimitObjectName, rateLimitId, rateLimitStub } =
    loader.load('worker/src/utils/rate-limit-object.ts');

  // 逻辑名不带后缀；实际对象名统一由 helper 加，避免某个调用点漏改而留在美区。
  assert.equal(RATE_LIMIT_OBJECT_NAMES.publicApi, 'public-api');
  assert.equal(RATE_LIMIT_OBJECT_NAMES.liveClients, 'live-clients');
  assert.equal(rateLimitObjectName('live-clients'), 'live-clients-v2');
  assert.equal(rateLimitId(namespace, RATE_LIMIT_OBJECT_NAMES.publicApi).name, 'public-api-v2');
  assert.equal(rateLimitId(namespace, RATE_LIMIT_OBJECT_NAMES.liveClients).name, 'live-clients-v2');

  rateLimitStub(namespace, RATE_LIMIT_OBJECT_NAMES.liveClients);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'live-clients-v2');
  assert.equal(calls[0].options.locationHint, 'apac-se');
});
