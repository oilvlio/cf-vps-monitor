import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader, createDurableState, createSocket } from '../../test-support/worker-module.mjs';

async function fixture() {
  const token = 'a'.repeat(64);
  let row = { uuid: 'audit', name: 'audit', token, hidden: false, ipv4: '1.1.1.1', ipv6: '', region: 'US', os: 'Old OS', version: 'old', cpu_name: 'Old CPU', cpu_cores: 1, mem_total: 100, swap_total: 0, disk_total: 100 };
  const writes = [], audits = [];
  const state = createDurableState([['admin-clients:snapshot', { clients: [row], complete: true, updatedAt: Date.now() - 1, removed: [] }]]);
  const loader = createWorkerLoader({ db: {
    getClientByToken: async () => structuredClone(row), getClient: async () => structuredClone(row),
    updateClient: async (_db, _id, patch) => { writes.push(patch); row = { ...row, ...patch }; },
    getSettingsByKeys: async () => ({ record_enabled: 'false', enable_ip_change_notification: 'true', notification_method: 'none' }),
    getSetting: async () => null, setSetting: async () => {}, listPingTasks: async () => [],
    markClientTokenUsed: async () => ({ updated: false }), tryClaimAuditThrottle: async () => true,
    isIpChangeNotificationEnabled: async () => true, insertAuditLog: async (...args) => audits.push(args),
  } });
  const { hashAgentToken } = loader.load('worker/src/utils/client.ts');
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  await object.fetch(new Request('https://do/agent-auth', { method: 'POST', body: JSON.stringify({ client: { ...row, token_hash: await hashAgentToken(token) } }) }));
  const env = { LIVE_DATA: { idFromName: x => x, get: () => ({ fetch: r => object.fetch(r) }) }, RATE_LIMIT_120: { limit: async () => ({ success: true }) } };
  return { token, state, loader, object, env, writes, audits };
}

test('identical HTTP reports stop writing metadata after the first successful update', async () => {
  const f = await fixture();
  const { clientRoutes, invalidateAgentClientAuthCache } = f.loader.load('worker/src/routes/client.ts');
  for (let i = 0; i < 5; i++) {
    // Force a durable snapshot read rather than relying on the process-local cache.
    invalidateAgentClientAuthCache({ uuid: 'audit', token: f.token });
    const before = f.writes.length;
    const res = await clientRoutes.fetch(new Request('https://audit/report', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ cpu: 2, ipv4: '8.8.8.8', version: 'new', basic_info: { os: 'Linux', cpu_name: 'CPU', cpu_cores: 1, mem_total: 100, swap_total: 0, disk_total: 100 } }) }), f.env, { waitUntil: p => f.state.state.waitUntil(p) });
    assert.equal(res.status, 200);
    await f.state.drain();
    if (i > 0) assert.equal(f.writes.length, before);
  }
  assert.equal(f.audits.filter(x => x[2] === 'ip_change').length, 1);
});

test('WS IP changes notify once across top-level and basic-info reports', async () => {
  const f = await fixture();
  const agent = createSocket({ role: 'agent', clientId: 'audit', clientName: 'audit', hidden: false });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  for (let i = 0; i < 2; i++) {
    await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: 2, ipv4: '8.8.8.8', region: 'US', basic_info: { ipv4: '8.8.8.8', os: 'Linux', region: 'US' } } }));
    await f.state.drain();
  }
  assert.equal(f.audits.filter(x => x[2] === 'ip_change').length, 1);
  assert.ok(agent.messages.some(x => x.type === 'ack'));
});

test('WS transport fallback and private addresses do not trigger public IP notifications', async () => {
  const f = await fixture();
  const agent = createSocket({ role: 'agent', clientId: 'audit', clientName: 'audit', hidden: false, sourceIp: '8.8.8.8', region: 'US' });
  f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  for (const data of [{ cpu: 2 }, { cpu: 2, ipv4: '10.0.0.1', basic_info: { ipv4: '192.168.1.1', region: 'US' } }]) {
    await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data }));
    await f.state.drain();
  }
  assert.equal(f.audits.filter(x => x[2] === 'ip_change').length, 0);
});
