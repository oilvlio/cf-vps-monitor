import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const paths = ['/api/live', '/api/ws/live', '/api/live/clients'];
const emptyLive = { online: [], count: 0 };

function fixture({ fail = '', native, admin = false, beforeRead } = {}) {
  const calls = [];
  const cache = new Map();
  const jobs = [];
  let failure = fail;
  const read = (name, value) => async () => {
    calls.push(name);
    if (beforeRead) await beforeRead(name);
    if (failure === name) throw new Error('PRIVATE_BACKEND_DETAIL');
    return value;
  };
  const loader = createWorkerLoader({
    globals: { caches: { default: {
      match: async request => cache.get(request.url)?.clone(),
      put: async (request, response) => { cache.set(request.url, response.clone()); },
    } } },
    overrides: {
      'worker/src/auth/jwt.ts': { verifyAdminToken: async () => admin ? { userId: 'admin', sessionVersion: 1 } : null },
      'worker/src/auth/admin-session.ts': { validateAdminSession: async () => admin ? { uuid: 'admin' } : null },
    },
    db: {
      listPublicClientRows: async () => [{ uuid: 'node', name: 'Node', hidden: false }],
      getSettingsByKeys: read('settings', { record_persist_interval_sec: '120' }),
      listPingTasks: read('tasks', [{ id: 1, name: 'Ping', clients: ['node'], all_clients: false }]),
      getRecordsByTimeRangeAggregated: read('host', []),
      getPingRecordsForTasksRangeBucketed: read('ping', {}),
      getPingStatsForTasksRange: read('stats', {}),
      getTrafficTotals: read('totals', {}),
    },
  });
  const env = { LIVE_DATA: { idFromName: () => 'global', get: () => ({ fetch: async request => {
    if (new URL(request.url).pathname === '/admin-clients-snapshot') return Response.json({ clients: [], removed: [] });
    calls.push('live');
    if (failure === 'live') throw new Error('PRIVATE_BACKEND_DETAIL');
    if (failure === 'malformed') return Response.json({ online: 'invalid', count: 0 });
    if (failure === 'status') return Response.json(emptyLive, { status: 503 });
    return Response.json(emptyLive);
  } }) } };
  if (native) env.RATE_LIMIT_180 = { limit: native };
  const app = new Hono();
  app.route('/api', loader.load('worker/src/routes/public.ts').publicRoutes);
  app.route('/api', loader.load('worker/src/routes/websocket.ts').wsRoutes);
  const monitor = loader.load('worker/src/routes/monitor-compat.ts');
  app.route('/api', monitor.monitorCompatRoutes);
  const id = loader.load('worker/src/monitor/contract.ts').monitorNumericId('node');
  return {
    calls, cache, jobs, env, loader, monitor, id,
    recover: () => { failure = ''; },
    request: (path, ip = '1.1.1.1') => app.fetch(new Request(`https://example.test${path}`, {
      headers: { 'CF-Connecting-IP': ip, ...(admin ? { Cookie: 'cf_monitor_session=test' } : {}) },
    }), env, { waitUntil: promise => jobs.push(promise), passThroughOnException() {} }),
  };
}

test('all realtime GET aliases share the same local quota and reject before reading DO', async () => {
  const f = fixture();
  // /ws/live and /live/clients cannot bypass the /live budget by rotating aliases.
  for (let i = 0; i < 180; i++) assert.equal((await f.request(paths[i % paths.length])).status, 200);
  const calls = f.calls.filter(call => call === 'live').length;
  for (const path of paths) {
    const response = await f.request(path);
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
  }
  assert.equal(f.calls.filter(call => call === 'live').length, calls);
  assert.equal((await f.request('/api/ws/live', '8.8.8.8')).status, 200, 'different IP has a separate quota');
});

test('native realtime denial short-circuits every GET alias, including admin requests', async () => {
  for (const admin of [false, true]) {
    const keys = [];
    const f = fixture({ admin, native: async ({ key }) => { keys.push(key); return { success: false }; } });
    for (const path of paths) assert.equal((await f.request(`${path}?include_hidden=1`)).status, 429);
    assert.deepEqual(keys, ['live:1.1.1.1', 'live:1.1.1.1', 'live:1.1.1.1']);
    assert.equal(f.calls.length, 0);
  }
});

test('failed native realtime binding falls back to the shared local quota', async () => {
  const f = fixture({ native: async () => { throw new Error('limiter unavailable'); } });
  const responses = await Promise.all(Array.from({ length: 181 }, () => f.request('/api/ws/live')));
  assert.equal(responses.filter(response => response.status === 200).length, 180);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(f.calls.filter(call => call === 'live').length, 180);
});

for (const fail of ['live', 'malformed', 'status']) {
  for (const path of [...paths, '/api/public/bootstrap?fresh=1', '/api/nodes']) {
    test(`${path}: ${fail} returns uncached 503 and recovers without fabricated offline state`, async () => {
      const f = fixture({ fail });
      const response = await f.request(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Retry-After'), '5');
      assert.deepEqual(await response.json(), { error: '数据暂时不可用，请稍后重试' });
      await Promise.all(f.jobs);
      assert.equal(f.cache.size, 0, 'failure must never enter shared cache');
      f.recover();
      const recovered = await f.request(path);
      assert.equal(recovered.status, 200);
      const body = await recovered.json();
      if (path !== '/api/nodes') assert.deepEqual(body.live || body, emptyLive, 'legitimate empty snapshots remain successful');
    });
  }
}

for (const fail of ['settings', 'tasks', 'host', 'ping', 'stats']) {
  test(`Monitor metrics ${fail} failure is a non-cacheable 503; recovery re-reads data`, async () => {
    const f = fixture({ fail });
    const path = `/api/nodes/${f.id}/metrics?hours=4`;
    const response = await f.request(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(!(await response.text()).includes('PRIVATE_BACKEND_DETAIL'));
    await Promise.all(f.jobs);
    assert.equal(f.cache.size, 0);
    f.recover();
    const recovered = await f.request(path);
    assert.equal(recovered.status, 200);
    assert.ok(f.calls.filter(call => call === fail).length >= 2, 'failed reads must not populate successful caches');
  });
}

test('Monitor traffic totals failures cannot publish and cache zero traffic', async () => {
  const f = fixture({ fail: 'totals' });
  const response = await f.request('/api/nodes');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.cache.size, 0);
  f.recover();
  assert.equal((await f.request('/api/nodes')).status, 200);
});

test('Monitor dynamic quota applies even when the native ceiling binding allows concurrent requests', async () => {
  for (const binding of ['allowed', 'unavailable', 'missing']) {
    const f = fixture();
    if (binding !== 'missing') f.env.RATE_LIMIT_3000 = { limit: async () => {
      if (binding === 'unavailable') throw new Error('limiter unavailable');
      return { success: true };
    } };
    const { guardMonitorMetrics } = f.loader.load('worker/src/routes/public.ts');
    const contexts = Array.from({ length: 121 }, () => ({
      env: f.env, req: { raw: new Request('https://example.test'), header: () => '1.1.1.1' },
      header() {}, json: (value, status) => Response.json(value, { status }),
    }));
    const results = await Promise.all(contexts.map(c => guardMonitorMetrics(c, 'monitor-metrics', 120)));
    assert.equal(results.filter(Boolean).length, 1, binding);
    assert.equal(results.at(-1).status, 429);
  }
});

test('Monitor simultaneous identical queries perform one history read', async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.request(`/api/nodes/${f.id}/metrics?hours=4`)));
  assert.ok(responses.every(response => response.status === 200));
  for (const name of ['host', 'ping', 'stats']) assert.equal(f.calls.filter(call => call === name).length, 1, name);
});

test('Monitor distinct queries reject overload without queueing and admit new work after completion', async () => {
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let count = 0;
  const f = fixture({ beforeRead: async name => {
    if (name !== 'host') return;
    if (++count === 16) entered.resolve();
    await release.promise;
  } });
  const requests = Array.from({ length: 16 }, (_, i) => f.request(`/api/nodes/${f.id}/metrics?hours=${i + 1}`));
  await entered.promise;
  const rejected = await f.request(`/api/nodes/${f.id}/metrics?hours=17`);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('Cache-Control'), 'no-store');
  assert.equal(rejected.headers.get('Retry-After'), '1');
  assert.equal(count, 16, 'overflow must not start a database query');
  release.resolve();
  assert.ok((await Promise.all(requests)).every(response => response.status === 200));
  assert.equal((await f.request(`/api/nodes/${f.id}/metrics?hours=17`)).status, 200);
});
