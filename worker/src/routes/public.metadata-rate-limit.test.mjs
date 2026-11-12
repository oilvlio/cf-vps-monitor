import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { guardPublicMetadata } = createWorkerLoader({ db: null }).load('worker/src/routes/public.ts');

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

// --- 配了绑定就走本地计数，不碰 RATE_LIMIT DO ---
{
  const keys = [];
  let calls = 0;
  const c = fakeContext({
    PUBLIC_METADATA_RATE_LIMITER: {
      limit: async ({ key }) => {
        keys.push(key);
        calls += 1;
        return { success: calls <= 2 };
      },
    },
    RATE_LIMIT: {
      idFromName: () => { throw new Error('DO should not be used when the binding is configured'); },
      get: () => { throw new Error('DO should not be used when the binding is configured'); },
    },
  });

  assert.equal(await guardPublicMetadata(c, 'monitor-nodes'), null);
  assert.equal(await guardPublicMetadata(c, 'monitor-nodes'), null);
  const limited = await guardPublicMetadata(c, 'monitor-nodes');
  assert.equal(limited.status, 429);
  // 真实的 Hono 会把 c.header() 合进最终响应；这里验证调用确实发生。
  assert.equal(c.headers.get('cache-control'), 'no-store');
  assert.equal(c.headers.get('retry-after'), '60');
  assert.deepEqual(keys, [
    'metadata:monitor-nodes:203.0.113.9',
    'metadata:monitor-nodes:203.0.113.9',
    'metadata:monitor-nodes:203.0.113.9',
  ]);
}

// --- 绑定异常时退回 isolate 本地计数，不让接口整体 500 ---
{
  const c = fakeContext({
    PUBLIC_METADATA_RATE_LIMITER: { limit: async () => { throw new Error('binding unavailable'); } },
  });
  assert.equal(await guardPublicMetadata(c, 'settings'), null);
}

// --- 没有绑定时保持原有的 DO 行为（这里用可用的 RATE_LIMIT 桩验证仍会走它） ---
{
  let doCalls = 0;
  const c = fakeContext({
    RATE_LIMIT: {
      idFromName: value => value,
      get: () => ({
        fetch: async () => {
          doCalls += 1;
          return Response.json({ allowed: true, limit: 120, remaining: 119, retryAfter: 0 });
        },
      }),
    },
  });
  assert.equal(await guardPublicMetadata(c, 'nodes'), null);
  assert.equal(doCalls, 1, '未配置绑定时应继续使用 RATE_LIMIT DO');
}

console.log('public metadata rate limit tests passed');
