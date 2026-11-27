import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigration, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const iso = ms => new Date(ms).toISOString();
async function fixture(run) {
  const sql = await createTestDatabase();
  try {
    await sql.exec('set role service_role');
    const start = Date.now();
    const claim = (key, event = 'event-a', offset = 0) => rpc(sql, 'cfm_claim_notification_delivery', {
      input_key: key, input_event_id: event, input_now: iso(start + offset), input_repeat_ms: 0,
    });
    const complete = (key, token, { event = 'event-a', success = true, offset = 1 } = {}) => rpc(sql, 'cfm_complete_notification_delivery', {
      input_key: key, input_event_id: event, input_token: token, input_success: success,
      input_now: iso(start + offset), input_repeat_ms: 0,
    });
    const rows = async () => (await sql.query('select * from cfm_internal.notification_delivery_state order by key')).rows;
    // 投递状态的拥有者：一个启用了离线通知的节点（键为 offline:<uuid>）。
    const node = async (uuid = 'lifecycle-node') => {
      await sql.query('insert into clients(uuid,name) values ($1,$2)', [uuid, 'Synthetic node']);
      await sql.query('insert into offline_notifications(client,enable) values ($1,1)', [uuid]);
      return { uuid, key: `offline:${uuid}` };
    };
    const deleteNode = ({ uuid }) => rpc(sql, 'cfm_delete_clients', { input_uuids: [uuid] });
    await run({ sql, start, claim, complete, rows, node, deleteNode });
  } finally { await sql.close(); }
}

test('R-D06 deleting a node retires its completed delivery state', async () => {
  await fixture(async ({ claim, complete, rows, node, deleteNode }) => {
    const owner = await node();
    const key = owner.key;
    const attempt = await claim(key);
    assert.equal(await complete(key, attempt.token), true);
    assert.equal((await rows())[0].status, 'sent');
    await deleteNode(owner);
    assert.deepEqual(await rows(), [], 'a completed state for a removed entity must be reclaimed');
  });
});

test('R-D06 a different event cannot steal an unexpired pending lease', async () => {
  await fixture(async ({ claim, complete, rows, node }) => {
    const { key } = await node();
    const first = await claim(key);
    assert.equal((await claim(key, 'event-b', 1_000)).claimed, false);
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal(await complete(key, first.token), true);
    const next = await claim(key, 'event-b', 2_000);
    assert.equal(next.claimed, true, 'a new event can start after the previous one completes');
    assert.notEqual(next.token, first.token);
    assert.equal(await complete(key, first.token), false);
  });
});

test('R-D06 deletion preserves an active token until matching completion retires it', async () => {
  await fixture(async ({ claim, complete, rows, node, deleteNode }) => {
    const owner = await node();
    const key = owner.key;
    const first = await claim(key);
    await deleteNode(owner);
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal((await claim(key, 'event-b', 1_000)).claimed, false);
    assert.equal(await complete(key, 'wrong-token'), false);
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal(await complete(key, first.token), false,
      'retiring a completed old attempt must not authorize a replacement event marker');
    assert.deepEqual(await rows(), []);
  });
});

test('R-D06 client deletion cleans its full colon-containing identity without touching another client', async () => {
  await fixture(async ({ sql, claim, complete, rows }) => {
    await sql.exec(`
      insert into clients(uuid,name) values ('region:node','Synthetic colon node'), ('node','Synthetic survivor');
      insert into offline_notifications(client,enable) values ('region:node',1),('node',1);
      insert into expiry_notifications(client,enable) values ('region:node',1),('node',1);
      insert into load_notifications(id,name,clients) values (7,'Synthetic all nodes','[]');
    `);
    for (const client of ['region:node', 'node']) for (const prefix of ['offline', 'expiry', 'load:7']) {
      const key = `${prefix}:${client}`;
      const claimed = await claim(key);
      await complete(key, claimed.token);
    }
    await rpc(sql, 'cfm_delete_clients', { input_uuids: ['region:node'] });
    assert.deepEqual((await rows()).map(row => row.key), ['expiry:node', 'load:7:node', 'offline:node']);
  });
});

test('R-D06 notification rule deletion reclaims inactive states for all its targets', async () => {
  await fixture(async ({ sql, claim, complete, rows }) => {
    await sql.exec(`insert into clients(uuid,name) values ('node-a','A'),('node-b','B');
      insert into load_notifications(id,name,clients) values (7,'Removed rule','[]'),(8,'Kept rule','[]');`);
    for (const key of ['load:7:node-a', 'load:7:node-b', 'load:8:node-a']) {
      const attempt = await claim(key);
      await complete(key, attempt.token, { success: key !== 'load:7:node-b' });
    }
    await rpc(sql, 'cfm_delete_load_notification', { input_id: 7 });
    assert.deepEqual((await rows()).map(row => row.key), ['load:8:node-a']);
  });
});

test('R-D06 bounded cleanup retires legacy orphans and waits for active leases without erasing live sent events', async () => {
  await fixture(async ({ sql, start, rows, node }) => {
    const owner = await node('offline-live');
    await sql.exec("insert into clients(uuid,name) values ('live:client','Synthetic live client'); insert into load_notifications(id,name,clients) values (7,'Current rule','[]')");
    const legacy = [
      [owner.key, 'sent', null, start - 86_400_000],
      ['load:7:live:client', 'sent', null, start - 86_400_000],
      ['custom:unclassified', 'sent', null, start - 86_400_000],
      ['offline:ghost', 'sent', null, start - 86_400_000],
      ['load:77:live:client', 'failed', null, start - 86_400_000],
      ['load:7:missing:client', 'sent', null, start - 86_400_000],
      ['offline:removed:client', 'pending', 'active-legacy-token', start + 90_000],
    ];
    for (const [key, status, token, deadline] of legacy) await sql.query(`
      insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,claim_token,delivered_at,updated_at)
      values ($1,'legacy-event',$2,1,$3,$4,$5,$5)
    `, [key, status, iso(deadline), token, iso(start - 86_400_000)]);
    let deleted = 0;
    for (let batch = 0; batch < 4; batch += 1) {
      const result = await rpc(sql, 'cfm_cleanup_notification_delivery_state', {
        input_now: iso(start), input_batch_size: 2, input_max_batches: 1,
      });
      assert.equal(typeof result.notification_delivery_state, 'number');
      assert.ok(result.notification_delivery_state <= 2);
      assert.equal(result.has_more, true, 'an active retired lease requires a later cleanup pass');
      deleted += result.notification_delivery_state;
    }
    assert.equal(deleted, 3);
    const active = (await rows()).find(row => row.key === 'offline:removed:client');
    assert.equal(active.claim_token, 'active-legacy-token');
    assert.equal(active.status, 'pending');
    assert.ok(active.retired_at);
    const final = await rpc(sql, 'cfm_cleanup_notification_delivery_state', {
      input_now: iso(start + 90_001), input_batch_size: 2, input_max_batches: 1,
    });
    assert.deepEqual(final, { notification_delivery_state: 1, has_more: false });
    assert.deepEqual((await rows()).map(row => row.key), ['custom:unclassified', 'load:7:live:client', owner.key]);
    const access = (await sql.query(`select
      has_function_privilege('anon','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as anon,
      has_function_privilege('authenticated','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as authenticated,
      has_function_privilege('service_role','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as service
    `)).rows[0];
    assert.deepEqual(access, { anon: false, authenticated: false, service: true });
  });
});
