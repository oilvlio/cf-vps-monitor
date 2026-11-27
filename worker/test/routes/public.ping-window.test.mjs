import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const now = Date.parse('2026-11-27T12:17:23.456Z');
class FixedDate extends Date { static now() { return now; } }
const task = { id: 1, name: 'Ping', clients: ['node'], all_clients: false, interval_sec: 5, type: 'icmp', target: 'example.test' };
const rows = { 1: [{ time: '2026-11-27T12:00:00Z', value: 12 }] };
const stats = { 1: { samples: 12345, success_count: 12000, loss_count: 345 } };

function fixture({ retention = 168, hidden = false, admin = false, tasks = [task], fail = '' } = {}) {
  const calls = [];
  const read = name => async (_database, ...args) => {
    calls.push([name, ...args]);
    if (fail === name) throw new Error('History unavailable');
    return name.startsWith('stats') ? stats : rows;
  };
  const loader = createWorkerLoader({
    globals: { Date: FixedDate },
    overrides: { 'worker/src/auth/jwt.ts': {
      verifyAdminToken: async () => admin ? { userId: 'admin', sessionVersion: 1 } : null,
    }, 'worker/src/auth/admin-session.ts': {
      validateAdminSession: async () => admin ? { uuid: 'admin' } : null,
      invalidateAdminSessionCache() {},
    } },
    db: {
      listPublicClientRows: async () => [{ uuid: 'node', name: 'Node', hidden }],
      getSettingsByKeys: async (_db, keys) => Object.fromEntries(keys.map(key => [key,
        key === 'ping_record_preserve_time' ? String(retention) : key === 'ping_record_persist_interval_sec' ? '60' : '120',
      ])),
      listPingTasks: async () => tasks,
      getPingRecordsForTasksRangeBucketed: read('raw'),
      getPingRollupRange: read('rollup'),
      getPingStatsForTasksRange: read('stats-raw'),
      getPingStatsFromRollupRange: read('stats-rollup'),
    },
  });
  const publicRoutes = new Hono();
  publicRoutes.route('/', loader.load('worker/src/routes/public.ts').publicRoutes);
  return {
    loader, calls,
    request: (query = '') => publicRoutes.fetch(new Request(`https://example.test/records/ping/window?uuid=node&${query}`, {
      headers: admin ? { Cookie: 'cf_monitor_session=synthetic' } : {},
    }), { LIVE_DATA: { idFromName: () => 'global', get: () => ({ fetch: async () => Response.json({ clients: [], removed: [] }) }) } }),
  };
}

for (const [hours, points, retention, source] of [
  [4, 1440, 168, 'raw'], [12, 1440, 168, 'raw'], [72, 1440, 168, 'raw'],
  [72, 1440, 48, 'rollup'], [168, 400, 168, 'raw'],
  [720, 1440, 168, 'rollup'], [720, 1440, 720, 'raw'],
  [720, 60, 168, 'rollup'], [4, 1, 168, 'raw'], [4, 99999, 168, 'raw'],
]) {
  test(`Ping window matches Monitor grid and full-window statistics: ${hours}h/${points} points/${retention}h retention`, async () => {
    const { loader, calls, request } = fixture({ retention });
    const response = await request(`hours=${hours}&points=${points}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const { monitorStep } = loader.load('worker/src/monitor/contract.ts');
    const { resolveHistoryWindow } = loader.load('worker/src/utils/history-bucket.ts');
    const expected = resolveHistoryWindow(hours * 3600000, monitorStep(hours, points), retention, now);
    assert.equal(payload.step, expected.plan.stepSec);
    assert.equal(payload.start, expected.start);
    assert.equal(payload.end, expected.end);
    assert.equal(calls[0][0], source);
    assert.equal(calls[1][0], `stats-${source}`);
    assert.deepEqual(calls[0].slice(1), ['node', [1], payload.start, payload.end, payload.step, 2000]);
    assert.deepEqual(calls[1].slice(1), ['node', [1], payload.start, payload.end]);
    assert.deepEqual(payload.records, rows);
    assert.deepEqual(payload.stats, stats);
    assert.ok(Math.ceil((now - Date.parse(payload.start)) / 1000 / payload.step) <= 1441);
    assert.equal(Date.parse(payload.start) / 1000 % payload.step, 0);

    // Exercise Monitor's production assembly, not a second copy of its formula.
    calls.length = 0;
    const { loadMonitorMetrics } = loader.load('worker/src/monitor/services/metrics.ts');
    const step = monitorStep(hours, points);
    const start = new Date(Math.floor((Math.floor(now / 1000) - hours * 3600) / step) * step * 1000).toISOString();
    const monitor = await loadMonitorMetrics({}, 'node', { start, end: payload.end, step, rangeMs: hours * 3600000, series: 'ping' });
    assert.equal(monitor.payload.step, payload.step);
    assert.deepEqual(structuredClone(calls.find(call => call[0] === source).slice(1)), ['node', [1], payload.start, payload.end, payload.step, 2000]);
  });
}

test('Ping window filters unrelated tasks, applies task budget and returns configured sample interval', async () => {
  const tasks = [
    { ...task, id: 9, clients: ['other'] },
    { ...task, id: 2, all_clients: true, clients: [] },
    task,
  ];
  const { request, calls } = fixture({ tasks });
  const payload = await (await request('max_tasks=1')).json();
  assert.deepEqual(payload.tasks.map(task => task.id), [2]);
  assert.equal(payload.tasks[0].interval_sec, 60);
  assert.deepEqual(calls[0][2], [2]);
});

test('Ping window hidden nodes require a valid administrator session', async () => {
  for (const admin of [false, true]) {
    const { request, calls } = fixture({ hidden: true, admin });
    const response = await request('include_hidden=1');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.tasks.length, admin ? 1 : 0);
    assert.equal(calls.length, admin ? 2 : 0);
    assert.match(response.headers.get('Cache-Control'), admin ? /private/ : /public/);
  }
});

test('Ping window with no tasks does not query history', async () => {
  const { request, calls } = fixture({ tasks: [] });
  const payload = await (await request()).json();
  assert.deepEqual(payload.tasks, []);
  assert.deepEqual(payload.records, {});
  assert.deepEqual(payload.stats, {});
  assert.equal(calls.length, 0);
});

test('Ping window errors do not masquerade as successful empty or estimated history', async () => {
  const { request } = fixture({ fail: 'stats-raw' });
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(!JSON.stringify(await response.json()).includes('History unavailable'));
});
