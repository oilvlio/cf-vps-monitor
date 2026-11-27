import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { guardPublicMetadata: metadataGuard, guardPublicHistory: historyGuard, guardPublicLive: liveGuard } =
  createWorkerLoader({ db: null }).load('worker/src/routes/public.ts');

function fakeContext(env, ip = '203.0.113.9') {
  const headers = new Map();
  return {
    env,
    req: {
      header: name => name.toLowerCase() === 'cf-connecting-ip' ? ip : undefined,
    },
    header: (name, value) => headers.set(name.toLowerCase(), value),
    json: (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    headers,
  };
}

function rejectingDurableObject() {
  return {
    idFromName: () => { throw new Error('DO should not be used for high-frequency public reads'); },
    get: () => { throw new Error('DO should not be used for high-frequency public reads'); },
  };
}

// --- metadata：绑定按机房计数，不碰 RATE_LIMIT DO ---
{
  const keys = [];
  let calls = 0;
  const c = fakeContext({
    RATE_LIMIT_120: {
      limit: async ({ key }) => {
        keys.push(key);
        calls += 1;
        return { success: calls <= 2 };
      },
    },
    RATE_LIMIT: rejectingDurableObject(),
  });

  assert.equal(await metadataGuard(c, 'monitor-nodes'), null);
  assert.equal(await metadataGuard(c, 'monitor-nodes'), null);
  const limited = await metadataGuard(c, 'monitor-nodes');
  assert.equal(limited.status, 429);
  assert.equal(c.headers.get('cache-control'), 'no-store');
  assert.equal(c.headers.get('retry-after'), '60');
  assert.deepEqual(keys, [
    'metadata:monitor-nodes:203.0.113.9',
    'metadata:monitor-nodes:203.0.113.9',
    'metadata:monitor-nodes:203.0.113.9',
  ]);
}

// --- history / live：按各自额度选择原生绑定 ---
{
  const seen = [];
  const c = fakeContext({
    RATE_LIMIT_60: { limit: async ({ key }) => { seen.push(`60:${key}`); return { success: true }; } },
    RATE_LIMIT_180: { limit: async ({ key }) => { seen.push(`180:${key}`); return { success: false }; } },
    RATE_LIMIT: rejectingDurableObject(),
  });

  assert.equal(await historyGuard(c, 'node-1'), null);
  const liveLimited = await liveGuard(c);
  assert.equal(liveLimited.status, 429);
  assert.deepEqual(seen, [
    '60:history:node-1:203.0.113.9',
    '180:live:203.0.113.9',
  ]);
}

// --- 绑定异常时退回 isolate 本地计数，不让接口整体 500 ---
{
  const c = fakeContext({
    RATE_LIMIT_120: { limit: async () => { throw new Error('binding unavailable'); } },
    RATE_LIMIT: rejectingDurableObject(),
  });
  assert.equal(await metadataGuard(c, 'settings'), null);
}

// --- 没有绑定时退回本地计数，而不是旧的 RATE_LIMIT DO ---
{
  const c = fakeContext({ RATE_LIMIT: rejectingDurableObject() });
  assert.equal(await metadataGuard(c, 'nodes'), null);
  assert.equal(await historyGuard(c, 'nodes'), null);
  assert.equal(await liveGuard(c), null);
}

console.log('public rate limit tests passed');
