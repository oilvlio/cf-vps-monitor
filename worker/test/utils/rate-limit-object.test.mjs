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

  // 只有敏感低频入口还使用 DO；高频路径用原生 Rate Limiting 绑定。
  assert.equal(RATE_LIMIT_OBJECT_NAMES.publicApi, 'public-api');
  assert.equal(RATE_LIMIT_OBJECT_NAMES.setupInit, 'setup-init');
  assert.equal(RATE_LIMIT_OBJECT_NAMES.healthProbe, 'health-probe');
  assert.equal(rateLimitObjectName('setup-init'), 'setup-init-v2');
  assert.equal(rateLimitId(namespace, RATE_LIMIT_OBJECT_NAMES.publicApi).name, 'public-api-v2');
  assert.equal(rateLimitId(namespace, RATE_LIMIT_OBJECT_NAMES.setupInit).name, 'setup-init-v2');

  rateLimitStub(namespace, RATE_LIMIT_OBJECT_NAMES.setupInit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'setup-init-v2');
  assert.equal(calls[0].options.locationHint, 'apac-se');
});
