import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

// 固定时钟：1_800_000_000_000 ms = 2027-01-15T08:00:00Z。
const NOW = 1_800_000_000_000;

function fixture({ resetDay, totals, applyImpl, importImpl } = {}) {
  const node = { uuid: 'node', name: 'Managed node', hidden: false, sort_order: 1, ...(resetDay ? { traffic_reset_day: resetDay } : {}) };
  const calls = { apply: [], import: [], order: [] };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const storage = createDurableState([['admin-clients:snapshot', { clients: [node], complete: true, updatedAt: NOW - 1, removed: [] }]], []);
  storage.state.getWebSockets = () => storage.sockets.filter(socket => socket.readyState === 1);
  const loader = createWorkerLoader({ globals: { Date: Clock }, db: {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    listPublicClientRows: async () => [structuredClone(node)],
    getSetting: async () => null, setSetting: async () => {}, updateClient: async () => {},
    listPingTasks: async () => [], insertAuditLog: async () => {}, tryClaimAuditThrottle: async () => true,
    applyTrafficSamples: async (_database, client, samples, from, to) => {
      calls.order.push('apply');
      calls.apply.push({ client, samples: structuredClone(samples), from, to });
      if (applyImpl) return applyImpl(samples, from, to);
      return totals ?? { up: 10_000, down: 20_000, applied: samples.length };
    },
    importTrafficHistory: async (_database, client, days, baseline) => {
      calls.order.push('import');
      calls.import.push({ client, days: structuredClone(days), baseline: structuredClone(baseline) });
      if (importImpl) return importImpl();
      return days.length;
    },
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  return {
    object, storage, calls,
    agent() {
      const socket = createSocket({ role: 'agent', clientId: 'node', clientName: 'Agent supplied name', hidden: false });
      object.registerSession(socket.ws, socket.ws.deserializeAttachment());
      storage.sockets.push(socket.ws);
      return socket;
    },
    storedReport: () => storage.values.get('http-live:node').lastReport,
  };
}

const send = (f, reports) => f.object.fetch(new Request('https://do/client-report', {
  method: 'POST',
  body: JSON.stringify({ uuid: 'node', name: 'Agent supplied name', ttl_ms: 180000, reports }),
}));

async function post(f, reports) {
  const response = await send(f, reports);
  await f.storage.drain();
  return response;
}

const nic = (up, down) => ({ eth0: { up, down } });
const sampleAt = (ts, up = 1000, down = 2000, extra = {}) => ({
  timestamp: ts,
  cpu: 17,
  net_total_up: 111, // Agent 自己的「开机以来累计」；合成成功后会被覆盖
  net_total_down: 222,
  traffic_sample: { boot: 1780000000, scope: 'scope-a', utc_offset: 0, interfaces: nic(up, down), ...extra },
});
const T0 = NOW - 600_000;

test('the first sample is applied inline and the period total replaces the agent\'s raw net_total', async () => {
  const f = fixture(); // 默认重置日 1
  const response = await post(f, [sampleAt(T0)]);
  assert.equal(response.status, 200);
  assert.equal(f.calls.apply.length, 1);
  const call = f.calls.apply[0];
  assert.equal(call.client, 'node');
  assert.equal(call.from, '2027-01-01', 'period start follows the server-side reset day');
  assert.equal(call.to, '2027-01-15');
  assert.deepEqual(call.samples.map(sample => [sample.ts, sample.scope, sample.interfaces.eth0.up]), [[T0, 'scope-a', 1000]]);
  const stored = f.storedReport();
  assert.equal(stored.net_total_up, 10_000);
  assert.equal(stored.net_total_down, 20_000);
  assert.equal('traffic_sample' in stored, false, 'the wire-only field must not leak into live state');
  assert.equal('traffic_import' in stored, false);
  assert.equal('traffic_imported' in (await response.json()), false);
});

test('between applies the cached total is shown; a new apply happens about every two minutes', async () => {
  let version = 0;
  const f = fixture({ applyImpl: samples => ({ up: 10_000 + 1000 * ++version, down: 0, applied: samples.length }) });
  await post(f, [sampleAt(T0)]);
  assert.equal(f.storedReport().net_total_up, 11_000);

  await post(f, [sampleAt(T0 + 3_000)]); // 3 秒后：没到间隔，不查库，沿用缓存
  await post(f, [sampleAt(T0 + 60_000)]);
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.storedReport().net_total_up, 11_000);

  await post(f, [sampleAt(T0 + 130_000)]); // 超过 100 秒：后台落库（不拖慢这份 report）
  assert.equal(f.calls.apply.length, 2);
  assert.deepEqual(f.calls.apply[1].samples.map(sample => sample.ts), [T0 + 130_000]);
  await post(f, [sampleAt(T0 + 133_000)]);
  assert.equal(f.storedReport().net_total_up, 12_000, 'the background result is picked up by the next report');
});

test('a batch is applied in order, thinned to ~2 minutes; skipped samples lose nothing (counters are cumulative)', async () => {
  const f = fixture();
  const batch = Array.from({ length: 6 }, (_, index) => sampleAt(T0 + index * 60_000, 1000 + index * 100));
  await post(f, batch);
  assert.equal(f.calls.apply.length, 1, 'one RPC for the whole envelope');
  assert.deepEqual(f.calls.apply[0].samples.map(sample => sample.ts), [T0, T0 + 120_000, T0 + 240_000]);
  assert.deepEqual(f.calls.apply[0].samples.map(sample => sample.interfaces.eth0.up), [1000, 1200, 1400]);
});

test('an idle agent (one sample every 120 s) has every sample applied', async () => {
  const f = fixture();
  await post(f, [sampleAt(T0), sampleAt(T0 + 120_000), sampleAt(T0 + 239_000)]);
  assert.equal(f.calls.apply[0].samples.length, 3);
});

test('the reset day is applied on the server', async () => {
  const f = fixture({ resetDay: 20 });
  await post(f, [sampleAt(T0)]);
  assert.equal(f.calls.apply[0].from, '2026-12-20');
  assert.equal(f.calls.apply[0].to, '2027-01-15');
});

test('the date range uses the agent\'s local date (UTC offset), not the server\'s', async () => {
  const f = fixture({ resetDay: 1 });
  // NOW 是 UTC 08:00；UTC-12 的本地时间是前一天 20:00。
  await post(f, [sampleAt(NOW - 1000, 1000, 2000, { utc_offset: -12 * 3600 })]);
  assert.equal(f.calls.apply[0].to, '2027-01-14');
});

test('crossing a billing-period boundary refreshes the total immediately, with an empty (read-only) call', async () => {
  const f = fixture({ resetDay: 15, applyImpl: (samples, from) => ({ up: from === '2027-01-15' ? 0 : 5_000, down: 0, applied: samples.length }) });
  // 第一份：本地日期 01-14（重置日 15 → 周期从 12-15 开始）
  await post(f, [sampleAt(Date.UTC(2027, 0, 14, 23, 59) , 1000)]);
  assert.equal(f.calls.apply[0].from, '2026-12-15');
  assert.equal(f.storedReport().net_total_up, 5_000);
  // 3 秒后跨过零点 → 新周期从 01-15 开始；样本没到间隔，但合计必须立刻刷新。
  await post(f, [sampleAt(Date.UTC(2027, 0, 15, 0, 0, 2), 1000)]);
  assert.equal(f.calls.apply.length, 2);
  assert.equal(f.calls.apply[1].from, '2027-01-15');
  assert.deepEqual(f.calls.apply[1].samples, [], 'no new samples are due: this call only reads the total');
  assert.equal(f.storedReport().net_total_up, 0);
  // 只读刷新不算「已落库一个样本」：距上一次真正落库（23:59:00）已超过间隔，下一个样本（00:01:30）必须照常落库。
  await post(f, [sampleAt(Date.UTC(2027, 0, 15, 0, 1, 30), 1500)]);
  assert.equal(f.calls.apply.length, 3);
  assert.deepEqual(f.calls.apply[2].samples.map(sample => sample.interfaces.eth0.up), [1500]);
});

test('a failing apply never rejects the report; the agent\'s own value stays and the next report recovers', async () => {
  let fail = true;
  const f = fixture({ applyImpl: samples => {
    if (fail) throw new Error('database unavailable');
    return { up: 777, down: 888, applied: samples.length };
  } });
  const response = await post(f, [sampleAt(T0)]);
  assert.equal(response.status, 200, 'CPU/RAM monitoring must not go offline because traffic accounting is unhealthy');
  assert.equal(f.storedReport().net_total_up, 111, 'with no total available, the agent\'s raw value is left alone rather than invented');
  fail = false;
  await post(f, [sampleAt(T0 + 3_000)]);
  assert.equal(f.calls.apply.length, 2, 'the failed sample was never marked as applied, so it is retried');
  assert.equal(f.storedReport().net_total_up, 777);
});

test('only one apply per node is in flight at a time', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture({ applyImpl: async samples => {
    calls += 1;
    if (calls === 2) await gate;
    return { up: 1000 * calls, down: 0, applied: samples.length };
  } });
  await post(f, [sampleAt(T0)]);
  await send(f, [sampleAt(T0 + 130_000)]); // 第二次落库在后台挂起（这里不能 drain，否则会等它）
  await send(f, [sampleAt(T0 + 260_000)]); // 前一次还没结束：不能叠加第二个
  assert.equal(f.calls.apply.length, 2);
  release();
  await f.storage.drain();
  await post(f, [sampleAt(T0 + 262_000)]);
  assert.equal(f.calls.apply.length, 3, 'once finished, the next due sample goes through');
});

test('legacy history is imported before the first sample is applied, and acknowledged', async () => {
  const f = fixture();
  const legacy = {
    days: [{ date: '2027-01-10', up: 500, down: 600 }],
    baseline: { scope: 'scope-a', boot: 1780000000, interfaces: nic(900, 1900) },
  };
  const response = await post(f, [{ ...sampleAt(T0), traffic_import: legacy }]);
  assert.deepEqual(f.calls.order, ['import', 'apply'], 'the baseline must exist before the first live sample is processed');
  assert.deepEqual(f.calls.import[0].days, legacy.days);
  assert.deepEqual(f.calls.import[0].baseline, legacy.baseline);
  assert.equal((await response.json()).traffic_imported, true);
});

test('a failed legacy import is not acknowledged, so the agent keeps its old state file and retries', async () => {
  const f = fixture({ importImpl: () => { throw new Error('database unavailable'); } });
  const response = await post(f, [{ ...sampleAt(T0), traffic_import: { days: [{ date: '2027-01-10', up: 1, down: 1 }] } }]);
  assert.equal(response.status, 200);
  assert.equal('traffic_imported' in (await response.json()), false);
  assert.equal(f.calls.apply.length, 1, 'live accounting continues regardless');
});

test('legacy agents without traffic fields pass through untouched and never reach the traffic RPCs', async () => {
  const f = fixture();
  await post(f, [{ timestamp: T0, cpu: 5, net_total_up: 123_456, net_total_down: 654_321 }]);
  assert.deepEqual(f.calls.order, []);
  assert.equal(f.storedReport().net_total_up, 123_456);
  assert.equal(f.storedReport().net_total_down, 654_321);
});

test('a malformed sample is dropped and the report is accepted as before', async () => {
  const f = fixture();
  const response = await post(f, [{ timestamp: T0, cpu: 5, net_total_up: 5, net_total_down: 6, traffic_sample: { scope: '', interfaces: {} } }]);
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.order, []);
  assert.equal(f.storedReport().net_total_up, 5);
  assert.equal('traffic_sample' in f.storedReport(), false);
});

test('websocket: the ack confirms a legacy import and otherwise stays exactly as before', async () => {
  const f = fixture();
  const agent = f.agent();
  await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { ...sampleAt(T0), traffic_import: { days: [{ date: '2027-01-10', up: 1, down: 1 }] } } }));
  await f.storage.drain();
  const first = agent.messages.find(message => message.type === 'ack');
  assert.equal(first.traffic_imported, true);
  assert.equal(f.storedReport === undefined, false);

  const g = fixture();
  const plain = g.agent();
  await g.object.webSocketMessage(plain.ws, JSON.stringify({ type: 'report', data: sampleAt(T0) }));
  await g.storage.drain();
  const ack = plain.messages.find(message => message.type === 'ack');
  assert.deepEqual(Object.keys(ack).sort(), ['timestamp', 'type']);
  assert.equal(g.calls.apply.length, 1);
});
