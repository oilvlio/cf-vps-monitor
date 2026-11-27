import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedSettings } from '../src/utils/settingsDiff.ts';
import { normalizeLiveDataResponse } from '../src/utils/liveDataResponse.ts';
import { normalizePublicClients } from '../src/utils/publicClients.ts';
import { normalizePublicMonitorRecord, normalizePublicMonitorRecords } from '../src/utils/publicHistory.ts';
import { buildMonitorChartData, getMonitorChartRenderData } from '../src/utils/monitorChartData.ts';
import { buildApiRequest } from '../src/utils/api.ts';
import { runWithMfaStepUpRetry } from '../src/utils/mfa.ts';
import { shouldClearAuthForStatus } from '../src/contexts/auth-state.ts';
import { validateAdminPasswordLength } from '../src/utils/passwordPolicy.ts';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BroadcastChannel as NativeBroadcastChannel } from 'node:worker_threads';
import { productionDeclaration, productionJsx, productionModule, productionEffect, productionSelected } from './helpers/production-module.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const notifications = 'src/pages/admin/Notifications.tsx';
const notificationSource = readFileSync(new URL('../src/pages/admin/Notifications.tsx', import.meta.url), 'utf8');

test('AUD-07 partial maintenance reports remaining work and counts ping records', async () => {
  for (const hasMore of [true, false]) {
    let requests = 0;
    const messages = [];
    const cleanup = productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'handleMaintenanceCleanup', {
      setCleaning() {},
      apiFetch: async () => { requests += 1; if (requests > 1) throw new Error('Unexpected client cleanup loop'); return { success: true, has_more: hasMore, deleted: { records: 1, ping_records: 2 } }; },
      formatInteger: productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'formatInteger'),
      toast: { info: message => messages.push(['info', message]), success: message => messages.push(['success', message]), error: message => messages.push(['error', message]) },
    });
    await cleanup();
    assert.equal(messages[0][0], hasMore ? 'info' : 'success', 'remaining cleanup work must not be presented as complete');
    assert.match(messages[0][1], /3/);
    if (hasMore) assert.match(messages[0][1], /仍有|继续清理/);
    assert.equal(requests, 1);
  }
});

function adminActionRunner(errors = []) {
  let run;
  return (...args) => {
    run ??= productionModule('src/hooks/useAdminAction.ts', {
      react: { useCallback: value => value, useRef: value => ({ current: value }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] },
      sonner: { toast: { error: message => errors.push(message) } },
    }).useAdminAction().run;
    return run(...args);
  };
}
const passthroughAction = async (_key, action) => action();

test('AUD-49 notification write failures are caught and expose the real error', async () => {
  const methods = [['saveSingleEdit', []], ['saveBatchEdit', []], ['toggleOffline', ['node-a', true]], ['toggleExpiry', ['node-a', true]], ['saveExpirySingleEdit', []], ['saveExpiryBatchEdit', []], ['saveLoadNotification', []], ['deleteLoadNotification', [1]], ['sendTestMessage', []]];
  for (const [name, args] of methods) {
    const errors = [];
    let closed = false;
    const action = productionDeclaration(notifications, name, {
      apiFetch: async () => { throw new Error('Synthetic service rejection'); },
      runAction: adminActionRunner(errors), toast: { error: message => errors.push(message), success() {} },
      editingOffline: 'node-a', editForm: { enable: true, grace_period: 1200 }, selectedClients: ['node-a'], batchForm: { enable: true, grace_period: 1200 },
      editingExpiry: 'node-a', expiryEditForm: { enable: true, advance_days: 7 }, expiryBatchForm: { enable: true, advance_days: 7 },
      notificationMap: new Map(), expiryNotificationMap: new Map(), DEFAULT_GRACE_PERIOD_SEC: 360, DEFAULT_EXPIRY_ADVANCE_DAYS: 7,
      editingLoad: null, loadForm: { name: 'Synthetic', metric: 'cpu', all_clients: true, clients: [] }, settings: { notification_method: 'telegram' },
      setEditDialogOpen: () => { closed = true; }, setBatchDialogOpen: () => { closed = true; }, setExpiryEditDialogOpen: () => { closed = true; }, setExpiryBatchDialogOpen: () => { closed = true; }, setLoadDialogOpen: () => { closed = true; },
      loadOfflineTab() {}, loadExpiryTab() {}, loadLoadTab() {}, setSelectedClients() {},
    });
    let rejected;
    try { await action(...args); } catch (error) { rejected = error; }
    assert.equal(rejected, undefined, `${name} must handle event promise failures`);
    assert.deepEqual(errors, ['Synthetic service rejection'], `${name} must show the real failure once`);
    assert.equal(closed, false, 'failed edits stay open for retry');
  }
});

test('AUD-49 a pending notification save cannot submit twice', async () => {
  const pending = Promise.withResolvers();
  let requests = 0;
  const save = productionDeclaration(notifications, 'saveSingleEdit', {
    editingOffline: 'node-a', editForm: { enable: true, grace_period: 1200 }, runAction: adminActionRunner(),
    apiFetch: () => { requests += 1; return pending.promise; }, toast: { success() {}, error() {} }, setEditDialogOpen() {}, loadOfflineTab() {},
  });
  const first = save();
  const second = save();
  pending.resolve({ success: true });
  await Promise.all([first, second]);
  assert.equal(requests, 1, 'pending guard must act before a React render disables the button');
});

test('AUD-49 Ping loading and deletion failures remain visible and handled', async () => {
  for (const name of ['loadData', 'handleDelete']) {
    const errors = [];
    let loadError = null;
    const action = productionDeclaration('src/pages/admin/PingTasks.tsx', name, {
      apiFetch: async () => { throw new Error('Synthetic Ping failure'); }, runAction: adminActionRunner(errors), deleteTask: { id: 1 },
      toast: { error: message => errors.push(message), success() {} }, setLoading() {}, setTasks() {}, setDeleteTask() {}, setLoadError: value => { loadError = value; },
    });
    let rejected;
    try { await action(); } catch (error) { rejected = error; }
    assert.equal(rejected, undefined, `${name} must catch asynchronous failures`);
    assert.ok(errors.includes('Synthetic Ping failure') || loadError === 'Synthetic Ping failure');
  }
});

test('AUD-05 initial administrator form requires and sends ownership key', async () => {
  for (const adminPresent of [false, true]) {
    for (const key of ['', 'synthetic-owner-proof']) {
      const bodies = [];
      const errors = [];
      const submit = productionDeclaration('src/pages/Login.tsx', 'handleRecoverySubmit', {
        recoveryStatus: { admin_present: adminPresent }, recoveryKey: key, recoveryUsername: 'synthetic-owner', recoveryPassword: 'synthetic-password',
        validateAdminPasswordLength,
        fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ mode: 'created' })); },
        toast: { error: message => errors.push(message), success() {} }, setRecoveryLoading() {}, setUsername() {}, setPassword() {}, setRecoveryPassword() {}, setRecoveryKey() {}, setRecoveryStatus() {}, setRecoveryMode() {},
      });
      await submit({ preventDefault() {} });
      assert.equal(bodies.length, key ? 1 : 0, 'ownership is required for initial creation as well as recovery');
      if (key) assert.equal(bodies[0].supabase_secret_key, 'synthetic-owner-proof');
      else assert.equal(errors.length, 1);
    }
  }
});

function syntheticStorage(seed = []) {
  const values = new Map(seed);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

const collectCursorHistory = (...args) => productionModule('src/utils/publicHistory.ts').collectCursorHistory(...args);

test('AUD-43 Host history covers the whole window with one bounded request and no raw cursor traversal', async () => {
  let calls = 0;
  let records = [];
  const bindings = {
    uuid: 'node-a', client: { uuid: 'node-a' }, authLoading: false, isAuthenticated: false, timeRange: '3d', AbortController,
    viewTab: 'load',
    readFreshCache: (...args) => productionModule('src/utils/historyCache.ts').readFreshCache(...args),
    writeCache: (...args) => productionModule('src/utils/historyCache.ts').writeCache(...args),
    recordsRequestRef: { current: 0 },
    timeRangeMs: productionDeclaration('src/pages/Instance.tsx', 'timeRangeMs'),
    timeRangePointLimit: productionDeclaration('src/pages/Instance.tsx', 'timeRangePointLimit'),
    historyQuery: productionDeclaration('src/pages/Instance.tsx', 'historyQuery'),
    collectCursorHistory, normalizePublicMonitorRecords,
    publicFetch: async url => {
      calls += 1;
      const params = new URL(url, 'https://synthetic.invalid').searchParams;
      assert.equal(params.has('cursor'), false);
      assert.equal(params.has('page'), false);
      assert.ok(Number(params.get('limit')) <= 1200);
      const end = Date.parse(params.get('end'));
      return [{ time: new Date(end - 70 * 3600000).toISOString(), cpu: 11 },
        { time: new Date(end - 3600000).toISOString(), cpu: 99 }];
    },
    setRecords: value => { records = value; },
    setRecordsLoading() {}, setRecordsRangeEnd() {}, setRecordsError() {},
  };
  await productionDeclaration('src/pages/Instance.tsx', 'loadRecords', bindings)('3d');
  assert.deepEqual([...records].map(record => record.cpu), [11, 99], 'history must cover both ends of the available range in chronological order');
  assert.equal(calls, 1);
});

test('AUD-43 long-range Ping history and statistics use one server-planned window', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  const batch = Array.from({ length: 360 }, (_, index) => ({ time: new Date(end - (index + 1) * 120000).toISOString(), value: 10, task_id: 1, sample_count: 2, success_count: 2, loss_count: 0, avg_latency: 10, max_latency: 12 }));
  let batchCalls = 0;
  let batchUrl = null;
  let continuations = 0;
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      if (parsed.pathname === '/api/task/ping') return new Response(JSON.stringify([{ id: 1, name: 'Synthetic ping', clients: ['node-a'], interval: 120, interval_sec: 120 }]));
      if (parsed.pathname === '/api/records/ping/window') { batchCalls += 1; batchUrl = parsed; return Response.json({ tasks: [{ id: 1 }], records: { 1: batch }, stats: { 1: { samples: 1000, success_count: 900, loss_count: 100, avg: 20 } } }); }
      if (parsed.pathname === '/api/records/ping') { continuations += 1; return new Response(JSON.stringify({ data: [], has_more: false })); }
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });
  const { series, stats } = await ping.fetchPingTaskWindow('node-a', { hours: 72 });
  assert.equal(batchCalls, 1, 'three-day Ping chart must be served by exactly one batch request');
  assert.equal(batchUrl.searchParams.get('points'), '1440');
  assert.equal(batchUrl.searchParams.get('hours'), '72');
  assert.ok(!batchUrl.searchParams.has('start') && !batchUrl.searchParams.has('end') && !batchUrl.searchParams.has('cursor'));
  assert.equal(stats['1'].samples, 1000, 'whole-window statistics must not be estimated from plotted rows');
  assert.equal(continuations, 0, 'the bucketed batch already covers the window, so no per-task backfill may run');
  assert.equal(series[0].records.length, 360, 'single batch rows are returned as-is');
  assert.equal(Math.min(...series[0].records.map(record => Date.parse(record.time))), end - 360 * 120000);
});

test('AUD-43 short-range Ping history uses the same hours/points window strategy', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  const batch = Array.from({ length: 60 }, (_, index) => ({ time: new Date(end - (index + 1) * 60000).toISOString(), value: 10, task_id: 1 }));
  let batchCalls = 0;
  let batchUrl = null;
  let singleCalls = 0;
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      if (parsed.pathname === '/api/task/ping') return new Response(JSON.stringify([{ id: 1, name: 'Synthetic ping', clients: ['node-a'], interval: 60, interval_sec: 60 }]));
      if (parsed.pathname === '/api/records/ping/window') { batchCalls += 1; batchUrl = parsed; return Response.json({ tasks: [{ id: 1 }], records: { 1: batch }, stats: {} }); }
      if (parsed.pathname === '/api/records/ping') { singleCalls += 1; return new Response(JSON.stringify({ data: [], has_more: false })); }
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });
  const { series } = await ping.fetchPingTaskWindow('node-a', { hours: 1 });
  assert.equal(batchCalls, 1, 'one-hour Ping chart must be served by exactly one batch request');
  assert.equal(batchUrl.searchParams.get('hours'), '1');
  assert.equal(batchUrl.searchParams.has('cursor'), false);
  assert.equal(singleCalls, 0, 'one raw page covers a 60s-interval hour, so no per-task paging may run');
  assert.equal(series[0].records.length, 60);
});

test('AUD-43 tiny-interval Ping trusts server buckets without per-task paging', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  const rangeStart = end - 4 * 3600000;
  const batch = Array.from({ length: 1500 }, (_, index) => ({ time: new Date(end - (index + 1) * 5000).toISOString(), value: 10, task_id: 1 }));
  let singleCalls = 0;
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      if (parsed.pathname === '/api/task/ping') return new Response(JSON.stringify([{ id: 1, name: 'Synthetic ping', clients: ['node-a'], interval: 5, interval_sec: 5 }]));
      if (parsed.pathname === '/api/records/ping/window') return Response.json({ tasks: [{ id: 1, interval_sec: 5 }], records: { 1: batch }, stats: {} });
      if (parsed.pathname === '/api/records/ping') {
        singleCalls += 1;
        const cursorMs = Date.parse(parsed.searchParams.get('cursor'));
        const rows = [];
        for (let at = cursorMs - 5000; at > cursorMs - 2 * 3600000 && at >= rangeStart; at -= 5000) {
          rows.push({ time: new Date(at).toISOString(), value: 10, task_id: 1 });
        }
        const oldest = rows.length ? Date.parse(rows[rows.length - 1].time) : cursorMs;
        return new Response(JSON.stringify({ data: rows, has_more: oldest > rangeStart, next_cursor: new Date(oldest).toISOString() }));
      }
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });
  const { series } = await ping.fetchPingTaskWindow('node-a', { hours: 4 });
  assert.equal(singleCalls, 0);
  assert.equal(series[0].records.length, batch.length);
});

test('AUD-43 Ping window preserves hidden-node intent in its single request', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  // 60s 间隔、4h 窗口：最老一条必然晚于 rangeStart（查询是 time >= start），但条数远小于 limit，没有被截断。
  const batch = Array.from({ length: 239 }, (_, index) => ({ time: new Date(end - (index + 1) * 60000).toISOString(), value: 10, task_id: 1 }));
  const calls = [];
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      calls.push(parsed);
      if (parsed.pathname === '/api/task/ping') return new Response(JSON.stringify([{ id: 1, name: 'Synthetic ping', clients: ['node-a'], interval: 60, interval_sec: 60 }]));
      if (parsed.pathname === '/api/records/ping/window') return Response.json({ tasks: [{ id: 1 }], records: { 1: batch }, stats: {} });
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });
  const { series } = await ping.fetchPingTaskWindow('node-a', { hours: 4, points: 360, includeHidden: true });
  assert.equal(series[0].records.length, 239);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('include_hidden'), '1');
  assert.equal(calls[0].searchParams.get('points'), '360');
});

test('AUD-43 concurrent Ping windows share one request and cancellation is isolated', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  let taskListCalls = 0;
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      if (parsed.pathname === '/api/records/ping/window') {
        taskListCalls += 1;
        return Response.json({ tasks: [{ id: 1 }], records: { 1: [] }, stats: {} });
      }
      if (parsed.pathname === '/api/records/ping/batch') return new Response(JSON.stringify({ 1: [] }));
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });
  const first = new AbortController();
  const options = { hours: 4, points: 360 };
  const aborted = ping.fetchPingTaskWindow('node-a', { ...options, signal: first.signal });
  const surviving = ping.fetchPingTaskWindow('node-a', options);
  first.abort();
  await assert.rejects(() => aborted, { name: 'AbortError' });
  const { series } = await surviving;
  assert.equal(taskListCalls, 1, 'StrictMode double effect must share the whole window request');
  assert.equal(series.length, 1);
});

test('AUD-43 cursor traversal rejects repeated cursors and is bounded and abortable', async () => {
  const collect = productionModule('src/utils/publicHistory.ts').collectCursorHistory;
  const options = { cursor: '2026-09-06T00:00:00Z', start: '2026-09-03T00:00:00Z', normalize: normalizePublicMonitorRecords };
  await assert.rejects(() => collect(async () => ({ data: [], has_more: true, next_cursor: options.cursor }), options), /游标无效/);
  let calls = 0;
  await assert.rejects(() => collect(async cursor => {
    calls += 1;
    return { data: [], has_more: true, next_cursor: new Date(Date.parse(cursor) - 3600000).toISOString() };
  }, { ...options, maxPages: 2 }), /历史记录过多/);
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => collect(async () => { throw new Error('fetch must not run'); }, { ...options, signal: controller.signal }), { name: 'AbortError' });
});

test('AUD-42 older bootstrap and settings responses cannot overwrite newer cache state', async () => {
  for (const kind of ['bootstrap', 'settings']) {
    const requests = [];
    const module = productionModule(`src/utils/public${kind === 'bootstrap' ? 'Bootstrap' : 'Settings'}.ts`, {}, {
      localStorage: syntheticStorage(),
      fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const request = kind === 'bootstrap' ? module.fetchPublicBootstrap : module.fetchPublicSettings;
    const older = request();
    const newer = request(kind === 'bootstrap' ? { cacheBust: true } : { force: true });
    assert.equal(requests.length, 2);
    const payload = name => kind === 'bootstrap' ? { clients: [{ uuid: 'node-a', name }] } : { site_title: name };
    requests[1](new Response(JSON.stringify(payload('new B'))));
    await newer;
    requests[0](new Response(JSON.stringify(payload('old A'))));
    await older;
    const current = kind === 'bootstrap' ? module.getCachedPublicBootstrap().clients[0].name : (await request()).site_title;
    assert.equal(current, 'new B', `${kind} must keep the latest request's response`);
  }
});

test('AUD-42 invalidation replaces pending fresh bootstrap requests in both visibility scopes', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const requests = [];
      const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
        localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
      });
      const older = bootstrap.fetchPublicBootstrap({ cacheBust: true, includeHidden });
      bootstrap.clearCachedPublicBootstrap();
      const newer = bootstrap.fetchPublicBootstrap({ cacheBust: true, includeHidden });
      assert.equal(requests.length, 2, 'an invalidated request cannot satisfy a later metadata refresh');
      requests[1](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'new B', hidden: includeHidden }] })));
      const current = await newer;
      requests[0](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'old A', hidden: includeHidden }] })));
      await older;
      assert.equal(current.clients[0].name, 'new B');
    });
  }
});

test('AUD-42 Index keeps newer client state when an earlier bootstrap succeeds or fails late', async (t) => {
  for (const oldStatus of [200, 500]) {
    await t.test(`old HTTP ${oldStatus}`, async () => {
    const requests = [];
    const promises = [];
    const window = new EventTarget();
    Object.assign(window, { location: { origin: 'http://synthetic.invalid' }, setInterval: () => 1, clearInterval() {} });
    const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
      window, localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const publicClients = productionModule('src/utils/publicClients.ts');
    let current = [];
    let refresh;
    let fallbackCalls = 0;
    const effect = productionEffect('src/pages/Index.tsx', 'const refreshPublicClients', {
      authLoading: false, monitorMode: 'servers', isAuthenticated: false, window, document: new EventTarget(),
      fetchPublicBootstrap: (...args) => { const pending = bootstrap.fetchPublicBootstrap(...args); promises.push(pending); return pending; },
      fetchWithBootstrapRetry: () => { fallbackCalls += 1; return Promise.reject(new Error('Unexpected obsolete fallback')); },
      normalizePublicClients: publicClients.normalizePublicClients,
      applyPublicClientUpdate: productionDeclaration('src/pages/Index.tsx', 'applyPublicClientUpdate', { mergePublicClientPatch: publicClients.mergePublicClientPatch }),
      setClients: update => { current = typeof update === 'function' ? update(current) : update; },
      setClientsLoading() {}, setClientsError() {}, notifyPublicDataReady() {},
      subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
    });
    const cleanup = effect();
    try {
      bootstrap.clearCachedPublicBootstrap();
      refresh({ force: true });
      assert.equal(requests.length, 2);
      requests[1](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'new B' }] })));
      await promises[1];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(current[0].name, 'new B');
      requests[0](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'old A' }] }), { status: oldStatus }));
      await promises[0].catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(bootstrap.getCachedPublicBootstrap().clients[0].name, 'new B', 'cache control');
      assert.equal(current[0].name, 'new B', 'rendered client state must not regress to old A');
      assert.equal(fallbackCalls, 0, 'an obsolete response must not launch another request');
    } finally { cleanup(); }
    });
  }
});

function indexBootstrapFixture(includeHidden = false) {
  const requests = [];
  const state = { clients: [], loading: false, error: null, ready: 0 };
  const window = new EventTarget();
  const document = new EventTarget();
  Object.assign(window, { location: { origin: 'http://synthetic.invalid' }, setInterval: () => 1, clearInterval() {} });
  const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
    window, localStorage: syntheticStorage(),
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
  }, 'fetchWithBootstrapRetry');
  const publicClients = productionModule('src/utils/publicClients.ts');
  const applyUpdate = productionDeclaration('src/utils/publicDataEvents.ts', 'applyPublicDataUpdate', {
    patchCachedPublicBootstrapClients: bootstrap.patchCachedPublicBootstrapClients,
    clearCachedPublicBootstrap: bootstrap.clearCachedPublicBootstrap,
    clearCachedPublicSettings() {},
  });
  let refresh;
  const effect = productionEffect('src/pages/Index.tsx', 'const refreshPublicClients', {
    authLoading: false, monitorMode: 'servers', isAuthenticated: includeHidden, window, document,
    fetchPublicBootstrap: bootstrap.fetchPublicBootstrap, fetchWithBootstrapRetry: bootstrap.auditSelected,
    normalizePublicClients: publicClients.normalizePublicClients,
    applyPublicClientUpdate: productionDeclaration('src/pages/Index.tsx', 'applyPublicClientUpdate', { mergePublicClientPatch: publicClients.mergePublicClientPatch }),
    setClients: update => { state.clients = typeof update === 'function' ? update(state.clients) : update; },
    setClientsLoading: value => { state.loading = value; },
    setClientsError: value => { state.error = value; },
    notifyPublicDataReady: () => { state.ready += 1; },
    subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
  });
  const cleanup = effect();
  return {
    state, requests, cleanup,
    visible() { document.dispatchEvent(new Event('visibilitychange')); },
    emit(detail) { applyUpdate(detail); refresh(detail); },
    async reply(index, payload, status = 200) {
      assert.ok(requests[index], `request ${index} must have reached the real fetch boundary`);
      requests[index].resolve(new Response(JSON.stringify(payload), { status }));
      await new Promise(resolve => setImmediate(resolve));
    },
    rows: () => Array.from(state.clients, client => [client.uuid, client.name]).sort(([left], [right]) => left.localeCompare(right)),
  };
}

test('AUD-42 a partial update during first load retains unaffected nodes and the latest rename', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Renamed B' }] } });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        const loadingAfterPatch = fixture.state.loading;
        const readyAfterPatch = fixture.state.ready;
        await fixture.reply(0, { clients: [
          { uuid: 'node-a', name: 'Unaffected A', hidden: includeHidden },
          { uuid: 'node-b', name: 'Old B' },
        ] });
        assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']], 'a partial patch cannot replace the full snapshot');
        assert.equal(loadingAfterPatch, true, 'a partial patch cannot complete the first full load');
        assert.equal(readyAfterPatch, 0, 'the full list was not ready when only a patch arrived');
        assert.equal(fixture.state.loading, false);
        assert.equal(fixture.state.ready, 1);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 visibility refresh preserves patches when the full request is coalesced', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        fixture.visible();
        assert.equal(fixture.requests.length, 1, 'the real bootstrap cache coalesces the visible-page refresh');
        await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'Unaffected A' }, { uuid: 'node-b', name: 'Old B' }] });
        assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']], 'coalescing must preserve partial updates even without the public cache overlay');
        assert.equal(fixture.state.ready, 1);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 partial updates preserve ownership of the latest full refresh', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ force: true });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }], remove: ['node-c'] } });
        await fixture.reply(1, { clients: [
          { uuid: 'node-a', name: 'New A', hidden: includeHidden },
          { uuid: 'node-b', name: 'Old B' },
          { uuid: 'node-c', name: 'Deleted C' },
        ] });
        assert.deepEqual(fixture.rows(), [['node-a', 'New A'], ['node-b', 'Latest B']], 'the new full snapshot must retain patches received while pending');
        await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'Obsolete A' }] });
        assert.deepEqual(fixture.rows(), [['node-a', 'New A'], ['node-b', 'Latest B']], 'an older full request remains obsolete after the partial update');
        assert.equal(fixture.state.ready, 1, 'the old request cannot announce another completion');
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 a partial update cannot discard full-snapshot fallback or hide its failure', async (t) => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'fallback failure stays visible' : 'fallback retains all nodes and patches', async () => {
      const fixture = indexBootstrapFixture(true);
      try {
        await fixture.reply(0, { clients: [{ uuid: 'node-b', name: 'Original B' }] });
        fixture.emit({ force: true });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        await fixture.reply(1, { error: 'Synthetic service unavailable' }, 500);
        assert.equal(fixture.requests.length, 3, 'a patch is not a replacement for the failed full refresh');
        if (fails) {
          await fixture.reply(2, { error: 'Synthetic service unavailable' }, 500);
          await fixture.reply(3, { error: 'Synthetic list unavailable' }, 502);
          assert.equal(fixture.state.error, 'HTTP 502', 'the partial list cannot be silently presented as a successful full read');
          assert.deepEqual(fixture.rows(), [['node-b', 'Latest B']]);
        } else {
          await fixture.reply(2, { clients: [{ uuid: 'node-a', name: 'Unaffected A' }, { uuid: 'node-b', name: 'Old B' }] });
          assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']]);
          fixture.emit({ force: true });
          await fixture.reply(3, { clients: [{ uuid: 'node-a', name: 'Server A' }, { uuid: 'node-b', name: 'Server B' }] });
          assert.deepEqual(fixture.rows(), [['node-a', 'Server A'], ['node-b', 'Server B']], 'later authoritative reads retire the completed request\'s patches');
        }
        assert.equal(fixture.state.loading, false);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 LiveDataProvider keeps newer live/settings when an earlier bootstrap succeeds or fails late', async (t) => {
  for (const oldStatus of [200, 500]) {
    await t.test(`old HTTP ${oldStatus}`, async () => {
    const requests = [];
    const promises = [];
    const window = new EventTarget();
    window.location = { origin: 'http://synthetic.invalid' };
    const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
      window, localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const settingsModule = productionModule('src/utils/publicSettings.ts');
    let current;
    let title;
    let clientMetadata;
    let refresh;
    let fallbackCalls = 0;
    const effect = productionEffect('src/contexts/LiveDataContext.tsx', 'const applyBootstrap', {
      authLoading: false, enabled: true, viewer: true, includeHidden: false, window,
      liveScopeRef: { current: productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope() },
      LIVE_POLL_SETTINGS_UPDATED_EVENT: 'synthetic-settings',
      normalizePublicSettings: settingsModule.normalizePublicSettings,
      setCachedPublicSettings: settings => { title = settings.site_title; },
      normalizeLivePollConfig: () => ({}), pollConfigRef: { current: {} }, DEFAULT_LIVE_POLL_CONFIG: {},
      normalizeLiveDataResponse, rememberInitialLiveMetadataVersion() {}, setLoading() {}, setError() {},
      setLiveData: value => { current = value; },
      setClientMetadata: update => { clientMetadata = typeof update === 'function' ? update(clientMetadata) : update; },
      mergePublicClientPatch: productionModule('src/utils/publicClients.ts').mergePublicClientPatch,
      fetchPublicBootstrap: (...args) => { const pending = bootstrap.fetchPublicBootstrap(...args); promises.push(pending); return pending; },
      fetchPublicSettings: () => { fallbackCalls += 1; return Promise.reject(new Error('Unexpected obsolete settings fallback')); },
      subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
    });
    const payload = name => ({
      clients: [{ uuid: 'node-a', name }], settings: { site_title: name },
      live: { online: ['node-a'], clients: [{ uuid: 'node-a', name, lastReportTime: 1 }], data: {}, count: 1, timestamp: 1 },
    });
    const cleanup = effect();
    try {
      bootstrap.clearCachedPublicBootstrap();
      refresh({ force: true });
      assert.equal(requests.length, 2);
      requests[1](new Response(JSON.stringify(payload('new B'))));
      await promises[1];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(current.clients[0].name, 'new B');
      requests[0](new Response(JSON.stringify(payload('old A')), { status: oldStatus }));
      await promises[0].catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(bootstrap.getCachedPublicBootstrap().clients[0].name, 'new B', 'cache control');
      assert.deepEqual([current.clients[0].name, title], ['new B', 'new B'], 'live state and settings must belong to the latest request');
      assert.equal(clientMetadata[0].name, 'new B', 'the retained metadata list also belongs to the latest request');
      assert.equal(fallbackCalls, 0, 'an obsolete response must not refresh settings again');
    } finally { cleanup(); }
    });
  }
});

test('AUD-42 late node metadata cannot replace the current node', async () => {
  const pending = new Map();
  const clientRequestRef = { current: 0 };
  let current;
  const load = uuid => productionDeclaration('src/pages/Instance.tsx', 'loadClient', {
    uuid, authLoading: false, isAuthenticated: false, clientRequestRef,
    publicFetch: () => new Promise(resolve => pending.set(uuid, resolve)),
    normalizePublicClients, setClientLoading() {}, setError() {}, setClients() {},
    setClient: value => { current = value; },
  });
  const a = load('node-a')();
  const b = load('node-b')();
  const nodes = [{ uuid: 'node-a', name: 'A' }, { uuid: 'node-b', name: 'B' }];
  pending.get('node-b')(nodes);
  await b;
  pending.get('node-a')(nodes);
  await a;
  assert.equal(current.uuid, 'node-b', 'route B must not display late node A metadata');
});

test('AUD-42 late node history cannot replace the current node history', async () => {
  const pending = new Map();
  const recordTime = new Date(Date.now() - 30 * 60_000).toISOString();
  const recordsRequestRef = { current: 0 };
  let current = [];
  const load = uuid => productionDeclaration('src/pages/Instance.tsx', 'loadRecords', {
    uuid, authLoading: false, isAuthenticated: false, recordsRequestRef,
    timeRangeMs: productionDeclaration('src/pages/Instance.tsx', 'timeRangeMs'),
    timeRangePointLimit: productionDeclaration('src/pages/Instance.tsx', 'timeRangePointLimit'),
    historyQuery: productionDeclaration('src/pages/Instance.tsx', 'historyQuery'),
    publicFetch: () => new Promise(resolve => pending.set(uuid, resolve)),
    normalizePublicMonitorRecords,
    collectCursorHistory,
    setRecordsLoading() {}, setRecordsRangeEnd() {}, setRecordsError() {},
    setRecords: value => { current = value; },
  });
  const a = load('node-a')('4h');
  const b = load('node-b')('3d');
  pending.get('node-b')([{ time: recordTime, cpu: 22 }]);
  await b;
  pending.get('node-a')([{ time: recordTime, cpu: 91 }]);
  await a;
  assert.equal(current[0].cpu, 22, 'route B history must not be replaced by late A history');
});

test('AUD-41 a fresh server snapshot supersedes older optimistic client patches', async () => {
  let responseName = 'original';
  const cache = productionModule('src/utils/publicBootstrap.ts', {}, {
    localStorage: syntheticStorage(),
    fetch: async () => new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: responseName, price: 5, billing_cycle: 30 }] })),
  });
  await cache.fetchPublicBootstrap();
  cache.patchCachedPublicBootstrapClients({ clients: { upsert: [{ uuid: 'node-a', name: 'old optimistic name' }] } });
  responseName = 'latest server truth';
  const fresh = await cache.fetchPublicBootstrap({ cacheBust: true, cache: 'reload' });
  assert.equal(fresh.clients[0].name, 'latest server truth');
  assert.equal(cache.getCachedPublicBootstrap().clients[0].name, 'latest server truth');
});

test('AUD-41 explicit free pricing and cleared text survive client cache updates', async () => {
  const cache = productionModule('src/utils/publicBootstrap.ts', {}, {
    localStorage: syntheticStorage(),
    fetch: async () => new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'A', price: 5, billing_cycle: 30, public_remark: 'Old note', group: 'Old group' }] })),
  });
  await cache.fetchPublicBootstrap();
  cache.patchCachedPublicBootstrapClients({ clients: { upsert: [{ uuid: 'node-a', price: 0, billing_cycle: 0, public_remark: '', group: '' }] } });
  const client = cache.getCachedPublicBootstrap().clients[0];
  assert.deepEqual([client.price, client.billing_cycle, client.public_remark, client.group, client.name], [0, 0, '', '', 'A']);
});

test('AUD-53 fallback broadcast never writes private client details into browser storage', () => {
  const storage = new Map();
  const writes = [];
  const window = new EventTarget();
  let localDetail;
  window.addEventListener('cf-monitor:public-data-updated', event => { localDetail = event.detail; });
  const module = productionModule('src/utils/publicDataEvents.ts', {}, {
    window, CustomEvent, BroadcastChannel: undefined,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); writes.push(value); }, removeItem: key => storage.delete(key) },
  });
  module.notifyPublicDataUpdated({ clients: { upsert: [{ uuid: 'node-a', name: 'Public node', token: 'SYNTHETIC_AGENT_SECRET', remark: 'SYNTHETIC_PRIVATE_NOTE', ipv4: '192.0.2.123', public_remark: 'Public note', sort_order: 2 }] } });
  const serialized = JSON.stringify({ writes, localDetail, stored: [...storage.values()] });
  for (const secret of ['SYNTHETIC_AGENT_SECRET', 'SYNTHETIC_PRIVATE_NOTE', '192.0.2.123']) {
    assert.ok(!serialized.includes(secret), `${secret} must not enter storage or the public update payload`);
  }
  assert.equal(localDetail.clients.upsert[0].name, 'Public node');
  assert.equal(localDetail.clients.upsert[0].public_remark, 'Public note');
  assert.equal(storage.has('cf-monitor:public-data-updated'), false, 'fallback envelope is transient');
});

test('AUD-40 each subscriber receives exactly once across pages and transports', async () => {
  for (const transport of ['broadcast', 'storage']) {
    const pages = [new EventTarget(), new EventTarget()];
    const counts = [[0, 0], [0, 0]];
    const modules = pages.map((window, pageIndex) => productionModule('src/utils/crossTabEvents.ts', {}, {
      window, CustomEvent,
      BroadcastChannel: transport === 'broadcast' ? NativeBroadcastChannel : undefined,
      localStorage: {
        setItem: (key, newValue) => pages.forEach((target, index) => {
          if (index === pageIndex) return;
          const event = new Event('storage');
          Object.assign(event, { key, newValue });
          queueMicrotask(() => target.dispatchEvent(event));
        }),
        removeItem() {},
      },
    }));
    const name = `audit-${transport}-${Date.now()}`;
    const stops = modules.flatMap((module, pageIndex) => [0, 1].map(subscriber => module.subscribeCrossTab(name, () => { counts[pageIndex][subscriber] += 1; })));
    try {
      modules[0].broadcastCrossTab(name, { value: 'synthetic' });
      const deadline = Date.now() + 5000;
      while (counts.some(page => page.some(count => count === 0)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(counts, [[1, 1], [1, 1]], `${transport}: every local and remote listener must receive one delivery`);
      stops.forEach(stop => stop());
      modules[0].broadcastCrossTab(name, { value: 'after-unsubscribe' });
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.deepEqual(counts, [[1, 1], [1, 1]], 'unsubscribed listeners must not receive updates');
    } finally {
      stops.forEach(stop => stop());
    }
  }
});

test('AUD-40 a genuine settings invalidation is delivered after an optimistic client update', () => {
  const module = productionModule('src/utils/publicDataEvents.ts', {}, { window: new EventTarget(), CustomEvent, BroadcastChannel: undefined, localStorage: syntheticStorage() });
  const counts = [0, 0];
  const stops = counts.map((_, index) => module.subscribePublicDataUpdated(() => { counts[index] += 1; }));
  try {
    module.notifyPublicDataUpdated({ clients: { upsert: [{ uuid: 'node-a', name: 'A' }] } });
    module.notifyPublicDataUpdated();
    assert.deepEqual(counts, [2, 2], 'a later real settings change is not a duplicate of the client patch');
  } finally { stops.forEach(stop => stop()); }
});

test('AUD-39 authoritative empty live snapshot clears stale online state', async () => {
  let state = { online: ['node-a'], clients: [{ uuid: 'node-a', name: 'A', lastReportTime: 1 }], data: { 'node-a': { cpu: 50 } }, count: 1, timestamp: 1 };
  let error = 'old error';
  let rejectFetch = false;
  const scopeOwner = {};
  const load = productionDeclaration('src/contexts/LiveDataContext.tsx', 'fetchLiveData', {
    authLoading: false, includeHidden: false, enabled: true, scopeOwner,
    liveScopeRef: { current: productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope(scopeOwner) },
    fetch: async () => { if (rejectFetch) throw new Error('Synthetic network failure'); return new Response(JSON.stringify({ online: [], clients: [], data: {}, count: 0, timestamp: 2 })); },
    normalizeLiveDataResponse,
    isEmptyLiveSnapshot: productionDeclaration('src/contexts/LiveDataContext.tsx', 'isEmptyLiveSnapshot'),
    applyLiveMetadataVersion() {},
    setLiveData: value => { state = typeof value === 'function' ? value(state) : value; },
    setError: value => { error = value; }, setLoading() {}, getErrorMessage: value => value.message,
  });
  await load();
  assert.deepEqual(state.online, [], 'valid empty 200 snapshot is authoritative after the final node goes offline');
  assert.equal(state.count, 0);
  assert.equal(Object.keys(state.data).length, 0);
  assert.equal(error, null);
  rejectFetch = true;
  await load();
  assert.equal(error, 'Synthetic network failure');
});

test('AUD-39 authoritative empty client list removes the last deleted client', async () => {
  const fixture = indexBootstrapFixture();
  try {
    await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'A' }] });
    assert.deepEqual(fixture.rows(), [['node-a', 'A']]);
    fixture.visible();
    await fixture.reply(1, { clients: [] });
    assert.equal(fixture.state.clients.length, 0, 'deleting the final client must remove the old list item');
    assert.equal(fixture.state.error, null);
  } finally { fixture.cleanup(); }
});

test('AUD-38 Windows command data retains literal PowerShell argument values', {
  skip: spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).error?.code === 'ENOENT',
}, () => {
  const { buildAgentInstallCommand, defaultAgentInstallOptions } = productionModule('src/utils/agentInstallCommand.ts');
  const evaluateOutputOnly = (probe) => {
    const guard = `$probe=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(probe, 'utf16le').toString('base64')}')); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($probe,[ref]$tokens,[ref]$errors); if($errors.Count) { throw 'Probe parse error' }; $commands=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)); foreach($command in $commands) { if($command.GetCommandName() -ne 'Write-Output') { throw 'Unexpected command boundary' } }; if($ast.Find({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true)) { throw 'Unexpected member invocation' }; & ([scriptblock]::Create($probe))`;
    return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + guard, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  };
  const allowedSentinel = evaluateOutputOnly("Write-Output 'AUDIT_SAFE_RECEIVER'");
  assert.equal(allowedSentinel.status, 0);
  assert.equal(allowedSentinel.stdout.trim(), 'AUDIT_SAFE_RECEIVER');
  const blockedSentinel = evaluateOutputOnly("Invoke-WebRequest 'https://synthetic.invalid'");
  assert.notEqual(blockedSentinel.status, 0);
  assert.ok(blockedSentinel.stderr.includes('Unexpected command boundary'));
  console.log('AUD-38 sentinel: only Write-Output is executable; download boundary was rejected before invocation');
  for (const nodeName of ['audit $(Write-Output AUDIT_INTERPOLATED)', '中文 空格 \' single " double ` backtick $variable']) {
      const command = buildAgentInstallCommand({
        platform: 'windows', serverUrl: 'https://synthetic.invalid', token: 'synthetic-token', instanceId: 'audit-node', nodeName,
        options: { ...defaultAgentInstallOptions, dir: 'C:\\audit path', serviceName: 'audit-service' },
      });
      let script;
      const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
      if (encoded) {
        script = Buffer.from(encoded[1], 'base64').toString('utf16le');
      } else {
        // Only evaluate the known harmless first fixture's OUTER STRING. Never execute its script.
        assert.equal(nodeName, 'audit $(Write-Output AUDIT_INTERPOLATED)', 'legacy quoting is only probed with the fixed harmless expression fixture');
        const outerArgument = command.slice(command.indexOf(' -Command ') + ' -Command '.length);
        const result = evaluateOutputOnly(`Write-Output ${outerArgument}`);
        assert.equal(result.status, 0, result.stderr);
        script = result.stdout.trim();
        assert.ok(script.includes(nodeName), 'the generated outer string must not evaluate the literal node-name expression');
      }
      // The original command is DATA for the PowerShell parser, never a scriptblock to invoke.
      const parser = `$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if($errors.Count) { throw 'Generated command has parse errors' }; $install=$ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.CommandElements[0].Value -eq '.\\install-windows.ps1' },$true); $values=@{}; for($i=1;$i -lt $install.CommandElements.Count;$i+=2) { $values[$install.CommandElements[$i].ParameterName]=$install.CommandElements[$i+1].Value }; $values | ConvertTo-Json -Compress`;
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + parser, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      const received = JSON.parse(result.stdout.trim());
      assert.equal(received.n, nodeName);
      assert.equal(received.InstallDir, 'C:\\audit path');
      assert.equal(received.ServiceName, 'audit-service');
  }
});

test('AUD-46 toggling offline notification preserves saved grace period', async () => {
  for (const [savedGrace, expected] of [[1200, 1200], [undefined, 360]]) {
    const requests = [];
    const toggle = productionDeclaration(notifications, 'toggleOffline', {
      runAction: passthroughAction,
      DEFAULT_GRACE_PERIOD_SEC: 360,
      notificationMap: new Map([['node-a', { grace_period: savedGrace }]]),
      apiFetch: async (_path, options) => { requests.push(JSON.parse(options.body)); return { success: true }; },
      toast: { success() {}, error() {} }, loadOfflineTab() {},
    });
    await toggle('node-a', false);
    await toggle('node-a', true);
    assert.deepEqual(requests.map(item => item.grace_period), [expected, expected]);
  }
});

test('AUD-47 legal stored intervals survive opening and unrelated saving', () => {
  const stored = { record_persist_interval_sec: '60', ping_record_persist_interval_sec: '300', live_poll_idle_interval_sec: '600', record_preserve_time: '24' };
  const normalize = productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'normalizeGeneralSettings');
  const opened = normalize(stored);
  assert.deepEqual({ ...opened }, stored, 'opening the form must not rewrite legitimate saved intervals');
  assert.deepEqual(getChangedSettings({ ...opened, record_preserve_time: '48' }, stored), { record_preserve_time: '48' });
});

test('history retention settings save raw snapshots and clamp the shared rollup setting', () => {
  const save = productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'buildSavePayload', {
    clampInteger: productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'clampInteger'),
    DEFAULT_RETENTION_HOURS: 720, MAX_RETENTION_HOURS: 720,
    DEFAULT_PING_RAW_RETENTION_HOURS: 168, MAX_PING_RAW_RETENTION_HOURS: 720,
    DEFAULT_PING_ROLLUP_RETENTION_HOURS: 2160, MAX_PING_ROLLUP_RETENTION_HOURS: 8760,
    DEFAULT_ACTIVE_SAMPLE_SEC: 3, DEFAULT_IDLE_UPLOAD_SEC: 120, MIN_IDLE_UPLOAD_SEC: 60,
    DEFAULT_VIEWER_TTL_SEC: 120, DEFAULT_RECORD_PERSIST_SEC: 120,
    DEFAULT_PING_RECORD_PERSIST_SEC: 120, DEFAULT_RECORD_HIGH_WATERMARK_ROWS: 700_000,
  });
  const payload = save({ record_preserve_time: '720', ping_record_preserve_time: '168', rollup_preserve_time: '2160' });
  assert.equal(payload.record_preserve_time, '720');
  assert.equal(payload.ping_record_preserve_time, '168');
  assert.equal(payload.rollup_preserve_time, '2160');
  assert.equal('ping_rollup_preserve_time' in payload, false);
  const clamped = save({ record_preserve_time: '720', ping_record_preserve_time: '9999', rollup_preserve_time: '99999' });
  assert.equal(clamped.ping_record_preserve_time, '720');
  assert.equal(clamped.rollup_preserve_time, '8760');
});

test('AUD-48 Telegram test pins Telegram independently of global channel', async () => {
  for (const method of ['none', 'email', 'webhook', 'telegram']) {
    let body;
    const send = productionDeclaration(notifications, 'sendTestMessage', {
      runAction: passthroughAction,
      settings: { notification_method: method },
      apiFetch: async (_path, options) => { body = JSON.parse(options.body); return { success: true }; },
      toast: { success() {}, error() {} },
    });
    await send();
    assert.equal(body.channel, 'telegram', `Telegram action must ignore global method ${method}`);
  }
});

test('AUD-45 directed load rules reject an empty target list before posting', async () => {
  const requests = [];
  const errors = [];
  const save = productionDeclaration(notifications, 'saveLoadNotification', {
    runAction: passthroughAction,
    editingLoad: null,
    loadForm: { name: 'Synthetic rule', metric: 'cpu', threshold: 80, ratio: 0.8, interval_min: 15, all_clients: false, clients: [] },
    apiFetch: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { success: true }; },
    toast: { success() {}, error(message) { errors.push(message); } },
    setLoadDialogOpen() {}, loadLoadTab() {},
  });
  await save();
  assert.equal(requests.length, 0, 'a directed rule with zero selected nodes must not be posted as a global rule');
  assert.equal(errors.length, 1, 'the user must receive a target-selection error');
});

test('AUD-50 controlled load threshold and ratio render legitimate zero values', () => {
  assert.match(notificationSource, /value=\{String\(loadForm\.threshold \?\? 80\)\}/,
    'a threshold of zero must be passed through instead of replaced by the default');
  assert.match(notificationSource, /value=\{String\(loadForm\.ratio \?\? 0\.8\)\}/,
    'a ratio of zero must be passed through instead of replaced by the default');
});

test('AUD-50 load rule summaries use metric units and keep zero', () => {
  assert.match(notificationSource, /item\.threshold \?\? 80\}\{loadMetricUnit\(item\.metric\)\}/,
    'zero thresholds must render with the metric unit');
  assert.match(notificationSource, /function loadMetricUnit\(metric\?: string\): string/);
});

test('R-A11 unavailable host temperature preserves the rest of a history sample', () => {
  const base = { time: '2026-09-09T01:00:00Z', cpu: 23, ram: 512, ram_total: 1024, net_in: 4096 };
  for (const input of [{}, { temp: null }, { temp: undefined }, { temp: NaN }, { temp: Infinity }, { temp: 'unknown' }]) {
    const record = normalizePublicMonitorRecord({ ...base, ...input });
    assert.ok(record, 'unavailable temperature cannot discard CPU/network history');
    assert.equal(record.temp, null, 'unavailable temperature is not a measured zero');
    assert.equal(record.cpu, 23);
    assert.equal(record.net_in, 4096);
    const point = buildMonitorChartData([record])[0];
    assert.equal(point.temp, null);
    assert.equal(point.ram, 50);
  }
});

test('R-A11 measured zero and signed Celsius remain numeric', () => {
  for (const temp of [0, -12.5, 42.25]) {
    const record = normalizePublicMonitorRecord({ time: '2026-09-09T01:00:00Z', temp, temperature: 87 });
    assert.equal(record.temp, temp);
    assert.equal(buildMonitorChartData([record])[0].temp, temp);
  }
});

test('R-A11 mixed host temperature history retains null gaps without losing other metrics', () => {
  const temperatures = [10, 12, null, null, 0, -7, null, 25, 30];
  const records = normalizePublicMonitorRecords(temperatures.map((temp, index) => ({
    time: new Date(Date.parse('2026-09-09T01:00:00Z') + index * 1000).toISOString(), cpu: index + 1, temp,
  })));
  assert.equal(records.length, temperatures.length, 'every otherwise-valid sample survives');
  const points = buildMonitorChartData(records);
  assert.deepEqual(points.map(point => point.temp), temperatures);
  assert.deepEqual(points.map(point => point.cpu), temperatures.map((_temp, index) => index + 1));
});

test('R-A11 empty and raw missing-temperature chart points never fabricate zero', () => {
  const points = getMonitorChartRenderData([], 3600000, Date.parse('2026-09-09T02:00:00Z'));
  assert.equal(points.length, 2, 'empty history retains its time-axis bounds');
  assert.ok(points.every(point => point.temp === null), 'axis placeholders contain no measured temperature');
  assert.equal(buildMonitorChartData([{ time: '2026-09-09T01:00:00Z', cpu: 10 }])[0].temp, null);
});

test('R-A11 node-card fallback has no fabricated host temperature', () => {
  const fallback = productionDeclaration('src/components/NodeCard.tsx', 'defaultLive');
  assert.equal(fallback.temp, null, 'an absent live record is not a measured zero');
});

test('R-F02 invalid settings responses never become a confirmed cache baseline', async () => {
  for (const payload of [null, [], 'invalid', { record_preserve_time: null }]) {
    const settingsCacheRef = { current: {} };
    const settingsRequestsRef = { current: {} };
    const load = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'loadSettingsScope', {
      settingsCacheRef, settingsRequestsRef, apiFetch: async () => payload,
      setSettingsScope: (scope, value) => { settingsCacheRef.current[scope] = value; },
    });
    await assert.rejects(load('general'), /设置|settings|响应|格式/i, 'invalid response is a read failure');
    assert.equal(settingsCacheRef.current.general, undefined);
    assert.equal(settingsRequestsRef.current.general, undefined, 'a rejected request must be retryable');
  }
});

test('R-F03 a slow logo reset patches only the latest confirmed logo field', async () => {
  const response = Promise.withResolvers();
  const settingsCacheRef = { current: { site: { site_title: 'Original', site_logo_url: '/old.png' } } };
  const setSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'setSettingsScope', {
    settingsCacheRef, setSettingsCacheState() {},
  });
  const reset = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'handleResetLogo', {
    settings: { site_title: 'Unsaved draft', site_logo_url: '/old.png' },
    apiFetch: () => response.promise, setLogoSaving() {}, setSettings() {}, setOriginalSettings() {},
    setSettingsScope, notifyPublicDataUpdated() {}, toast: { success() {}, error(message) { throw new Error(message); } },
  });
  const pending = reset();
  setSettingsScope('site', { site_title: 'Newer confirmed title', site_logo_url: '/old.png' });
  response.resolve({ success: true });
  await pending;
  assert.equal(settingsCacheRef.current.site.site_title, 'Newer confirmed title', 'a logo response cannot promote an older draft or revert a newer saved title');
  assert.equal(settingsCacheRef.current.site.site_logo_url, '');
});

test('R-F03 a slow title save preserves a logo confirmed while the request was pending', async () => {
  const response = Promise.withResolvers();
  const settingsCacheRef = { current: { site: { site_title: 'Original', site_logo_url: '/old.png' } } };
  const setSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'setSettingsScope', { settingsCacheRef, setSettingsCacheState() {} });
  const save = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'handleSave', {
    settings: { site_title: 'Confirmed title', site_logo_url: '/old.png' }, originalSettings: { site_title: 'Original', site_logo_url: '/old.png' },
    settingsReady: true, loading: false, loadError: null, saving: false,
    getChangedSettings: productionModule('src/utils/settingsDiff.ts').getChangedSettings,
    apiFetch: () => response.promise, setSaving() {}, setOriginalSettings() {}, setSettingsScope,
    notifyPublicDataUpdated() {}, toast: { success() {}, info() {}, error(message) { throw new Error(message); } },
  });
  const pending = save();
  setSettingsScope('site', { site_title: 'Original', site_logo_url: '/confirmed-logo.png' });
  response.resolve({ success: true });
  await pending;
  assert.equal(settingsCacheRef.current.site.site_logo_url, '/confirmed-logo.png', 'an unrelated title response cannot roll back the confirmed logo');
  assert.equal(settingsCacheRef.current.site.site_title, 'Confirmed title');
});

test('R-F04 a failed clients reorder cannot undo another confirmed edit', async () => {
  const response = Promise.withResolvers();
  const initial = [{ uuid: 'a', name: 'Alpha', sort_order: 0 }, { uuid: 'b', name: 'Beta', sort_order: 1 }];
  let current = structuredClone(initial);
  const update = value => { current = typeof value === 'function' ? value(current) : value; };
  const reorder = productionDeclaration('src/pages/admin/Dashboard.tsx', 'handleDragEnd', {
    clients: initial, filtered: initial, dragDisabled: false,
    setClients: update, updateClients: update,
    clientOrderRef: { current: 0 },
    apiFetch: () => response.promise,
    loadClients: async () => {},
    moveAdminNodeInVisibleOrder: productionModule('src/utils/adminNodeOrder.ts').moveAdminNodeInVisibleOrder,
    arrayMove: (items, from, to) => { const list = [...items]; list.splice(to, 0, list.splice(from, 1)[0]); return list; },
    assertSuccess: result => { if (!result.success) throw new Error('Rejected reorder'); },
    notifyPublicDataUpdated() {},
    toast: { error() {}, success() {} },
  });
  const pending = reorder({ active: { id: 'a' }, over: { id: 'b' } });
  current = current.map(item => item.name === 'Alpha' ? { ...item, name: 'Newest persisted name' } : item);
  response.resolve({ success: false });
  await pending;
  assert.ok(current.some(item => item.name === 'Newest persisted name'), 'rollback changes order only, preserving newer fields');
  assert.equal(current[0].name, 'Newest persisted name', 'the original order is restored');
});

test('R-F06 logout waits for confirmation, deduplicates and preserves authentication on failure', async () => {
  const response = Promise.withResolvers();
  let requests = 0;
  let clears = 0;
  const logout = productionDeclaration('src/contexts/AuthContext.tsx', 'logout', {
    clearAuth: () => { clears += 1; }, API_BASE: '/api', CSRF_COOKIE_NAME: 'csrf', readCookie: () => 'synthetic',
    logoutRequestRef: { current: null }, authRevisionRef: { current: 0 },
    readJson: response => response.json(), fetch: () => { requests += 1; return response.promise; },
  });
  const first = logout();
  const second = logout();
  response.resolve(new Response(JSON.stringify({ error: 'Rejected logout' }), { status: 500 }));
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(requests, 1, 'one server logout while pending');
  assert.equal(clears, 0, 'a failed logout cannot clear the displayed session');
  assert.equal(outcomes[0].status, 'rejected', 'the caller receives the error and can offer retry');
});

test('R-F06 an authenticated API rejection clears local state without an explicit logout request', async () => {
  let clears = 0;
  let logouts = 0;
  const api = productionDeclaration('src/contexts/AuthContext.tsx', 'useApiResponse', {
    useAuth: () => ({ clearAuth: () => { clears += 1; }, logout: () => { logouts += 1; } }),
    useCallback: value => value, runWithMfaStepUpRetry: request => request(), requestMfaStepUp() {},
    buildApiRequest: path => ({ url: path, init: {} }),
    fetch: async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }),
    readJson: response => response.json(), shouldClearAuthForStatus: status => status === 401,
  })();
  await assert.rejects(api('/admin/synthetic'), /Session expired/);
  assert.equal(clears, 1, 'session rejection invalidates local authentication');
  assert.equal(logouts, 0, '401 handling does not create an extra authenticated mutation');
});

test('R-F06 an earlier session lookup cannot restore an authenticated user after logout', async () => {
  const response = Promise.withResolvers();
  let user = { uuid: 'old', username: 'Old administrator' };
  const authRevisionRef = { current: 0 };
  const setUser = update => { user = typeof update === 'function' ? update(user) : update; };
  const clearAuth = () => { authRevisionRef.current += 1; user = null; };
  const effect = productionEffect('src/contexts/AuthContext.tsx', 'shouldCheckSession', {
    API_BASE: '/api', window: { location: { pathname: '/admin' } }, shouldCheckAdminSessionOnLoad: () => true,
    authRevisionRef, setAuthLoading() {}, clearAuth, setUser, writeStoredUser() {},
    normalizeAuthUser: payload => payload.uuid ? payload : null, readJson: response => response.json(), fetch: () => response.promise,
  });
  const cleanup = effect();
  clearAuth();
  response.resolve(new Response(JSON.stringify({ uuid: 'old', username: 'Old administrator' })));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(user, null, 'a completed logout retires pending session hydration');
  cleanup();
});

test('R-F08 a retired verification cannot finish a newer MFA dialog', async () => {
  const response = Promise.withResolvers();
  const completed = [];
  const resolver = { current: value => completed.push(['old', value]) };
  const pendingRequestRef = { current: null };
  const finish = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'finish', {
    resolver, pendingRequestRef, setOpen() {}, setSubmitting() {}, setCode() {}, setError() {}, setMethod() {},
  });
  const submit = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'submit', {
    resolver, pendingRequestRef, code: '123456', method: 'totp', AbortController,
    normalizeMfaCode: productionModule('src/utils/mfa.ts').normalizeMfaCode,
    setSubmitting() {}, setError() {}, buildApiRequest: () => ({ url: '/synthetic', init: {} }), fetch: () => response.promise, finish,
  });
  const pending = submit();
  finish(false);
  resolver.current = value => completed.push(['new', value]);
  response.resolve(new Response(JSON.stringify({ success: true })));
  await pending;
  assert.deepEqual(completed, [['old', false]], 'late success cannot resolve the newer dialog');
  assert.equal(typeof resolver.current, 'function', 'the new dialog stays pending');
});

test('R-F08 unmount retires verification errors and resolves cancellation', async () => {
  const response = Promise.withResolvers();
  const completed = [];
  let changes = 0;
  const resolver = { current: value => completed.push(value) };
  const pendingRequestRef = { current: null };
  const bindings = {
    resolver, pendingRequestRef, code: '123456', method: 'totp', AbortController,
    normalizeMfaCode: productionModule('src/utils/mfa.ts').normalizeMfaCode,
    setSubmitting: () => { changes += 1; }, setError: () => { changes += 1; },
    buildApiRequest: () => ({ url: '/synthetic', init: {} }), fetch: () => response.promise, finish() {},
  };
  const pending = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'submit', bindings)();
  changes = 0;
  productionEffect('src/components/MfaStepUpDialog.tsx', 'resolver.current?.(false)', bindings)()();
  response.resolve(new Response(JSON.stringify({ error: 'Late failure' }), { status: 500 }));
  await pending;
  assert.equal(changes, 0, 'unmounted verification cannot write error/loading state');
  assert.deepEqual(completed, [false], 'unmount cancels the suspended original operation');
});

test('R-F09 an initial removal and later update survive a full read without reviving removed fields', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  scope.patch({ type: 'remove', client: 'a', timestamp: 1 });
  const read = scope.beginRead();
  scope.patch({ type: 'update', client: 'a', data: { cpu: 70 }, timestamp: 2 });
  const result = scope.complete(read, { online: ['a', 'b'], clients: [], data: { a: { cpu: 10, ram: 99 }, b: { cpu: 30 } }, count: 2, timestamp: 0 });
  assert.equal(result.data.a.cpu, 70);
  assert.equal(result.data.a.ram, undefined, 'removal before reappearance discards the obsolete node record');
  assert.equal(result.data.b.cpu, 30, 'unaffected full-snapshot nodes remain');
});

test('R-F09 cached startup data cannot override a confirmed snapshot and disposed scopes cannot commit', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  const current = { online: ['a'], clients: [], data: { a: { cpu: 70 } }, count: 1, timestamp: 2 };
  scope.snapshot(current);
  assert.equal(scope.seed({ ...current, data: { a: { cpu: 10 } } }), undefined, 'cached reconnect seed cannot replace known live state');
  const read = scope.beginRead();
  scope.dispose();
  assert.equal(scope.complete(read, current), undefined);
  assert.equal(scope.canReportError(read), false, 'late scope errors are also obsolete');
  assert.equal(scope.patch({ type: 'update', client: 'a', data: { cpu: 10 }, timestamp: 3 }), undefined);
});

for (const type of ['update', 'remove']) {
  test(`R-F09 retry discards a pre-retry ${type} superseded by the new full snapshot`, () => {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    const first = scope.beginRead();
    scope.patch({ type, client: 'a', data: { cpu: 10 }, timestamp: 100 });
    assert.equal(scope.canReportError(first), true, 'a partial update never conceals the initial full-read failure');
    scope.finishRead(first);
    const retry = scope.beginRead();
    const snapshot = { online: ['a', 'b'], clients: [], data: { a: { cpu: 20, ram: 200 }, b: { cpu: 30 } }, count: 2, timestamp: 200 };
    const result = scope.complete(retry, snapshot);
    assert.equal(result.data.a?.cpu, 20, 'a successful newer snapshot supersedes pre-retry socket history');
    assert.equal(result.data.a.ram, 200);
    assert.equal(result.data.b.cpu, 30);
    assert.equal(result.timestamp, 200, 'the read must not roll snapshot freshness backward');
  });
}

test('R-F09 retry preserves pre-read patches that are newer than a returned cached snapshot', () => {
  for (const type of ['update', 'remove']) {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    const first = scope.beginRead();
    scope.patch({ type, client: 'a', data: { cpu: 70 }, timestamp: 100 });
    scope.finishRead(first);
    const retry = scope.beginRead();
    const result = scope.complete(retry, { online: ['a', 'b'], clients: [], data: { a: { cpu: 20 }, b: { cpu: 30 } }, count: 2, timestamp: 50 });
    assert.equal(result.data.a?.cpu, type === 'update' ? 70 : undefined);
    assert.equal(result.data.b.cpu, 30);
  }
});

test('R-F09 retry replays during-read updates without resurrecting an older removal', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  const first = scope.beginRead();
  scope.patch({ type: 'remove', client: 'a', timestamp: 100 });
  scope.finishRead(first);
  const retry = scope.beginRead();
  scope.patch({ type: 'update', client: 'a', data: { cpu: 70 }, timestamp: 300 });
  const result = scope.complete(retry, { online: ['a', 'b'], clients: [], data: { a: { cpu: 20, ram: 200 }, b: { cpu: 30 } }, count: 2, timestamp: 200 });
  assert.equal(result.data.a.cpu, 70);
  assert.equal(result.data.a.ram, 200, 'a removal already superseded before the retry cannot erase fields from its fresh baseline');
  assert.equal(result.data.b.cpu, 30);
});

test('R-F09 cache seed compares initial socket history with the snapshot timestamp', () => {
  for (const snapshotTime of [50, 200]) {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    scope.patch({ type: 'update', client: 'a', data: { cpu: 10 }, timestamp: 100 });
    const result = scope.seed({ online: ['a', 'b'], clients: [], data: { a: { cpu: 20 }, b: { cpu: 30 } }, count: 2, timestamp: snapshotTime });
    assert.equal(result.data.a.cpu, snapshotTime === 50 ? 10 : 20);
    assert.equal(result.data.b.cpu, 30);
  }
});
