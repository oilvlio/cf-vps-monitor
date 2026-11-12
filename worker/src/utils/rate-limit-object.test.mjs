import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('RATE_LIMIT stubs use the v2 object names and an APAC location hint', () => {
  const calls = [];
  const namespace = {
    idFromName: name => ({ name, toString: () => name }),
    get: (id, options) => {
      calls.push({ name: id.name, options });
      return { id };
    },
  };
  const loader = createWorkerLoader();
  const { RATE_LIMIT_OBJECT_NAMES, rateLimitId, rateLimitStub } = loader.load('worker/src/utils/rate-limit-object.ts');

  assert.equal(RATE_LIMIT_OBJECT_NAMES.publicApi, 'public-api-v2');
  assert.equal(RATE_LIMIT_OBJECT_NAMES.agentIngress, 'agent-ingress-v2');
  assert.equal(RATE_LIMIT_OBJECT_NAMES.adminHealth, 'admin-health-v2');
  assert.equal(rateLimitId(namespace, RATE_LIMIT_OBJECT_NAMES.publicApi).name, 'public-api-v2');
  rateLimitStub(namespace, RATE_LIMIT_OBJECT_NAMES.publicApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'public-api-v2');
  assert.equal(calls[0].options.locationHint, 'apac-se');
});
