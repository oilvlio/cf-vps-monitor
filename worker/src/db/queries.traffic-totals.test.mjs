import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

let calls = 0;
let failNext = false;

const loader = createWorkerLoader({
  // 只替换上游 RPC；保留真实的 queries.ts 模块（默认的 db 覆盖会把它换成空对象）。
  db: null,
  overrides: {
    'worker/src/db/supabase-api/client.ts': {
      getSupabaseTrafficTotals: async (_env, clients) => {
        calls += 1;
        await Promise.resolve();
        if (failNext) throw new Error('upstream unavailable');
        return Object.fromEntries(clients.map(uuid => [uuid, {
          day_rx: 1, day_tx: 2, total_rx: 3, total_tx: 4,
        }]));
      },
    },
  },
});

const { getTrafficTotals } = loader.load('worker/src/db/queries.ts');
const env = { marker: 'shared-env' };
const database = { provider: 'supabase-api', env };

// --- 同一节点集合短期复用，和调用顺序无关 ---
{
  const first = await getTrafficTotals(database, ['a', 'b']);
  assert.equal(calls, 1);
  assert.equal(first.a.day_rx, 1);

  const lookup = {};
  const second = await getTrafficTotals(database, ['b', 'a'], lookup);
  assert.equal(calls, 1, '同一批节点不应重复查询');
  assert.equal(lookup.cached, true);
  assert.deepEqual(second, first);
}

// --- 并发未命中只打一次上游 ---
{
  const [left, right] = await Promise.all([
    getTrafficTotals(database, ['c', 'd']),
    getTrafficTotals(database, ['d', 'c']),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(left, right);

  const lookup = {};
  await getTrafficTotals(database, ['c', 'd'], lookup);
  assert.equal(calls, 2);
  assert.equal(lookup.cached, true);
}

// --- 节点集合变化必须重新查询 ---
{
  await getTrafficTotals(database, ['a']);
  assert.equal(calls, 3, '不同的节点集合不能共用缓存');

  const lookup = {};
  await getTrafficTotals(database, ['a'], lookup);
  assert.equal(calls, 3);
  assert.equal(lookup.cached, true);
}

// --- 失败的请求不缓存，下一次仍会重试 ---
{
  failNext = true;
  await assert.rejects(getTrafficTotals(database, ['e']));
  failNext = false;
  const lookup = {};
  await getTrafficTotals(database, ['e'], lookup);
  assert.equal(calls, 5, '失败不应该留下 10 秒的空缓存');
  assert.notEqual(lookup.cached, true);
}

// --- 不同部署环境（不同 env 对象）互不影响 ---
{
  await getTrafficTotals({ provider: 'supabase-api', env: { marker: 'other-env' } }, ['a', 'b']);
  assert.equal(calls, 6);
}

console.log('traffic totals cache tests passed');
