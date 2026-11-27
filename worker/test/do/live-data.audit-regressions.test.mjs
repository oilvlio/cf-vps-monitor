import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

function fixture(overrides = {}) {
  let now = Date.parse('2026-11-01T00:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const storage = createDurableState();
  const loader = createWorkerLoader({ globals: { Date: Clock }, db: {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    getSetting: async () => null, setSetting: async () => {},
    listPingTasks: async () => [], insertAuditLog: async () => {},
    tryClaimAuditThrottle: async () => true, updateClient: async () => {},
    ...overrides,
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  const post = (path, body) => object.fetch(new Request(`https://do${path}`, {
    method: 'POST', body: JSON.stringify(body),
  }));
  const env = { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) } };
  return { object, storage, loader, post, env, cold: () => new LiveDataDO(storage.state, {}),
    get now() { return now; }, advance: ms => { now += ms; } };
}

for (const action of ['rotate', 'remove']) {
  test(`a delayed database auth lookup cannot undo ${action}`, async () => {
    let enter, release, row;
    const started = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ getClientByToken: async () => { enter(); await gate; return row; },
      markClientTokenUsed: async () => ({ updated: false }) });
    const { hashAgentToken } = f.loader.load('worker/src/utils/client.ts');
    const oldToken = 'a'.repeat(64), newToken = 'b'.repeat(64);
    const oldHash = await hashAgentToken(oldToken), newHash = await hashAgentToken(newToken);
    row = { uuid: 'node', name: 'Node', hidden: false, token: oldToken, token_hash: oldHash };
    const { getAgentClientByToken } = f.loader.load('worker/src/routes/client.ts');
    const pending = getAgentClientByToken(f.loader.database, oldToken, f.env, '', p => f.storage.state.waitUntil(p));
    await started;
    if (action === 'rotate') await f.post('/agent-auth', { client: { ...row, token: '', token_hash: newHash } });
    else await f.post('/client-remove', { uuid: 'node' });
    release();
    await pending;
    await f.storage.drain();
    assert.equal((await f.post('/agent-auth/lookup', { token_hash: oldHash })).status, 404);
    if (action === 'rotate') assert.equal((await f.post('/agent-auth/lookup', { token_hash: newHash })).status, 200);
    const fresh = createWorkerLoader({ db: { getClientByToken: async () => null } });
    assert.equal(await fresh.load('worker/src/routes/client.ts').getAgentClientByToken(fresh.database, oldToken, f.env), null);
  });
}

test('disconnected WebSocket reports retain liveness through the grace period and cold restart', async () => {
  const f = fixture();
  const socket = createSocket({ role: 'agent', clientId: 'node', clientName: 'Node', hidden: false });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { timestamp: f.now, cpu: 10 } }));
  await f.storage.drain();
  const receivedAt = f.now;
  socket.ws.readyState = 3;
  await f.object.webSocketClose(socket.ws);
  const evaluate = async (object, fallbackLastSeen = 0) => {
    const response = await object.fetch(new Request('https://do/offline-evaluate', { method: 'POST',
      body: JSON.stringify({ clients: [{ uuid: 'node', graceMs: 360000, fallbackLastSeen }] }) }));
    return (await response.json()).clients.node;
  };
  for (const delta of [1000, 120000, 120000]) {
    f.advance(delta);
    assert.deepEqual(await evaluate(f.object), { lastSeen: receivedAt, offline: false, streak: 0 });
  }
  assert.deepEqual(await evaluate(f.cold()), { lastSeen: receivedAt, offline: false, streak: 0 });
  f.advance(119000);
  assert.deepEqual(await evaluate(f.object), { lastSeen: receivedAt, offline: true, streak: 1 });
  assert.deepEqual(await evaluate(f.object, f.now), { lastSeen: f.now, offline: false, streak: 0 });
});

test('recreated UUID persists identical hardware and network metadata and reloads traffic totals', async () => {
  const writes = [];
  let trafficCalls = 0;
  const f = fixture({ updateClient: async (_db, uuid, patch) => writes.push({ uuid, patch }),
    applyTrafficSamples: async () => ({ up: ++trafficCalls === 1 ? 10000 : 0, down: 0, applied: 1 }) });
  const client = { uuid: 'node', name: 'Node', hidden: false, cpu_name: '', cpu_cores: 0, mem_total: 0, traffic_reset_day: 1 };
  const report = up => ({ timestamp: f.now, cpu: 10, ipv4: '8.8.8.8', region: 'US',
    basic_info: { cpu_name: 'Example CPU', cpu_cores: 4, mem_total: 4096 },
    traffic_sample: { scope: 'a', boot: 1000, utc_offset: 0, interfaces: { eth0: { up, down: 0 } } } });
  const send = async up => {
    assert.equal((await f.post('/client-report', { uuid: 'node', report: report(up) })).status, 200);
    await f.storage.drain();
  };
  await f.post('/client-meta', { uuid: 'node', client });
  await send(1000);
  assert.equal(f.storage.values.get('http-live:node').lastReport.net_total_up, 10000);
  f.storage.values.set('record:persist:node', f.now);
  f.storage.values.set('offline:streak:node', 3);
  for (let i = 0; i < 129; i++) f.storage.values.set(`ping-result:node:${i}`, { lastAcceptedMs: f.now });
  f.storage.values.set('ping-result:other:1', { lastAcceptedMs: f.now });
  await f.post('/client-remove', { uuid: 'node' });
  assert.equal(f.storage.values.has('record:persist:node'), false);
  assert.equal(f.storage.values.has('offline:streak:node'), false);
  assert.equal([...f.storage.values.keys()].some(key => key.startsWith('ping-result:node:')), false);
  assert.equal(f.storage.values.has('ping-result:other:1'), true);
  writes.length = 0;
  await f.post('/client-meta', { uuid: 'node', client });
  f.advance(5000);
  await send(50);
  assert.equal(trafficCalls, 2, 'the new lifecycle must immediately reload database totals');
  assert.equal(f.storage.values.get('http-live:node').lastReport.net_total_up, 0);
  assert.ok(writes.some(({ patch }) => patch.cpu_cores === 4));
  assert.ok(writes.some(({ patch }) => patch.ipv4 === '8.8.8.8'));
  const snapshot = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
  assert.equal(snapshot.clients[0].cpu_cores, 4);
});

test('disconnecting for token rotation preserves traffic totals and persistence state', async () => {
  let calls = 0;
  const f = fixture({ applyTrafficSamples: async () => { calls++; return { up: 10000, down: 0, applied: 1 }; } });
  const send = up => f.post('/client-report', { uuid: 'node', report: { timestamp: f.now, cpu: 10,
    traffic_sample: { scope: 'a', boot: 1000, utc_offset: 0, interfaces: { eth0: { up, down: 0 } } } } });
  await send(1000);
  await f.storage.drain();
  f.storage.values.set('record:persist:node', f.now);
  await f.post('/client-remove', { uuid: 'node', keepMetadata: true });
  assert.equal(f.storage.values.has('record:persist:node'), true);
  f.advance(5000);
  await send(1050);
  await f.storage.drain();
  assert.equal(calls, 1);
  assert.equal(f.storage.values.get('http-live:node').lastReport.net_total_up, 10050);
});

test('a delayed network metadata write cannot repopulate a recreated node cache', async () => {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const f = fixture({ updateClient: async () => { if (++writes === 1) { enter(); await gate; } } });
  const client = { uuid: 'node', name: 'Node', hidden: false };
  const send = () => f.post('/client-report', { uuid: 'node', report: {
    timestamp: f.now, cpu: 10, ipv4: '8.8.8.8', region: 'US',
  } });
  await f.post('/client-meta', { uuid: 'node', client });
  await send();
  await started;
  await f.post('/client-remove', { uuid: 'node' });
  await f.post('/client-meta', { uuid: 'node', client });
  release();
  await f.storage.drain();
  await send();
  await f.storage.drain();
  assert.equal(writes, 2, 'the old completion must not suppress the new metadata write');
  const snapshot = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
  assert.equal(snapshot.clients[0].ipv4, '8.8.8.8');
});
