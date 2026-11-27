import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

function fixture(client) {
  const loader = createWorkerLoader({
    db: {
      getSettingsByKeys: async () => ({}), getClient: async () => client,
      listPingTasks: async () => [], listPingTaskClientTimeouts: async () => [],
    },
    expose: { 'worker/src/routes/client.ts': ['fallbackAgentPolicy'] },
  });
  return { loader, ...loader.load('worker/src/routes/client.ts') };
}

test('AUD-29: HTTP and WebSocket policies carry the same authoritative traffic reset day', async () => {
  const client = { uuid: 'node', traffic_reset_day: 15, token: 'synthetic-private-token' };
  const f = fixture(client);
  const http = await f.fallbackAgentPolicy(f.loader.database, 'node');
  assert.equal(http.traffic_reset_day, 15);
  assert.ok(!JSON.stringify(http).includes(client.token));
  const state = createDurableState([['admin-clients:snapshot', { clients: [client], removed: [], updatedAt: Date.now() }]]);
  const { LiveDataDO } = f.loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const ws = await object.buildAgentPolicy(Date.now(), false, false, 'node');
  assert.equal(ws.traffic_reset_day, http.traffic_reset_day);
});

test('AUD-29: missing or invalid server reset day does not overwrite a locally configured day', async () => {
  for (const client of [null, {}, { traffic_reset_day: 0 }, { traffic_reset_day: 32 }]) {
    const f = fixture(client);
    const policy = JSON.parse(JSON.stringify(await f.fallbackAgentPolicy(f.loader.database, 'node')));
    assert.ok(!Object.hasOwn(policy, 'traffic_reset_day'));
  }
});

test('HTTP and WebSocket resolve node and global timeout overrides identically, including refresh and removal', async () => {
  let tasks = [
    { id: 1, name: 'Assigned', type: 'icmp', target: '1.1.1.1', clients: ['node'], all_clients: false, interval_sec: 60, timeout_ms: 3000 },
    { id: 2, name: 'Global', type: 'tcp', target: 'example.com:443', clients: [], all_clients: true, interval_sec: 60, timeout_ms: 4000 },
    { id: 3, name: 'Other', type: 'icmp', target: '8.8.8.8', clients: ['other'], all_clients: false, interval_sec: 60, timeout_ms: 3000 },
  ];
  let timeouts = [{ task_id: 1, client: 'node', timeout_ms: 1000 }, { task_id: 2, client: 'node', timeout_ms: 2000 }, { task_id: 1, client: 'other', timeout_ms: 500 }];
  const loader = createWorkerLoader({
    db: { getSettingsByKeys: async () => ({}), getClient: async () => null,
      listPingTasks: async () => tasks, listPingTaskClientTimeouts: async () => timeouts,
    },
    expose: { 'worker/src/routes/client.ts': ['fallbackAgentPolicy'] },
  });
  const httpModule = loader.load('worker/src/routes/client.ts');
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(createDurableState().state, {});
  const policies = async expected => {
    object.invalidatePingTasksCache();
    const http = await httpModule.fallbackAgentPolicy(loader.database, 'node');
    const ws = await object.buildAgentPolicy(Date.now(), false, false, 'node');
    assert.deepEqual(ws.ping_tasks, http.ping_tasks);
    assert.deepEqual(Array.from(ws.ping_tasks, task => task.timeout_ms), expected);
    assert.equal(ws.ping_policy_version, http.ping_policy_version);
    return http.ping_policy_version;
  };
  const overridden = await policies([1000, 2000]);
  timeouts = [];
  const defaults = await policies([3000, 4000]);
  assert.notEqual(defaults, overridden, 'removing overrides changes the version');
  tasks = tasks.map(task => ({ ...task, timeout_ms: 5000 }));
  assert.notEqual(await policies([5000, 5000]), defaults, 'changing defaults changes the version');
});
