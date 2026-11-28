import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createRuntimeFixture, eventually } from '../test-support/runtime-fixture.mjs';

function awaitMessage(ws, type, send) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error(`Missing ${type}`)); }, 8000);
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'error') { clearTimeout(timeout); ws.removeEventListener('message', listener); reject(new Error(message.code)); }
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      resolve(message);
    };
    ws.addEventListener('message', listener);
    send?.();
  });
}

test('AUD-30/32/35/37: actual Durable Objects preserve bounded reports, all Ping batches and HTTP state', { timeout: 90000 }, async t => {
  const f = await createRuntimeFixture({ persistDurableObjects: true });
  t.after(() => f.close());
  await f.database.query("insert into clients(uuid,name) values ('runtime-node','Runtime fixture'), ('http-node','HTTP fixture')");
  await f.database.exec(`insert into ping_tasks(name,type,target,all_clients,interval_sec)
    select 'synthetic-'||i, 'tcp', 'example.test:443', 1, 120 from generate_series(1,1000) i`);
  const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const stub = namespace.get(namespace.idFromName('runtime-ws'));
  const response = await stub.fetch('https://do/?role=agent&id=runtime-node&name=Runtime', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.accept();
  t.after(() => { try { ws.close(); } catch {} });

  await t.test('a native attachment accepts large extensions without dropping metrics or history', async () => {
    const raw = {
      type: 'report', data: { cpu: 17, timestamp: Date.now() - 3600000,
        arbitrary_extension: 'x'.repeat(20000), basic_info: { os: '中'.repeat(9000), ipv4: '10.77.0.5' },
        gpus: Array.from({ length: 16 }, (_, device_index) => ({ device_index, device_name: '图'.repeat(128), mem_total: 1000, mem_used: 100, utilization: 10, temperature: 40 })),
      },
    };
    await awaitMessage(ws, 'ack', () => ws.send(JSON.stringify(raw)));
    await eventually(async () => (await f.database.query("select count(*)::int as count from records where client='runtime-node' and cpu=17")).rows[0].count === 1);
    const live = await (await stub.fetch('https://do/live')).json();
    assert.equal(live.data['runtime-node'].cpu, 17);
    assert.equal(live.data['runtime-node'].gpus.length, 16);
    assert.ok(!JSON.stringify(live).includes('10.77.0.5'));
    const liveness = await (await stub.fetch('https://do/offline-evaluate', { method: 'POST', body: JSON.stringify({ clients: [{ uuid: 'runtime-node', graceMs: 180000 }] }) })).json();
    assert.equal(liveness.clients['runtime-node'].offline, false);
  });

  await t.test('twenty fifty-item batches at one sample timestamp retain all 1000 task results', async () => {
    const timestamp = Date.now();
    const reports = Array.from({ length: 20 }, (_, batch) => ({ cpu: 17, timestamp,
      ping_results: Array.from({ length: 50 }, (_, offset) => ({ task_id: batch * 50 + offset + 1, value: 10 })),
    }));
    await awaitMessage(ws, 'ack', () => ws.send(JSON.stringify({ type: 'reports', reports })));
    await eventually(async () => (await f.database.query(`
      select count(distinct item.key)::int as count from ping_snapshots p
      cross join lateral jsonb_each(p.values_json) item where p.client='runtime-node'
    `)).rows[0].count === 1000, 15000);
    const sameRound = (await f.database.query(`
      select values_json from ping_snapshots where client='runtime-node' and time=$1
    `, [new Date(timestamp).toISOString()])).rows;
    assert.equal(sameRound.length, 1);
    assert.equal(Object.keys(sameRound[0].values_json).length, 1000);
    assert.equal(sameRound[0].values_json['1'], 10);
    assert.equal(sameRound[0].values_json['1000'], 10);
  });

  await t.test('native viewer close events preserve active grace across a Worker restart', async () => {
    const policyObject = namespace.get(namespace.idFromName('runtime-viewer-policy'));
    const agentResponse = await policyObject.fetch('https://do/?role=agent&id=runtime-node', { headers: { Upgrade: 'websocket' } });
    assert.equal(agentResponse.status, 101);
    const policyAgent = agentResponse.webSocket;
    t.after(() => { try { policyAgent.close(); } catch {} });
    const initial = await awaitMessage(policyAgent, 'policy', () => policyAgent.accept());
    assert.equal(initial.mode, 'idle');

    for (const role of ['monitor', 'viewer']) {
      const active = awaitMessage(policyAgent, 'policy');
      const viewerResponse = await policyObject.fetch(`https://do/?role=${role}&id=runtime-${role}`, { headers: { Upgrade: 'websocket' } });
      assert.equal(viewerResponse.status, 101);
      const viewer = viewerResponse.webSocket;
      t.after(() => { try { viewer.close(); } catch {} });
      viewer.accept();
      const watching = await active;
      assert.equal(watching.mode, 'active');
      assert.equal(watching.viewer_count, 1);
      const grace = await awaitMessage(policyAgent, 'policy', () => viewer.close());
      assert.equal(grace.mode, 'active');
      assert.equal(grace.viewer_count, 0);
      assert.equal(grace.report_interval_sec, watching.report_interval_sec);
      assert.equal(grace.viewer_ttl_sec, 120);
    }

    await f.restart();
    const restoredNamespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    const restored = restoredNamespace.get(restoredNamespace.idFromName('runtime-viewer-policy'));
    const grace = await (await restored.fetch('https://do/policy')).json();
    assert.equal(grace.mode, 'active');
    assert.equal(grace.viewer_count, 0);
    assert.equal(grace.viewer_ttl_sec, 120);
  });

  await t.test('native Monitor alarms merge staggered reports using the configured active interval', async () => {
    await f.database.query("insert into clients(uuid,name) values ('cadence-node-a','Cadence A'), ('cadence-node-b','Cadence B')");
    await f.database.query("update settings set value='3' where key='live_poll_active_interval_sec'");
    const currentNamespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    const monitor = currentNamespace.get(currentNamespace.idFromName('runtime-monitor-cadence'));
    const response = await monitor.fetch('https://do/?role=monitor&id=cadence-viewer', { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    t.after(() => { try { socket.close(); } catch {} });
    const frames = [];
    const failures = [];
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      if (Array.isArray(frame.nodes)) frames.push({ frame, at: performance.now() });
      else failures.push(frame);
    });
    socket.accept();
    await eventually(() => frames.length >= 1);
    const report = async (uuid, cpu) => {
      const response = await monitor.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
        uuid, name: uuid, ttl_ms: 180000, report: { cpu, timestamp: Date.now() },
      }) });
      assert.equal(response.status, 200);
    };
    await report('cadence-node-a', 41);
    await eventually(() => frames.some(({ frame }) => frame.nodes.some(node => node.name === 'Cadence A' && node.metrics?.cpu === 41)), 8000);
    const start = frames.findIndex(({ frame }) => frame.nodes.some(node => node.name === 'Cadence A' && node.metrics?.cpu === 41));
    const sentAt = frames[start].at;
    // The one-second delay represents another Agent's different transport latency.
    await report('cadence-node-a', 42);
    await eventually(() => performance.now() - sentAt >= 1000);
    await report('cadence-node-b', 52);
    await eventually(() => frames.length > start + 1, 8000);
    const next = frames[start + 1];
    const gap = next.at - sentAt;
    assert.ok(gap >= 2700, `configured 3s window flushed early at ${gap}ms`);
    assert.ok(gap < 6500, `configured 3s window stalled for ${gap}ms`);
    assert.equal(next.frame.nodes.find(node => node.name === 'Cadence A').metrics.cpu, 42);
    assert.equal(next.frame.nodes.find(node => node.name === 'Cadence B').metrics.cpu, 52);
    assert.deepEqual(failures, []);
    socket.close();
  });

  await t.test('HTTP state survives a native Worker restart when history is disabled', async () => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    await f.database.query("update settings set value='false' where key='record_enabled'");
    const http = namespace.get(namespace.idFromName('runtime-http'));
    const response = await http.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid: 'http-node', name: 'HTTP fixture', ttl_ms: 180000, timestamp: Date.now(), report: { cpu: 29, timestamp: Date.now() },
    }) });
    assert.equal(response.status, 200);
    assert.equal((await (await http.fetch('https://do/live')).json()).data['http-node'].cpu, 29);
    await f.restart();
    const restartedNamespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    const restarted = restartedNamespace.get(restartedNamespace.idFromName('runtime-http'));
    const live = await (await restarted.fetch('https://do/live')).json();
    assert.equal(live.data['http-node'].cpu, 29);
    assert.equal((await f.database.query("select count(*)::int as count from records where client='http-node'")).rows[0].count, 0);
  });
});
