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

const STATIC_NODES = [
  {
    id: 101, uuid: 'node-1', name: '东京', sort: 1, public: true, country: 'JP', group: '亚洲',
    public_remark: '直连', os: 'Debian', kernel: '6.12.0', arch: 'x86_64', virt: 'kvm',
    cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2 * GIB, swap_total: GIB, disk_total: 40 * GIB,
    agent_version: '1.2.0', billing_cycle: 'monthly', currency: 'CNY', price: 29.9,
    expires_at: '2030-01-11', traffic_limit: 1024 * GIB, traffic_mode: 'sum',
    traffic_reset_day: 1, day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0,
  },
  {
    id: 202, uuid: 'node-2', name: '离线节点', sort: 2, public: true, country: 'US', group: '',
    public_remark: '', os: 'Debian', kernel: '6.1', arch: 'x86_64', virt: 'kvm',
    cpu_name: 'Xeon', cpu_cores: 1, mem_total: GIB, swap_total: 0, disk_total: 20 * GIB,
    agent_version: '1.0.0', billing_cycle: 'yearly', currency: 'USD', price: 5,
    expires_at: null, traffic_limit: 0, traffic_mode: 'sum',
    traffic_reset_day: 1, day_rx: 0, day_tx: 0, total_rx: 0, total_tx: 0,
  },
];

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

function fixture({ storageEntries = [] } = {}) {
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
  const object = new LiveDataDO(storage.state, {});
  return {
    object, storage,
    get now() { return now; },
    advance(ms) { now += ms; },
    cold: () => new LiveDataDO(storage.state, {}),
  };
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
}

async function pushMeta(object, body) {
  return object.fetch(new Request('https://do/monitor-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('monitor-meta 校验：缺 nodes 或非法 JSON 回 400', async () => {
  const f = fixture();
  const missing = await pushMeta(f.object, { admin: true });
  assert.equal(missing.status, 400);
  const bad = await f.object.fetch(new Request('https://do/monitor-meta', {
    method: 'POST',
    body: '{not json',
  }));
  assert.equal(bad.status, 400);
});

test('monitor-meta 丢弃 id 不是整数的节点（契约要求数字 id）', async () => {
  const f = fixture();
  const response = await pushMeta(f.object, {
    admin: false,
    nodes: [
      ...STATIC_NODES,
      { ...STATIC_NODES[0], id: 'node-1' },
      { ...STATIC_NODES[0], id: 3.5 },
      { ...STATIC_NODES[0], id: 303, uuid: '' },
    ],
  });
  assert.equal(response.status, 204);
  await f.storage.drain();
  const stored = await f.storage.state.storage.get('monitor:meta');
  assert.deepEqual(stored.map(node => node.id), [101, 202]);
});

test('monitor-meta 落库并可被冷启动读回', async () => {
  const f = fixture();
  const response = await pushMeta(f.object, { nodes: STATIC_NODES });
  assert.equal(response.status, 204);
  await f.storage.drain();
  const stored = await f.storage.state.storage.get('monitor:meta');
  assert.equal(Array.isArray(stored), true);
  assert.equal(stored.length, 2);

  const cold = f.cold();
  const socket = monitoredSocket({ admin: true });
  cold.registerSession(socket.ws, socket.ws.deserializeAttachment());
  await cold.ensureMonitorMeta();
  await cold.sendMonitorFrame(socket.ws);
  const frame = frameJson(socket.frames[0]);
  assert.equal(frame.nodes.length, 2);
  assert.equal(frame.admin, true);
});

test('兼容旧版 {admin, nodes} 持久化形态', async () => {
  const f = fixture({
    storageEntries: [['monitor:meta', { admin: true, nodes: STATIC_NODES }]],
  });
  const cold = f.cold();
  const socket = monitoredSocket({ admin: false });
  cold.registerSession(socket.ws, socket.ws.deserializeAttachment());
  await cold.ensureMonitorMeta();
  await cold.sendMonitorFrame(socket.ws);
  const frame = frameJson(socket.frames[0]);
  assert.equal(frame.nodes.length, 2);
  // 旧缓存里的 admin 不再生效：身份只看连接。
  assert.equal(frame.admin, false);
});

test('admin 是每连接属性，不随共享 meta 广播', async () => {
  const f = fixture();
  await pushMeta(f.object, { nodes: STATIC_NODES });

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
  const f = fixture();
  await pushMeta(f.object, { nodes: STATIC_NODES });
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

  const online = frame.nodes.find(node => node.id === 101);
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

  const offline = frame.nodes.find(node => node.id === 202);
  assert.equal(offline.online, false);
  assert.equal(offline.metrics, null);
  assert.equal(offline.billing_cycle, 'yearly');
  assert.equal(offline.last_seen_ago, 5 * 3600);
  assert.equal(offline.month_rx, 2 * GIB);
  assert.equal(offline.expires_at, null);
  assert.equal(offline.expires_in, null);
});

test('?gzip 发 gzip 二进制帧，解压后与明文帧一致', async () => {
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: STATIC_NODES });
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
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: STATIC_NODES });
  seedLive(f.object, f.now);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());

  // pushMeta 自己会 force 一帧（此刻还没有订阅者）。推进时钟，避开那次设置的节流窗口。
  f.advance(3000);

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
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: STATIC_NODES });
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
  assert.equal(frameJson(socket.frames[0]).nodes.length, STATIC_NODES.length);
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
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: STATIC_NODES });
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

test('没有 monitor 订阅者时不产生帧，也不影响其它角色', async () => {
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: STATIC_NODES });

  const viewer = monitoredSocket({ id: 'v1' });
  viewer.ws.deserializeAttachment = () => ({ role: 'viewer', clientId: 'v1', clientName: 'v1', hidden: false });
  f.object.registerSession(viewer.ws, viewer.ws.deserializeAttachment());

  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();
  assert.equal(viewer.frames.length, 0);
});

test('monitor 帧不含隐藏节点的实时明细（只出静态列表里的节点）', async () => {
  const f = fixture();
  await pushMeta(f.object, { admin: false, nodes: [STATIC_NODES[0]] });
  seedLive(f.object, f.now);

  const socket = monitoredSocket();
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.object.broadcastMonitorFrame(true);
  await f.storage.drain();

  const frame = frameJson(socket.frames[0]);
  assert.deepEqual(frame.nodes.map(node => node.id), [101]);
});

console.log('live-data monitor ws tests passed');
