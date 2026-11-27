import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { checkNativeRateLimit, nativeRateLimiter, NATIVE_RATE_LIMIT_BINDINGS } =
  createWorkerLoader().load('worker/src/utils/native-rate-limit.ts');

const LIMITS = [5, 20, 30, 60, 120, 180, 240, 3000];

function bindings(overrides = {}) {
  const env = {};
  for (const limit of LIMITS) {
    env[`RATE_LIMIT_${limit}`] = {
      limit: async ({ key }) => ({ success: true, key }),
    };
  }
  Object.assign(env, overrides);
  return env;
}

test('every configured limit maps to a native binding', () => {
  assert.deepEqual(NATIVE_RATE_LIMIT_BINDINGS, LIMITS.map(limit => `RATE_LIMIT_${limit}`));
  for (const limit of LIMITS) {
    assert.ok(nativeRateLimiter(bindings(), limit), `limit ${limit} must resolve to a binding`);
  }
  assert.equal(nativeRateLimiter(bindings(), 42), null, 'unmapped limits do not silently share another bucket');
});

test('checks are namespaced by bucket and report the binding outcome', async () => {
  const seen = [];
  const env = bindings({
    RATE_LIMIT_60: {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: seen.length === 1 };
      },
    },
  });

  assert.equal((await checkNativeRateLimit(env, 'history:node-1', '203.0.113.9', 60)).outcome, 'allowed');
  assert.equal((await checkNativeRateLimit(env, 'history:node-1', '203.0.113.9', 60)).outcome, 'limited');
  assert.deepEqual(seen, ['history:node-1:203.0.113.9', 'history:node-1:203.0.113.9']);
});

test('missing or failing bindings fall back instead of failing the request', async () => {
  const env = bindings();
  delete env.RATE_LIMIT_120;
  assert.equal((await checkNativeRateLimit(env, 'metadata', '1.2.3.4', 120)).outcome, 'unavailable');

  env.RATE_LIMIT_120 = { limit: async () => { throw new Error('binding unavailable'); } };
  assert.equal((await checkNativeRateLimit(env, 'metadata', '1.2.3.4', 120)).outcome, 'unavailable');
});
