import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('Ping pagination forwards both time bounds and Host windows use the bucketed reader', async () => {
  const calls = [];
  const paged = name => async (_db, ...args) => {
    calls.push([name, ...args]);
    return { data: [], has_more: false };
  };
  let failing = false;
  const loader = createWorkerLoader({ db: {
    getSettingsByKeys: async () => ({}),
    getPingRecordsCursor: paged('cursor'), getPingRecordsPaged: paged('page'),
    getRecordsByTimeRangeBucketed: async (_db, ...args) => {
      calls.push(['host', ...args]);
      if (failing) throw new Error('database unavailable');
      return [];
    },
  }, overrides: {
    'worker/src/auth/jwt.ts': { verifyAdminToken: async () => ({ userId: 'admin', sessionVersion: 1 }) },
    'worker/src/auth/admin-session.ts': { validateAdminSession: async () => ({ uuid: 'admin' }) },
  } });
  const publicRoutes = new Hono();
  publicRoutes.route('/', loader.load('worker/src/routes/public.ts').publicRoutes);
  const start = '2026-11-01T00:00:00.000Z';
  const end = '2026-11-27T00:00:00.000Z';
  const query = new URLSearchParams({ uuid: 'node', task_id: '1', start, end, include_hidden: '1' });
  for (const pagination of [`cursor=${end}`, 'page=1']) {
    const response = await publicRoutes.request(`https://review.invalid/records/ping?${query}&${pagination}`, {
      headers: { Cookie: 'cf_monitor_session=fixture' },
    }, {});
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.slice(0, 2), [
    ['cursor', 'node', 1, end, 120, start, end], ['page', 'node', 1, 1, 120, start, end],
  ]);
  const response = await publicRoutes.request(`https://review.invalid/records/load?${query}&limit=1000`, {
    headers: { Cookie: 'cf_monitor_session=fixture' },
  }, {});
  assert.equal(response.status, 200, 'Host window supports the same 30-day envelope');
  const host = calls.at(-1);
  assert.equal(host[0], 'host');
  assert.ok(Math.floor((Date.parse(end) - Date.parse(start)) / 1000 / host[4]) + 1 <= host[5]);
  failing = true;
  const failed = await publicRoutes.request(`https://review.invalid/records/load?${query}&limit=999`, {
    headers: { Cookie: 'cf_monitor_session=fixture' },
  }, {});
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  failing = false;
  const recovered = await publicRoutes.request(`https://review.invalid/records/load?${query}&limit=999`, {
    headers: { Cookie: 'cf_monitor_session=fixture' },
  }, {});
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), []);
});
