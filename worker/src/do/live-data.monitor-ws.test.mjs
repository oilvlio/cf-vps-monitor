import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, strFromU8 } from 'fflate';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

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
    // 隐藏节点：留在 admin 元数据里，但绝不能进 monitor 帧。
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
  let attachment = { role, clientId: id, clientName: id, hidden: false, gzip, admin };
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

function fixture({ storageEntries = [], listClients } = {}) {
  let now = Date.parse('2027-01-15T00:00:00.000Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const storage = createDurableState(storageEntries, []);
  storage.state.getWebSockets = () => storage.sockets.filter(socket => socket.readyState === 1);
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
  const object = new LiveDataDO(storage.state, {});
  return {
    object, storage, monitorNumericId,
    get now() { return now; },
    advance(ms) { now += ms; },
    cold: () => new LiveDataDO(storage.state, {}),
  };
}

/** 等 DO 的冷启动元数据与 monitor 静态投影就绪（替代旧的 /monitor-meta 推送）。 */
async function ready(object) {
  await object.httpClientsReady;
  await object.readyMonitorData();
}

function seedLive(object, now) {
  object.clients.set('node-1', {
    uuid: 'node-1',
    name: '东京',
    hidden: false,
    lastReportTime: now - 3000,
    lastReport: {
      cpu: 12.5, load: 0.5, load5: 0.4, load15: 0.3,
      ram: GIB, ram_total: 2 * GIB, swap: 0, swap_total: GIB,
      disk: 2 * GIB, disk_total: 40 * GIB,
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
  // 隐藏节点也有实时上报，但静态投影会把它过滤掉。
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
  assert.deepEqual(frame.nodes.map(node => node.id), [f.monitorNumericId('node-1'), f.monitorNumericId('node-2')]);

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

test('admin 是每连接属性，不随共享投影广播', async () => {
  const f = fixture({ storageEntries: [['admin-clients:snapshot', ADMIN_SNAPSHOT]] });
  await ready(f.object);

  const admin = monitoredSocket({ id: 'm-admin', admin: true });
  const guest = monitoredSocket({ id: 'm-guest', admin: false });
  f.object.registerSession(admin.ws, admin.ws.deserializeAttachment());
  f.object.registerSession(guest.ws, guest.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  assert.equal(frameJson(admin.frames[0]).admin, true);
  assert.equal(frameJson(guest.frames[0]).admin, false);
  assert.deepEqual(frameJson(admin.frames[0]).nodes, frameJson(guest.frames[0]).nodes);
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
  assert.equal(frame.nodes.length, 2);

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
  assert.equal(online.last_seen_ago, 0);
  assert.equal(online.last_seen, Math.floor((f.now - 3000) / 1000));
  assert.equal(online.month_start, `${new Date(f.now).toISOString().slice(0, 8)}01`);
  assert.equal(
    online.expires_in,
    Math.ceil((Date.parse('2030-01-11') - f.now) / 86_400_000),
  );
  assert.ok(online.metrics);
  assert.deepEqual(Object.keys(online.metrics).sort(), [...METRICS_KEYS].sort());
  assert.equal(online.metrics.cpu, 12.5);
  assert.equal(online.metrics.net_rx, 111);
  assert.equal(online.metrics.tcp, 30);

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

test('Monitor 订阅者计入活跃观看人数，驱动 Agent 快速采样并在最后离开后恢复闲置采样', async () => {
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
  const idlePolicy = await f.object.buildAgentPolicy(f.now, false, false, 'node-1');
  assert.equal(idlePolicy.mode, 'idle');
  assert.equal(idlePolicy.sample_interval_sec, 120);
});

test('首个 Monitor WebSocket 建连时向 Agent 推送 active 策略，最后断开后推送 idle 策略', async () => {
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
  assert.equal(
    JSON.parse(agent.frames.at(-1)).mode,
    'idle',
    'closing the last Monitor viewer restores idle sampling',
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

console.log('live-data monitor ws tests passed');
