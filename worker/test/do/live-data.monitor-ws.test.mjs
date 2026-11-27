import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const GIB = 1024 ** 3;
const NODE_KEYS = [
  'id', 'name', 'sort', 'public', 'online', 'metrics', 'country', 'group', 'public_remark',
  'os', 'kernel', 'arch', 'virt', 'cpu_name', 'cpu_cores', 'mem_total', 'swap_total',
  'disk_total', 'agent_version', 'last_seen', 'last_seen_ago', 'billing_cycle', 'currency',
  'price', 'expires_at', 'expires_in', 'traffic_limit', 'traffic_mode', 'traffic_reset_day',
  'month_start', 'month_rx', 'month_tx', 'month_used', 'day_rx', 'day_tx', 'total_rx', 'total_tx',
];
const METRICS_KEYS = [
  'cpu', 'load', 'mem_total', 'mem_used', 'swap_total', 'swap_used', 'disk_total', 'disk_used',
  'net_rx', 'net_tx', 'tcp', 'udp', 'procs', 'uptime', 'total_rx', 'total_tx', 'month_rx', 'month_tx',
];

// 完整的 db.Client 行：DO 的静态投影直接由 admin 元数据派生（不再由 Worker 推送）。
const CLIENTS = [
  {
    uuid: 'node-1', name: '东京', sort_order: 1, hidden: false,
    region: 'JP', group: '亚洲', public_remark: '直连',
    os: 'Debian', kernel_version: '6.12.0', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'EPYC', cpu_cores: 2,
    mem_total: 2 * GIB, swap_total: GIB, disk_total: 40 * GIB,
    version: '1.2.0', billing_cycle: 30, currency: 'CNY', price: 29.9,
    expired_at: '2030-01-11T00:00:00.000Z',
    traffic_limit: 1024 * GIB, traffic_limit_type: 'sum', traffic_reset_day: 1,
  },
  {
    uuid: 'node-2', name: '离线节点', sort_order: 2, hidden: false,
    region: 'US', group: '', public_remark: '',
    os: 'Debian', kernel_version: '6.1', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'Xeon', cpu_cores: 1, mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    version: '1.0.0', billing_cycle: 365, currency: 'USD', price: 5,
    expired_at: '', traffic_limit: 0, traffic_limit_type: 'sum', traffic_reset_day: 1,
  },
  {
    // 隐藏节点：只进管理员连接的帧（public: false），绝不能进访客帧。
    uuid: 'node-hidden', name: '隐藏节点', sort_order: 3, hidden: true,
    region: 'JP', group: '', public_remark: '',
    os: 'Debian', kernel_version: '6.1', arch: 'x86_64', virtualization: 'kvm',
    cpu_name: 'Xeon', cpu_cores: 1, mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    version: '1.0.0', billing_cycle: 30, currency: 'CNY', price: 5,
    expired_at: '', traffic_limit: 0, traffic_limit_type: 'sum', traffic_reset_day: 1,
  },
];

const TOTALS = {
  'node-1': { day_rx: 100, day_tx: 50, total_rx: 1e12, total_tx: 5e11 },
  'node-2': { day_rx: 0, day_tx: 0, total_rx: 2e9, total_tx: 1e9 },
  'node-hidden': { day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 },
};

const ADMIN_SNAPSHOT = {
  clients: CLIENTS,
  updatedAt: 1,
  removed: [],
  complete: true,
};

function monitoredSocket({ gzip = false, admin = false, id = 'monitor-1', role = 'monitor' } = {}) {
  let attachment = { role, clientId: id, clientName: id, hidden: false, gzip, admin, ...(admin ? { adminToken: 'fixture-token' } : {}) };
  const frames = [];
  const ws = {
    readyState: 1,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: value => { attachment = structuredClone(value); },
    send: value => frames.push(value),
    close: () => { ws.readyState = 3; },
  };
  return { ws, frames };
}

class UpgradeResponse extends Response {
  constructor(body, init) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.upgraded = init?.status === 101;
    this.webSocket = init?.webSocket;
  }
  get status() { return this.upgraded ? 101 : super.status; }
}

function frameJson(frame) {
  if (typeof frame === 'string') return JSON.parse(frame);
  return JSON.parse(strFromU8(gunzipSync(new Uint8Array(frame))));
}

function fixture({ storageEntries = [], listClients, overrides, dbOverrides = {}, env = {} } = {}) {
  let now = Date.parse('2027-01-15T00:00:00.000Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const storage = createDurableState(storageEntries, []);
  storage.state.getWebSockets = () => storage.sockets.filter(socket => socket.readyState === 1);
  let alarmAt = null;
  storage.state.storage.setAlarm = async value => { alarmAt = Number(value); };
  storage.state.storage.deleteAlarm = async () => { alarmAt = null; };
  const loader = createWorkerLoader({
    db: {
      getSettingsByKeys: async () => ({ record_enabled: 'false' }),
      listPublicClientRows: async () => [],
      listClients: async () => listClients ?? CLIENTS,
      getTrafficTotals: async (_database, uuids) => Object.fromEntries(
        uuids.map(uuid => [uuid, TOTALS[uuid] ?? { day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0 }]),
      ),
      getSetting: async () => null,
      setSetting: async () => {},
      listPingTasks: async () => [],
      insertAuditLog: async () => {},
      tryClaimAuditThrottle: async () => true,
      ...dbOverrides,
    },
    overrides: {
      'worker/src/auth/jwt.ts': { verifyAdminToken: async token => token === 'fixture-token' ? { userId: 'admin', username: 'fixture', sessionVersion: 1 } : null },
      'worker/src/auth/admin-session.ts': { validateAdminSession: async () => ({ uuid: 'admin' }) },
      ...overrides,
    },
    globals: {
      Date: Clock,
      Response: UpgradeResponse,
      WebSocketPair: class {
        constructor() {
          this[0] = monitoredSocket({ id: 'monitor-client' }).ws;
          this[1] = monitoredSocket({ id: 'monitor-server' }).ws;
        }
      },
    },
  });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const { monitorNumericId } = loader.load('worker/src/monitor/contract.ts');
  const object = new LiveDataDO(storage.state, env);
  return {
    object, storage, monitorNumericId,
    get now() { return now; },
    get alarmAt() { return alarmAt; },
    advance(ms) { now += ms; },
    cold: () => new LiveDataDO(storage.state, env),
  };
}

/** 等 DO 的冷启动元数据与 monitor 静态投影就绪（替代旧的 /monitor-meta 推送）。 */
async function ready(object) {
  await object.httpClientsReady;
  await object.readyMonitorData();
}

function upgrade(object, role, id, ip = '1.1.1.1') {
  return object.fetch(new Request(`https://do/?role=${role}&id=${id}&viewer_ip=${ip}`, {
    headers: { Upgrade: 'websocket' },
  }));
}

test('real signed Monitor session stops sending hidden nodes after database session rotation despite warm cache', async () => {
  let version = 1;
  const env = { JWT_SECRET: 'monitor-session-fixture-secret-at-least-32-bytes' };
  const authLoader = createWorkerLoader({ db: { getUserByUuid: async () => ({ uuid: 'admin', username: 'fixture', session_version: version }) } });
  const jwt = authLoader.load('worker/src/auth/jwt.ts');
  const sessions = authLoader.load('worker/src/auth/admin-session.ts');
  const token = await jwt.generateToken('admin', 'fixture', 1, env);
  const f = fixture({ env, overrides: {
    'worker/src/auth/jwt.ts': jwt, 'worker/src/auth/admin-session.ts': sessions,
  } });
  await ready(f.object);
  const result = await f.object.fetch(new Request('https://do/?role=monitor&id=real-session&admin=1', {
    headers: { Upgrade: 'websocket', 'X-CF-Monitor-Admin-Token': token },
  }));
  assert.equal(result.status, 101);
  await f.storage.drain();
  const socket = f.storage.sockets[0];
  let privateFrames = 0;
  socket.send = value => {
    const frame = frameJson(value);
    assert.equal(frame.admin, true);
    assert.ok(frame.nodes.some(node => node.public === false));
    assert.ok(!JSON.stringify(frame).includes(token));
    privateFrames++;
  };
  await f.object.sendMonitorFrame(socket);
  assert.equal(privateFrames, 1);
  version = 2;
  await f.object.sendMonitorFrame(socket);
  assert.equal(privateFrames, 1);
  assert.equal(socket.readyState, 3);
});

test('real signed native private viewer revalidates the database session despite a warm authorization cache', async () => {
  let version = 1;
  const env = { JWT_SECRET: 'native-viewer-session-fixture-secret-at-least-32-bytes' };
  const authLoader = createWorkerLoader({ db: { getUserByUuid: async () => ({ uuid: 'admin', username: 'fixture', session_version: version }) } });
  const jwt = authLoader.load('worker/src/auth/jwt.ts');
  const sessions = authLoader.load('worker/src/auth/admin-session.ts');
  const token = await jwt.generateToken('admin', 'fixture', 1, env);
  const f = fixture({ env, overrides: {
    'worker/src/auth/jwt.ts': jwt, 'worker/src/auth/admin-session.ts': sessions,
  } });
  await ready(f.object);
  const result = await f.object.fetch(new Request('https://do/?role=viewer&id=signed-native&include_hidden=1', {
    headers: { Upgrade: 'websocket', 'X-CF-Monitor-Admin-Token': token },
  }));
  assert.equal(result.status, 101);
  await f.storage.drain();
  const ws = f.storage.sockets[0];
  const frames = [];
  ws.send = value => frames.push(JSON.parse(value));
  f.object.broadcastToViewers({ type: 'metadata_changed', private: true }, 'admin');
  await f.storage.drain();
  assert.equal(frames.length, 1);
  assert.ok(!JSON.stringify(frames).includes(token));
  version = 2;
  f.object.sendSnapshot(ws);
  f.object.broadcastToViewers({ type: 'metadata_changed', private: true }, 'admin');
  await f.storage.drain();
  assert.equal(frames.length, 1);
  assert.equal(ws.readyState, 3);
});

for (const transition of ['error', 'close']) {
  test(`native private viewer does not send after ${transition} while database validation is pending`, async () => {
    let release;
    let enter;
    const pending = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    const f = fixture({ overrides: {
      'worker/src/auth/admin-session.ts': { validateAdminSession: async () => {
        enter();
        await pending;
        return { uuid: 'admin' };
      } },
    } });
    await ready(f.object);
    const socket = createSocket({ role: 'viewer', clientId: 'waiting', includeHidden: true,
      adminToken: 'fixture-token' });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
    f.object.sendSnapshot(socket.ws);
    await entered;
    if (transition === 'error') await f.object.webSocketError(socket.ws);
    else await f.object.webSocketClose(socket.ws);
    release();
    await f.storage.drain();
    assert.ok(!socket.messages.some(frame => frame.type === 'snapshot'));
    assert.equal(f.object.activeViewerCount(f.now), 0);
  });
}

for (const reason of ['revoked', 'expired-token', 'database-failure', 'missing-token']) {
  test(`native private viewer rejects ${reason} after hibernation without sending snapshots or broadcasts`, async () => {
    let allowed = true;
    const f = fixture({ overrides: {
      'worker/src/auth/jwt.ts': { verifyAdminToken: async token => {
        if (!allowed && reason === 'expired-token') throw new Error('expired');
        return token ? { userId: 'admin', username: 'fixture', sessionVersion: 1 } : null;
      } },
      'worker/src/auth/admin-session.ts': { validateAdminSession: async (_db, _payload, options) => {
        assert.equal(options.fresh, true);
        if (!allowed && reason === 'database-failure') throw new Error('unavailable');
        return allowed ? { uuid: 'admin' } : null;
      } },
    } });
    await ready(f.object);
    const result = await f.object.fetch(new Request('https://do/?role=viewer&id=private&include_hidden=1', {
      headers: { Upgrade: 'websocket', 'X-CF-Monitor-Admin-Token': 'fixture-token' },
    }));
    assert.equal(result.status, 101);
    await f.storage.drain();
    const ws = f.storage.sockets[0];
    const frames = [];
    ws.send = value => frames.push(JSON.parse(value));
    f.object.broadcastToViewers({ type: 'metadata_changed', secret: 'private' }, 'admin');
    await f.storage.drain();
    assert.equal(frames.length, 1, 'valid private viewer receives administrator data');
    allowed = false;
    if (reason === 'missing-token') {
      const attachment = ws.deserializeAttachment();
      delete attachment.adminToken;
      ws.serializeAttachment(attachment);
    }
    const cold = f.cold();
    await ready(cold);
    cold.sendSnapshot(ws);
    cold.broadcastToViewers({ type: 'metadata_changed', secret: 'revoked' }, 'admin');
    await f.storage.drain();
    assert.equal(frames.length, 1);
    assert.equal(ws.readyState, 3);
    assert.equal(cold.activeViewerCount(f.now), 0);
  });

  test(`Monitor administrative frames fail closed after ${reason}, including gzip and hibernation`, async () => {
    let allowed = true;
    const f = fixture({ overrides: {
      'worker/src/auth/jwt.ts': { verifyAdminToken: async token => {
        if (!allowed && reason === 'expired-token') throw new Error('expired');
        return token ? { userId: 'admin', username: 'fixture', sessionVersion: 1 } : null;
      } },
      'worker/src/auth/admin-session.ts': { validateAdminSession: async (_db, _payload, options) => {
        assert.equal(options.fresh, true);
        if (!allowed && reason === 'database-failure') throw new Error('unavailable');
        return allowed || reason === 'expired-token' ? { uuid: 'admin' } : null;
      } },
    } });
    await ready(f.object);
    const socket = monitoredSocket({ id: 'revocable', admin: true, gzip: true });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
    f.storage.state.acceptWebSocket(socket.ws);
    await f.object.sendMonitorFrame(socket.ws);
    assert.equal(frameJson(socket.frames[0]).admin, true);
    allowed = false;
    if (reason === 'missing-token') {
      const attachment = socket.ws.deserializeAttachment();
      delete attachment.adminToken;
      socket.ws.serializeAttachment(attachment);
    }
    const cold = f.cold();
    await ready(cold);
    cold.broadcastMonitorFrame(true);
    await f.storage.drain();
    assert.equal(socket.frames.length, 1, 'no private frame after invalidation');
    assert.equal(socket.ws.readyState, 3);
    assert.equal(cold.activeViewerCount(f.now), 0);
    assert.equal(cold.countViewers().total, 0);
  });
}

for (const role of ['monitor', 'viewer']) {
  test(`${role} stays open and keeps Agent reports fast beyond 120s and across hibernation`, async () => {
    const f = fixture({ dbOverrides: { getSettingsByKeys: async () => ({
      record_enabled: 'false', live_poll_active_interval_sec: '2', live_poll_active_max_duration_sec: '120',
    }) } });
    await ready(f.object);
    const agent = monitoredSocket({ id: 'persistent-agent', role: 'agent' });
    f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
    f.storage.state.acceptWebSocket(agent.ws);
    assert.equal((await upgrade(f.object, role, 'continuous-viewer')).status, 101);
    await f.storage.drain();
    const socket = f.storage.sockets[1];
    let frames = 0;
    socket.send = value => {
      assert.notEqual(frameJson(value).type, 'viewer_expired');
      frames++;
    };
    let object = f.object;
    for (let round = 0; round < 12; round++) {
      f.advance(30_000);
      object = f.cold();
      await ready(object);
      await object.alarm();
      if (role === 'viewer') object.sendSnapshot(socket);
      await f.storage.drain();
      assert.equal(socket.readyState, 1, `connection closed after ${(round + 1) * 30}s`);
      const policy = await object.buildAgentPolicy(f.now, false);
      assert.equal(policy.mode, 'active');
      assert.equal(policy.viewer_count, 1);
      assert.equal(policy.report_interval_sec, 2);
    }
    assert.ok(frames >= 12, 'the same socket must continue receiving data');
    assert.ok(agent.frames.every(value => JSON.parse(value).mode === 'active'));
    assert.equal(await f.storage.state.storage.get('viewer:last_left_at'), undefined);
  });

  test(`${role} last departure keeps active for exactly 120s then pushes idle to Agents`, async () => {
    const f = fixture();
    await ready(f.object);
    const agent = monitoredSocket({ id: 'grace-agent', role: 'agent' });
    f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
    await upgrade(f.object, role, 'last-viewer');
    await f.storage.drain();
    // The holding period starts at departure, even after a long viewing session.
    f.advance(300_000);
    const socket = f.storage.sockets[0];
    socket.close();
    const leftAt = f.now;
    await f.object.webSocketClose(socket);
    assert.equal(f.alarmAt, leftAt + 120_000);
    assert.equal(JSON.parse(agent.frames.at(-1)).mode, 'active');
    assert.equal(JSON.parse(agent.frames.at(-1)).viewer_count, 0);
    f.advance(119_999);
    assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'active');
    f.advance(1);
    await f.object.alarm();
    await f.storage.drain();
    const idle = JSON.parse(agent.frames.at(-1));
    assert.equal(idle.mode, 'idle');
    assert.equal(idle.report_interval_sec, 120);
    assert.equal(f.alarmAt, null);
  });
}

test('refreshing and returning within the grace period never sends idle or closes a live viewer', async () => {
  const f = fixture();
  await ready(f.object);
  const agent = monitoredSocket({ id: 'refresh-agent', role: 'agent' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  await upgrade(f.object, 'monitor', 'before-refresh');
  await f.storage.drain();
  f.storage.sockets[0].close();
  const firstLeftAt = f.now;
  await f.object.webSocketClose(f.storage.sockets[0]);
  f.advance(119_000);
  assert.equal((await upgrade(f.object, 'viewer', 'after-refresh')).status, 101);
  await f.storage.drain();
  f.advance(300_000);
  await f.object.alarm();
  await f.storage.drain();
  assert.equal(f.storage.sockets[1].readyState, 1);
  assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'active');
  assert.ok(agent.frames.every(value => JSON.parse(value).mode === 'active'));
  f.storage.sockets[1].close();
  const secondLeftAt = f.now;
  await f.object.webSocketClose(f.storage.sockets[1]);
  assert.ok(secondLeftAt > firstLeftAt + 120_000);
  assert.equal(f.alarmAt, secondLeftAt + 120_000, 'a new grace period starts after the returning visitor leaves');
});

test('only the last of mixed Monitor/native viewers starts grace, and duplicate close/error cannot extend it', async () => {
  const f = fixture();
  await ready(f.object);
  await upgrade(f.object, 'monitor', 'monitor');
  await upgrade(f.object, 'viewer', 'native');
  await f.storage.drain();
  f.storage.sockets[0].close();
  await f.object.webSocketClose(f.storage.sockets[0]);
  assert.equal(await f.storage.state.storage.get('viewer:last_left_at'), undefined);
  f.advance(180_000);
  assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'active');
  f.storage.sockets[1].close();
  const leftAt = f.now;
  await f.object.webSocketError(f.storage.sockets[1]);
  assert.equal(f.alarmAt, leftAt + 120_000);
  f.advance(30_000);
  await f.object.webSocketClose(f.storage.sockets[1]);
  await f.object.webSocketError(f.storage.sockets[0]);
  assert.equal(await f.storage.state.storage.get('viewer:last_left_at'), leftAt);
  assert.equal(f.alarmAt, leftAt + 120_000);
});

test('grace survives hibernation and HTTP policy reads without extending its original deadline', async () => {
  const f = fixture({ dbOverrides: { getSettingsByKeys: async () => ({ live_poll_active_max_duration_sec: '600' }) } });
  await ready(f.object);
  await upgrade(f.object, 'monitor', 'hibernating-viewer');
  await f.storage.drain();
  f.storage.sockets[0].close();
  const leftAt = f.now;
  await f.object.webSocketClose(f.storage.sockets[0]);
  assert.equal(f.alarmAt, leftAt + 600_000);
  for (let i = 0; i < 3; i++) {
    f.advance(190_000);
    const restored = f.cold();
    const policy = await (await restored.fetch(new Request('https://do/policy'))).json();
    assert.equal(policy.mode, 'active');
    assert.equal(policy.viewer_count, 0);
    assert.equal(policy.viewer_ttl_sec, 600);
    assert.equal(f.alarmAt, leftAt + 600_000);
  }
  f.advance(30_000);
  const restored = f.cold();
  await restored.alarm();
  const policy = await (await restored.fetch(new Request('https://do/policy'))).json();
  assert.equal(policy.mode, 'idle');
  assert.equal(f.alarmAt, null);
});

test('a final close that wakes a cold DO starts grace even if the runtime no longer lists that socket', async () => {
  const f = fixture();
  await ready(f.object);
  await upgrade(f.object, 'monitor', 'cold-close');
  await f.storage.drain();
  f.storage.sockets[0].close();
  const restored = f.cold();
  await restored.webSocketClose(f.storage.sockets[0]);
  assert.equal((await restored.buildAgentPolicy(f.now, false)).mode, 'active');
  assert.equal(f.alarmAt, f.now + 120_000);
  f.advance(120_000);
  const again = f.cold();
  await again.webSocketError(f.storage.sockets[0]);
  assert.equal((await again.buildAgentPolicy(f.now, false)).mode, 'idle');
});

for (const withAgent of [false, true]) {
  test(`changing the holding time reschedules grace from the original departure (${withAgent ? 'WS' : 'HTTP'} Agents)`, async () => {
    let holdSec = 120;
    const f = fixture({ dbOverrides: { getSettingsByKeys: async () => ({ live_poll_active_max_duration_sec: String(holdSec) }) } });
    await ready(f.object);
    const agent = monitoredSocket({ id: 'settings-agent', role: 'agent' });
    if (withAgent) f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
    await upgrade(f.object, 'viewer', 'settings-viewer');
    await f.storage.drain();
    f.storage.sockets[0].close();
    const leftAt = f.now;
    await f.object.webSocketClose(f.storage.sockets[0]);
    f.advance(30_000);
    holdSec = 600;
    const refresh = () => f.object.fetch(new Request('https://do/policy-refresh', { method: 'POST' }));
    assert.equal((await refresh()).status, 200);
    assert.equal(f.alarmAt, leftAt + 600_000);
    f.advance(90_000);
    assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'active');
    holdSec = 180;
    await refresh();
    assert.equal(f.alarmAt, leftAt + 180_000);
    f.advance(60_000);
    await f.object.alarm();
    assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'idle');
    if (withAgent) assert.equal(JSON.parse(agent.frames.at(-1)).mode, 'idle');
    assert.equal(await f.storage.state.storage.get('viewer:last_left_at'), leftAt);
    assert.equal(f.alarmAt, null);
  });
}

test('shortening the holding time past its deadline immediately pushes idle', async () => {
  let holdSec = 600;
  const f = fixture({ dbOverrides: { getSettingsByKeys: async () => ({ live_poll_active_max_duration_sec: String(holdSec) }) } });
  await ready(f.object);
  const agent = monitoredSocket({ id: 'shorter-agent', role: 'agent' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  await upgrade(f.object, 'viewer', 'shorter-viewer');
  await f.storage.drain();
  f.storage.sockets[0].close();
  await f.object.webSocketClose(f.storage.sockets[0]);
  f.advance(180_000);
  holdSec = 120;
  await f.object.fetch(new Request('https://do/policy-refresh', { method: 'POST' }));
  assert.equal(JSON.parse(agent.frames.at(-1)).mode, 'idle');
  assert.equal(f.alarmAt, null);
});

test('policy preparation that crosses the grace deadline cannot send stale active mode', async () => {
  const f = fixture();
  await ready(f.object);
  await upgrade(f.object, 'viewer', 'slow-policy-viewer');
  await f.storage.drain();
  f.storage.sockets[0].close();
  await f.object.webSocketClose(f.storage.sockets[0]);
  f.advance(119_000);
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  f.object.getPingTasks = async () => {
    entered.resolve();
    return pending.promise;
  };
  const policy = f.object.buildAgentPolicy(f.now, false);
  await entered.promise;
  f.advance(1_000);
  pending.resolve([]);
  assert.equal((await policy).mode, 'idle');
});

test('Agent reports during grace do not renew the holding deadline', async () => {
  const f = fixture();
  await ready(f.object);
  const agent = monitoredSocket({ id: CLIENTS[0].uuid, role: 'agent' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  await upgrade(f.object, 'viewer', 'reporting-viewer');
  await f.storage.drain();
  f.storage.sockets[0].close();
  const leftAt = f.now;
  await f.object.webSocketClose(f.storage.sockets[0]);
  for (let round = 0; round < 4; round++) {
    f.advance(30_000);
    await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: round, timestamp: f.now } }));
    await f.storage.drain();
    const policies = agent.frames.map(value => JSON.parse(value)).filter(value => value.type === 'policy');
    assert.equal(policies.at(-1).mode, round < 3 ? 'active' : 'idle');
    assert.equal(await f.storage.state.storage.get('viewer:last_left_at'), leftAt);
    assert.equal(f.object.viewerHoldDeadline(), leftAt + 120_000);
  }
});

test('old viewer expiry attachments are removed during restoration without closing live connections', async () => {
  const f = fixture();
  for (const role of ['monitor', 'viewer']) {
    const socket = monitoredSocket({ id: `legacy-${role}`, role });
    socket.ws.serializeAttachment({ ...socket.ws.deserializeAttachment(), viewerExpiresAt: f.now - 1 });
    f.storage.state.acceptWebSocket(socket.ws);
  }
  const restored = f.cold();
  await ready(restored);
  for (const socket of f.storage.sockets) {
    assert.equal(socket.readyState, 1);
    assert.equal(socket.deserializeAttachment().viewerExpiresAt, undefined);
  }
  assert.equal(restored.activeViewerCount(), 2);
  assert.equal((await restored.buildAgentPolicy(f.now, false)).mode, 'active');
});

test('long-lived viewers retain their quota and closing them releases it during the grace period', async () => {
  const f = fixture();
  await ready(f.object);
  for (let i = 0; i < 8; i++) await upgrade(f.object, 'monitor', `persistent-${i}`);
  await f.storage.drain();
  assert.equal((await upgrade(f.object, 'monitor', 'blocked')).status, 429);
  f.advance(120_000);
  assert.equal(f.object.countViewers('1.1.1.1').sameIp, 8);
  assert.equal((await upgrade(f.object, 'monitor', 'still-blocked')).status, 429);
  const first = f.storage.sockets[0];
  let sends = 0;
  first.send = () => { sends++; };
  await f.object.sendMonitorFrame(first);
  assert.equal(sends, 1);
  first.close();
  await f.object.webSocketClose(first);
  const before = sends;
  await f.object.sendMonitorFrame(first);
  assert.equal(sends, before);
  assert.equal((await upgrade(f.object, 'monitor', 'replacement')).status, 101);
  await f.storage.drain();
});

test('Monitor and native viewer connections share the per-IP quota and rejected upgrades allocate no sockets', async () => {
  const f = fixture();
  await ready(f.object);
  for (let i = 0; i < 8; i++) {
    assert.equal((await upgrade(f.object, i % 2 ? 'monitor' : 'viewer', `mixed-${i}`)).status, 101);
  }
  for (const role of ['monitor', 'viewer']) {
    const rejected = await upgrade(f.object, role, `denied-${role}`);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('Cache-Control'), 'no-store');
    assert.equal(rejected.headers.get('Retry-After'), '60');
  }
  assert.equal(f.storage.sockets.length, 8);
  const closed = f.storage.sockets[0];
  closed.close();
  await f.object.webSocketClose(closed);
  assert.equal((await upgrade(f.object, 'monitor', 'replacement')).status, 101);
  const restored = f.cold();
  await ready(restored);
  assert.equal((await upgrade(restored, 'monitor', 'after-hibernation')).status, 429, 'hibernated attachments retain IP admission counts');
  await f.storage.drain();
});

test('Monitor and native viewers share the global quota without charging Agent sockets', async () => {
  const f = fixture();
  await ready(f.object);
  for (let i = 0; i < 127; i++) {
    const socket = createSocket({ role: i % 2 ? 'monitor' : 'viewer', clientId: `global-${i}`, viewerIp: `ip-${i}`, viewerExpiresAt: f.now + 120000 });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  }
  const agent = createSocket({ role: 'agent', clientId: 'agent' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  assert.equal((await upgrade(f.object, 'monitor', 'last-slot', 'new-ip')).status, 101);
  assert.equal((await upgrade(f.object, 'viewer', 'over-capacity', 'another-ip')).status, 429);
  assert.equal((await upgrade(f.object, 'monitor', 'over-capacity-2', 'third-ip')).status, 429);
  await f.storage.drain();
});

test('concurrent viewer upgrades recheck capacity after an asynchronous settings read', async () => {
  const f = fixture();
  await ready(f.object);
  const release = Promise.withResolvers();
  f.object.getAgentPolicySettings = () => release.promise;
  const upgrades = Array.from({ length: 12 }, (_, i) => upgrade(f.object, 'viewer', `race-${i}`));
  // All twelve have reached the same pending settings read before admission.
  await Promise.resolve();
  release.resolve({});
  const results = await Promise.all(upgrades);
  assert.equal(results.filter(result => result.status === 101).length, 8);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.equal(f.storage.sockets.length, 8);
  await f.storage.drain();
});

test('Monitor cold-start read failure rejects the upgrade without accepting a socket and can recover', async () => {
  let failed = true;
  const f = fixture({ dbOverrides: { listClients: async () => {
    if (failed) throw new Error('backend unavailable');
    return CLIENTS;
  } } });
  await f.object.httpClientsReady;
  const response = await upgrade(f.object, 'monitor', 'failed-start');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.storage.sockets.length, 0);
  failed = false;
  f.advance(5001);
  assert.equal((await upgrade(f.object, 'monitor', 'recovered')).status, 101);
  await f.storage.drain();
});

test('Monitor totals refresh failure retains the last successful values instead of resetting them to zero', async () => {
  let failed = false;
  const f = fixture({ dbOverrides: { getTrafficTotals: async () => {
    if (failed) throw new Error('backend unavailable');
    return TOTALS;
  } } });
  await ready(f.object);
  const before = JSON.parse(f.object.buildMonitorFrameText(f.now, false));
  failed = true;
  f.advance(61000);
  await f.object.readyMonitorData();
  const after = JSON.parse(f.object.buildMonitorFrameText(f.now, false));
  assert.deepEqual(after.nodes.map(node => [node.id, node.total_rx, node.day_rx]), before.nodes.map(node => [node.id, node.total_rx, node.day_rx]));
  assert.ok(after.nodes.some(node => node.total_rx > 0));
});

function seedLive(object, now) {
  object.clients.set('node-1', {
    uuid: 'node-1',
    name: '东京',
    hidden: false,
    lastReportTime: now - 3000,
    lastReport: {
      cpu: 12.5, load: 0.5, load5: 0.4, load15: 0.3,
      ram: GIB, ram_total: 3 * GIB, swap: 0, swap_total: 0,
      disk: 2 * GIB, disk_total: 42 * GIB,
      net_in: 111, net_out: 222,
      net_total_up: 5 * GIB, net_total_down: 9 * GIB,
      connections: 30, connections_udp: 6, process_count: 120,
      uptime: 3600, timestamp: now - 5000,
    },
  });
  object.lastKnownClients.set('node-2', {
    uuid: 'node-2',
    name: '离线节点',
    hidden: false,
    lastReportTime: now - 5 * 3600 * 1000,
    lastReport: {
      cpu: 0, net_total_up: GIB, net_total_down: 2 * GIB,
      timestamp: now - 5 * 3600 * 1000,
    },
  });
  // 隐藏节点也有实时上报：访客帧的静态投影会过滤它，管理员帧会带上它。
  object.clients.set('node-hidden', {
    uuid: 'node-hidden',
    name: '隐藏节点',
    hidden: true,
    lastReportTime: now - 1000,
    lastReport: { cpu: 1, net_total_up: 1, net_total_down: 1, timestamp: now - 1000 },
  });
}

test('静态投影由 admin 快照派生：冷启动即可出帧，无需 Worker 推送', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);

  const socket = monitoredSocket({ admin: true });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  assert.equal(socket.frames.length, 1);
  const frame = frameJson(socket.frames[0]);
  assert.equal(frame.admin, true);
  // 管理员连接的帧包含隐藏节点（排在最后：sort 3）；访客帧见下方专门的用例。
  assert.deepEqual(
    frame.nodes.map(node => node.id),
    [f.monitorNumericId('node-1'), f.monitorNumericId('node-2'), f.monitorNumericId('node-hidden')],
  );

  const online = frame.nodes[0];
  assert.equal(online.day_rx, 100);
  assert.equal(online.day_tx, 50);
  assert.equal(online.total_rx, 1e12);
  assert.equal(online.total_tx, 5e11);
});

test('admin 元数据更新后，已连接的 monitor 无需 Worker 推送即可收到新投影', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();
  assert.equal(frameJson(socket.frames[0]).nodes.length, 2);

  // 与后台的两步一致：先写快照，再发 metadata-refresh 通知变更。
  await f.object.fetch(new Request('https://do/admin-clients-snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clients: [CLIENTS[0]], expected_version: 1 }),
  }));
  f.advance(3000);
  await f.object.fetch(new Request('https://do/metadata-refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }));
  await f.storage.drain();

  const latest = frameJson(socket.frames.at(-1));
  assert.deepEqual(latest.nodes.map(node => node.id), [f.monitorNumericId('node-1')]);
});

test('admin 快照缺失时回退数据库 listClients 派生投影', async () => {
  const f = fixture();
  await ready(f.object);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  const frame = frameJson(socket.frames[0]);
  // 依旧过滤隐藏节点。
  assert.deepEqual(frame.nodes.map(node => node.id), [f.monitorNumericId('node-1'), f.monitorNumericId('node-2')]);
});

test('兜底 listClients 的行也要过 sanitize：元数据 map 里只有清洗过的数据', async () => {
  // admin 快照缺失时 refreshMonitorData 直接从数据库拉原始行；这些行必须与
  // writeAdminClientsSnapshot 写入的行同形（去 token / token_hash、内网 IP 清零）。
  // fixture 的 listClients 参数约定是「原始行数组」。
  const f = fixture({
    listClients: [
      { ...CLIENTS[0], token: 'fallback-token', token_hash: 'sha256:fallback', ipv4: '10.0.0.7' },
      { uuid: '   ', name: 'no-uuid', hidden: false },
    ],
  });
  await ready(f.object);

  const metadata = [...f.object.adminClientMetadata.values()];
  assert.equal(metadata.length, 1, '无 uuid 的行不能进元数据 map');
  const serialized = JSON.stringify(metadata);
  assert.ok(!serialized.includes('fallback-token'), 'token 必须被去掉');
  assert.ok(!serialized.includes('sha256:fallback'), 'token_hash 必须被去掉');
  assert.ok(!serialized.includes('10.0.0.7'), '内网 IP 必须被清理');
  assert.equal(metadata[0].uuid, 'node-1');
  assert.equal(metadata[0].has_ipv4, false, '内网 IP 清零后 has_ipv4 必须是 false');
});

test('admin 是每连接属性，不随共享投影广播', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);

  const admin = monitoredSocket({ id: 'm-admin', admin: true });
  const guest = monitoredSocket({ id: 'm-guest', admin: false });
  f.object.registerSession(admin.ws, admin.ws.deserializeAttachment());
  f.object.registerSession(guest.ws, guest.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  const adminFrame = frameJson(admin.frames[0]);
  const guestFrame = frameJson(guest.frames[0]);
  assert.equal(adminFrame.admin, true);
  assert.equal(guestFrame.admin, false);

  // 访客帧绝不含隐藏节点；管理员帧在此之上只多出隐藏节点，其余节点逐字段一致。
  const hiddenId = f.monitorNumericId('node-hidden');
  assert.equal(guestFrame.nodes.some(node => node.id === hiddenId), false);
  assert.deepEqual(adminFrame.nodes.filter(node => node.id !== hiddenId), guestFrame.nodes);
  assert.equal(adminFrame.nodes.filter(node => node.id === hiddenId).length, 1);
});

test('管理员帧里的隐藏节点：public=false、字段集与普通节点一致、带实时数据且不泄露私有字段', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const admin = monitoredSocket({ id: 'm-admin', admin: true });
  const guest = monitoredSocket({ id: 'm-guest', admin: false });
  f.object.registerSession(admin.ws, admin.ws.deserializeAttachment());
  f.object.registerSession(guest.ws, guest.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  const hiddenId = f.monitorNumericId('node-hidden');
  const adminFrame = frameJson(admin.frames[0]);
  const hidden = adminFrame.nodes.find(node => node.id === hiddenId);
  assert.ok(hidden, '管理员应看到隐藏节点');
  assert.equal(hidden.public, false);
  assert.equal(hidden.name, '隐藏节点');
  assert.deepEqual(Object.keys(hidden).sort(), [...NODE_KEYS].sort(), '字段集必须与普通节点完全一致');
  // 隐藏节点在线：管理员帧必须带上它的实时数据，而不是离线、全零。
  assert.equal(hidden.online, true);
  assert.ok(hidden.metrics);
  assert.equal(hidden.metrics.cpu, 1, '应是隐藏节点自己的上报值');

  // 访客帧的原文里连节点名都不能出现。
  const guestText = JSON.stringify(frameJson(guest.frames[0]));
  assert.equal(guestText.includes('隐藏节点'), false);
  assert.equal(guestText.includes(String(hiddenId)), false);
  assert.equal(frameJson(guest.frames[0]).nodes.length, 2);
});

test('/api/ws 帧：{admin, nodes} 全量快照，静态字段 + 实时合并', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const socket = monitoredSocket({ admin: true });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  assert.equal(socket.frames.length, 1);
  const frame = frameJson(socket.frames[0]);
  assert.equal(frame.admin, true);
  assert.equal(frame.nodes.length, 3, '管理员帧含隐藏节点');

  for (const node of frame.nodes) {
    assert.deepEqual(Object.keys(node).sort(), [...NODE_KEYS].sort());
  }

  const online = frame.nodes.find(node => node.id === f.monitorNumericId('node-1'));
  assert.equal(online.online, true);
  assert.equal(online.name, '东京');
  assert.equal(online.sort, 1);
  assert.equal(online.public, true);
  assert.equal(online.country, 'JP');
  assert.equal(online.billing_cycle, 'monthly');
  assert.equal(online.traffic_limit, 1024 * GIB);
  assert.equal(online.month_rx, 9 * GIB);
  assert.equal(online.month_tx, 5 * GIB);
  assert.equal(online.month_used, 14 * GIB);
  assert.equal(online.last_seen_ago, 3);
  assert.equal(online.last_seen, Math.floor((f.now - 3000) / 1000));
  assert.equal(online.month_start, `${new Date(f.now).toISOString().slice(0, 8)}01`);
  {
    const now = new Date(f.now);
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    assert.equal(
      online.expires_in,
      Math.round((Date.parse('2030-01-11') - todayMs) / 86_400_000),
      'expires_in 按日历天计算',
    );
  }
  assert.ok(online.metrics);
  assert.deepEqual(Object.keys(online.metrics).sort(), [...METRICS_KEYS].sort());
  assert.equal(online.metrics.cpu, 12.5);
  assert.equal(online.metrics.net_rx, 111);
  assert.equal(online.metrics.tcp, 30);
  // 顶层的三个容量与实时 metrics 完全一致（ws 帧走同一个共享投影函数）。
  assert.equal(online.mem_total, 3 * GIB);
  assert.equal(online.swap_total, 0);
  assert.equal(online.disk_total, 42 * GIB);
  assert.equal(online.metrics.mem_total, online.mem_total);
  assert.equal(online.metrics.swap_total, online.swap_total);
  assert.equal(online.metrics.disk_total, online.disk_total);

  const offline = frame.nodes.find(node => node.id === f.monitorNumericId('node-2'));
  assert.equal(offline.online, false);
  assert.equal(offline.metrics, null);
  assert.equal(offline.billing_cycle, 'yearly');
  assert.equal(offline.last_seen_ago, 5 * 3600);
  assert.equal(offline.month_rx, 2 * GIB);
  assert.equal(offline.expires_at, null);
  assert.equal(offline.expires_in, null);
});

test('?gzip 发 gzip 二进制帧，解压后与明文帧一致', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const plain = monitoredSocket({ id: 'm-plain' });
  const zipped = monitoredSocket({ id: 'm-gzip', gzip: true });
  f.object.registerSession(plain.ws, plain.ws.deserializeAttachment());
  f.object.registerSession(zipped.ws, zipped.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  assert.equal(typeof plain.frames[0], 'string');
  assert.ok(plain.frames[0].startsWith('{"admin"'));
  assert.ok(zipped.frames[0] instanceof ArrayBuffer || ArrayBuffer.isView(zipped.frames[0]));

  const plainFrame = frameJson(plain.frames[0]);
  const gzipFrame = frameJson(zipped.frames[0]);
  assert.equal(gzipFrame.admin, false);
  assert.deepEqual(gzipFrame, plainFrame);
});

test('帧节流：2s 内只发一帧，超过间隔才补发', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());

  f.object.broadcastMonitorFrame(false);   // 第一帧
  await f.storage.drain();
  assert.equal(socket.frames.length, 1);

  f.advance(1000);
  f.object.broadcastMonitorFrame(false);   // 被节流
  await f.storage.drain();
  assert.equal(socket.frames.length, 1);

  f.advance(1500);                         // 累计 2.5s
  f.object.broadcastMonitorFrame(false);
  await f.storage.drain();
  assert.equal(socket.frames.length, 2);

  // force 无视节流（建连/元数据变更时需要立刻全量）
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();
  assert.equal(socket.frames.length, 3);
});

for (const cold of [false, true]) test(`throttled Monitor update flushes without another report${cold ? ' after hibernation' : ''}`, async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);
  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.storage.state.acceptWebSocket(socket.ws);
  const alarms = [];
  f.storage.state.storage.setAlarm = async at => alarms.push(at);
  f.object.broadcastMonitorFrame(true); // Heartbeat/metadata frame starts a throttle window.
  await f.storage.drain();
  f.advance(100);
  f.object.clients.get('node-1').lastReport.cpu = 71;
  f.object.broadcastMonitorFrame();
  await f.storage.drain();
  const deadline = f.now + 1900;
  assert.equal(alarms.at(-1), deadline);
  assert.equal(socket.frames.length, 1);
  f.advance(500);
  f.object.clients.get('node-1').lastReport.cpu = 83;
  f.object.broadcastMonitorFrame();
  await f.storage.drain();
  assert.equal(await f.storage.state.storage.get('monitor:frame_pending_at'), deadline, 'new reports do not slide the trailing deadline');
  // Preserve the latest report the same way accepted Agent sockets do on hibernation.
  const client = f.object.clients.get('node-1');
  if (cold) {
    const agent = createSocket({ role: 'agent', clientId: 'node-1', clientName: client.name, hidden: false,
      lastReport: client.lastReport, lastReportTime: client.lastReportTime });
    f.storage.state.acceptWebSocket(agent.ws);
  }
  f.advance(1400);
  const object = cold ? f.cold() : f.object;
  await object.alarm();
  await f.storage.drain();
  assert.equal(socket.frames.length, 2, 'the alarm sends the buffered update with no new report');
  assert.equal(frameJson(socket.frames.at(-1)).nodes.find(n => n.name === '东京').metrics.cpu, 83);
  assert.equal(await f.storage.state.storage.get('monitor:frame_pending_at'), undefined);
});

test('closing the last Monitor removes the pending trailing update', async () => {
  const f = fixture();
  await ready(f.object);
  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  f.advance(100);
  f.object.broadcastMonitorFrame();
  await f.storage.drain();
  assert.ok(await f.storage.state.storage.get('monitor:frame_pending_at'));
  await f.object.webSocketClose(socket.ws);
  await f.storage.drain();
  assert.equal(await f.storage.state.storage.get('monitor:frame_pending_at'), undefined);
});

test('an intervening forced frame consumes the pending update without a duplicate trailing frame', async () => {
  const f = fixture();
  await ready(f.object);
  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.storage.state.acceptWebSocket(socket.ws);
  f.object.broadcastMonitorFrame(true);
  f.advance(100);
  f.object.broadcastMonitorFrame();
  await f.storage.drain();
  f.advance(100);
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();
  assert.equal(socket.frames.length, 2);
  assert.equal(await f.storage.state.storage.get('monitor:frame_pending_at'), undefined);
  f.advance(1800);
  await f.object.alarm();
  await f.storage.drain();
  assert.equal(socket.frames.length, 2, 'a stale wake cannot resend the already consumed update');
});

test('staggered 3s reports survive the 15s heartbeat without skipping projected samples', async () => {
  const f = fixture();
  await ready(f.object);
  seedLive(f.object, f.now);
  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.storage.state.acceptWebSocket(socket.ws);
  let alarmAt = Infinity;
  f.storage.state.storage.setAlarm = async at => { alarmAt = at; };
  f.storage.state.storage.deleteAlarm = async () => { alarmAt = Infinity; };
  f.object.broadcastMonitorFrame(true);
  await f.object.scheduleExpiryAlarm(f.now);
  await f.storage.drain();
  const base = f.now;
  const expected = [];
  for (let elapsed = 100; elapsed <= 32_000; elapsed += 100) {
    f.advance(100);
    // Process a due heartbeat before the next slightly staggered Agent report.
    if (alarmAt <= f.now) {
      await f.object.alarm();
      await f.storage.drain();
    }
    if (elapsed % 3000 === 100) {
      const sample = 100 + Math.floor(elapsed / 3000);
      expected.push(sample);
      f.object.clients.get('node-1').lastReport.cpu = sample;
      f.object.broadcastMonitorFrame();
      await f.storage.drain();
    }
    if (elapsed % 3000 === 1200) {
      // Another node can trigger a shared frame inside the first node's window.
      f.object.broadcastMonitorFrame();
      await f.storage.drain();
    }
  }
  const projected = socket.frames.map(frame => frameJson(frame).nodes.find(n => n.name === '东京').metrics.cpu);
  for (const sample of expected) assert.ok(projected.includes(sample), `sample ${sample} omitted after ${f.now - base}ms`);
});

test('空闲期间定时推送快照，避免 Monitor WebSocket 被客户端判超时', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const socket = monitoredSocket({ id: 'm-heartbeat' });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.storage.state.acceptWebSocket(socket.ws);
  await f.object.scheduleExpiryAlarm(f.now);
  const dueAt = await f.storage.state.storage.get('monitor:ws_heartbeat_at');
  assert.equal(dueAt, f.now + 15_000);

  // Agent reports may recalculate the shared expiry alarm, but must not slide
  // the persisted monitor heartbeat deadline.
  f.advance(5_000);
  await f.object.scheduleExpiryAlarm(f.now);
  assert.equal(await f.storage.state.storage.get('monitor:ws_heartbeat_at'), dueAt);

  f.advance(10_000);
  const resumed = f.cold();
  await resumed.alarm();
  await f.storage.drain();
  assert.equal(socket.frames.length, 1);
  assert.equal(frameJson(socket.frames[0]).nodes.length, 2);
  assert.equal(
    await f.storage.state.storage.get('monitor:ws_heartbeat_at'),
    f.now + 15_000,
    'next heartbeat remains scheduled after a hibernation wake',
  );

  await resumed.webSocketClose(socket.ws);
  assert.equal(await f.storage.state.storage.get('monitor:ws_heartbeat_at'), undefined);
});

test('Monitor 订阅者计入活跃观看人数，最后离开后等待保持时长才恢复闲置采样', async () => {
  const f = fixture();
  const socket = monitoredSocket({ id: 'm-policy' });

  assert.equal(f.object.activeViewerCount(f.now), 0);
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  assert.equal(f.object.activeViewerCount(f.now), 1);

  const activePolicy = await f.object.buildAgentPolicy(f.now, true, false, 'node-1');
  assert.equal(activePolicy.mode, 'active');
  assert.equal(activePolicy.sample_interval_sec, 3);

  await f.object.webSocketClose(socket.ws);
  assert.equal(f.object.activeViewerCount(f.now), 0);
  assert.equal((await f.object.buildAgentPolicy(f.now, false)).mode, 'active');
  f.advance(120_000);
  const idlePolicy = await f.object.buildAgentPolicy(f.now, false, false, 'node-1');
  assert.equal(idlePolicy.mode, 'idle');
  assert.equal(idlePolicy.sample_interval_sec, 120);
});

test('Agent active 策略支持 2 秒采样和上报', async () => {
  const f = fixture({ dbOverrides: { getSettingsByKeys: async () => ({ live_poll_active_interval_sec: '2' }) } });
  const socket = monitoredSocket({ id: 'm-policy-2s' });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());

  const policy = await f.object.buildAgentPolicy(f.now, false, true, 'node-1');
  assert.equal(policy.mode, 'active');
  assert.equal(policy.sample_interval_sec, 2);
  assert.equal(policy.report_interval_sec, 2);
});

test('首个 Monitor 建连时向 Agent 推送 active，最后断开后的宽限期结束再推送 idle', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await f.object.httpClientsReady;
  const agent = monitoredSocket({ id: 'agent-policy', role: 'agent' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());

  const response = await f.object.fetch(new Request('https://do/?id=monitor-connection&role=monitor', {
    headers: { Upgrade: 'websocket' },
  }));
  assert.equal(response.status, 101);
  await f.storage.drain();
  assert.equal(
    agent.frames.some(frame => {
      const policy = JSON.parse(frame);
      return policy.type === 'policy' && policy.mode === 'active' && policy.report_now === true;
    }),
    true,
    'first Monitor viewer immediately activates fast samples',
  );

  // The runtime has already marked the socket closed when the close callback runs.
  f.storage.sockets[0].readyState = 3;
  await f.object.webSocketClose(f.storage.sockets[0]);
  assert.equal(JSON.parse(agent.frames.at(-1)).mode, 'active');
  f.advance(120_000);
  await f.object.alarm();
  await f.storage.drain();
  assert.equal(
    JSON.parse(agent.frames.at(-1)).mode,
    'idle',
    'grace expiry after the last Monitor viewer leaves restores idle sampling',
  );
});

test('没有 monitor 订阅者时不产生帧，也不查库刷新 totals', async () => {
  let totalsCalls = 0;
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await f.object.httpClientsReady;
  const original = f.object.refreshMonitorData.bind(f.object);
  f.object.refreshMonitorData = async (now) => { totalsCalls += 1; return original(now); };

  const viewer = monitoredSocket({ id: 'v1' });
  viewer.ws.deserializeAttachment = () => ({ role: 'viewer', clientId: 'v1', clientName: 'v1', hidden: false });
  f.object.registerSession(viewer.ws, viewer.ws.deserializeAttachment());

  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();
  assert.equal(viewer.frames.length, 0);
  assert.equal(totalsCalls, 0, '没有 monitor 订阅者时不该触发 totals 刷新');
});

test('隐藏节点不出现在 monitor 帧里（即使有实时上报）', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);
  seedLive(f.object, f.now);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  const frame = frameJson(socket.frames[0]);
  assert.deepEqual(frame.nodes.map(node => node.id), [f.monitorNumericId('node-1'), f.monitorNumericId('node-2')]);
});

test('同一轮广播按管理/公开分组只序列化和压缩一次', async () => {
  let gzipCalls = 0;
  const f = fixture({
    storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]],
    overrides: {
      fflate: {
        gzipSync: (...args) => {
          gzipCalls += 1;
          return gzipSync(...args);
        },
        strToU8,
      },
    },
  });
  await ready(f.object);
  seedLive(f.object, f.now);

  const publicGzipA = monitoredSocket({ id: 'm-public-gzip-a', gzip: true });
  const publicGzipB = monitoredSocket({ id: 'm-public-gzip-b', gzip: true });
  const publicPlain = monitoredSocket({ id: 'm-public-plain' });
  const adminGzipA = monitoredSocket({ id: 'm-admin-gzip-a', gzip: true, admin: true });
  const adminGzipB = monitoredSocket({ id: 'm-admin-gzip-b', gzip: true, admin: true });
  for (const socket of [publicGzipA, publicGzipB, publicPlain, adminGzipA, adminGzipB]) {
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  }

  const originalBuild = f.object.buildMonitorFrameText.bind(f.object);
  let serializations = 0;
  f.object.buildMonitorFrameText = (...args) => {
    serializations += 1;
    return originalBuild(...args);
  };

  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  assert.equal(serializations, 2, '公开帧与管理员帧各序列化一次');
  assert.equal(gzipCalls, 2, '公开 gzip 与管理员 gzip 各压缩一次，而不是每个连接一次');
  assert.equal(publicGzipA.frames[0], publicGzipB.frames[0], '公开 gzip 连接复用同一个压缩结果');
  assert.equal(adminGzipA.frames[0], adminGzipB.frames[0], '管理员 gzip 连接复用同一个压缩结果');
  assert.notEqual(publicGzipA.frames[0], adminGzipA.frames[0], '管理员帧不能复用公开帧的压缩结果');

  const publicFrame = frameJson(publicPlain.frames[0]);
  const adminFrame = frameJson(adminGzipA.frames[0]);
  assert.equal(publicFrame.admin, false);
  assert.equal(adminFrame.admin, true);
  assert.equal(
    publicFrame.nodes.some(node => node.id === f.monitorNumericId('node-hidden')),
    false,
    '公开帧仍然不能包含隐藏节点',
  );
  assert.equal(
    adminFrame.nodes.some(node => node.id === f.monitorNumericId('node-hidden')),
    true,
    '管理员帧仍然包含隐藏节点',
  );
});

console.log('live-data monitor ws tests passed');
