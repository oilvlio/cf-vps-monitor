import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

function harness() {
  const calls = [];
  let next = true;
  const loader = createWorkerLoader({ db: {
    getLoadNotification: async (_database, id) => {
      calls.push(['get', id]);
      return { id, name: 'rule' };
    },
    updateLoadNotification: async (_database, id, data) => {
      calls.push(['update', id, data]);
      const changed = next;
      next = false;
      return changed;
    },
    deleteLoadNotification: async (_database, id) => {
      calls.push(['delete', id]);
    },
  } });
  return { calls, adminRoutes: loader.load('worker/src/routes/admin.ts').adminRoutes };
}

const env = {};
const plain = value => JSON.parse(JSON.stringify(value));
const payload = {
  id: 12,
  name: 'load rule',
  clients: [],
  all_clients: true,
  metric: 'cpu',
  threshold: 80,
  ratio: 0.8,
  interval_min: 5,
};

function post(body, path = '/notification/load/delete') {
  return new Request(`https://panel.example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('legacy delete forwards to the same core as DELETE /:id', async () => {
  {
    const { calls, adminRoutes } = harness();
    const response = await adminRoutes.fetch(
      new Request('https://panel.example.test/notification/load/12', { method: 'DELETE' }),
      env,
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(plain(calls), [['delete', 12]]);
  }
  {
    const { calls, adminRoutes } = harness();
    const response = await adminRoutes.fetch(post({ id: 12 }), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(plain(calls), [['delete', 12]], '兼容入口必须走同一份删除实现');
  }
});

test('legacy edit forwards to the same core as POST /:id', async () => {
  {
    const { calls, adminRoutes } = harness();
    const response = await adminRoutes.fetch(
      post(payload, '/notification/load/12'),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true, changed: 1, noop: false });
    assert.deepEqual(plain(calls), [
      ['get', 12],
      ['update', 12, {
        name: 'load rule',
        clients: [],
        metric: 'cpu',
        threshold: 80,
        ratio: 0.8,
        interval_min: 5,
      }],
    ]);
  }
  {
    const { calls, adminRoutes } = harness();
    const response = await adminRoutes.fetch(
      post(payload, '/notification/load/edit'),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true, changed: 1, noop: false });
    assert.deepEqual(plain(calls), [
      ['get', 12],
      ['update', 12, {
        name: 'load rule',
        clients: [],
        metric: 'cpu',
        threshold: 80,
        ratio: 0.8,
        interval_min: 5,
      }],
    ], '兼容入口必须走同一份更新实现');
  }
});

test('legacy aliases keep rejecting invalid ids', async () => {
  const { calls, adminRoutes } = harness();
  for (const request of [
    post({ id: 0 }),
    post({ id: 'not-a-number' }),
    post({ id: 0 }, '/notification/load/edit'),
    post({ id: 'not-a-number' }, '/notification/load/edit'),
  ]) {
    const response = await adminRoutes.fetch(request, env, {});
    assert.equal(response.status, 400);
  }
  assert.deepEqual(plain(calls), [], '非法 id 不应触达数据库');
});
