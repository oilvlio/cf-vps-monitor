import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { notificationHarness } from '../../scripts/test-support/notifications.mjs';

async function seededDatabase() {
  const database = await createTestDatabase();
  await database.exec("insert into clients(uuid,name) values ('node-a','A'),('node-b','B');");
  return database;
}

test('AUD-08 offline and recovery failures remain pending until delivery succeeds', async () => {
  const database = await seededDatabase();
  try {
    await database.exec("insert into offline_notifications(client,enable,grace_period) values ('node-a',1,30);");
    const calls = [];
    const responses = [false, true, false, true];
    const h = await notificationHarness(database, subject => { calls.push(subject); return responses.shift(); });
    await h.run('runOfflineCheck', 0);
    assert.equal((await rpc(database, 'cfm_offline_notifications'))[0].last_notified, null, 'failed offline send is not a delivered event');
    await h.run('runOfflineCheck', 2);
    assert.ok((await rpc(database, 'cfm_offline_notifications'))[0].last_notified);
    await h.run('runOfflineCheck', 4);
    assert.deepEqual(calls, ['offline:A', 'offline:A']);
    h.state.online = true;
    await h.run('runOfflineCheck', 6);
    assert.ok((await rpc(database, 'cfm_offline_notifications'))[0].last_notified, 'failed recovery does not erase the pending event');
    await h.run('runOfflineCheck', 8);
    assert.equal((await rpc(database, 'cfm_offline_notifications'))[0].last_notified, null);
    await h.run('runOfflineCheck', 10);
    assert.deepEqual(calls, ['offline:A', 'offline:A', 'recovery:A', 'recovery:A']);
  } finally { await database.close(); }
});

test('AUD-08 expiry failures retry and channel none does not consume the event', async () => {
  const database = await seededDatabase();
  try {
    await database.exec("insert into expiry_notifications(client,enable,advance_days) values ('node-a',1,7);");
    const calls = [];
    const h = await notificationHarness(database, subject => { calls.push(subject); return calls.length > 1; });
    h.state.channel = 'none';
    await h.run('runExpiryCheck', 0);
    assert.equal((await rpc(database, 'cfm_expiry_notifications'))[0].last_notified, null);
    h.state.channel = 'email';
    await h.run('runExpiryCheck', 2);
    assert.equal((await rpc(database, 'cfm_expiry_notifications'))[0].last_notified, null);
    await h.run('runExpiryCheck', 4);
    await h.run('runExpiryCheck', 6);
    assert.deepEqual(calls, ['expiry:A', 'expiry:A']);
    assert.ok((await rpc(database, 'cfm_expiry_notifications'))[0].last_notified);
  } finally { await database.close(); }
});

test('AUD-08 partial load delivery retries only the failed node within the rule interval', async () => {
  const database = await seededDatabase();
  try {
    await database.exec("insert into load_notifications(id,name,clients,metric,threshold,ratio,interval_min) values (1,'Synthetic','[]','cpu',80,0.8,15);");
    const calls = [];
    let failedB = false;
    const h = await notificationHarness(database, subject => {
      calls.push(subject);
      if (subject === 'load:B' && !failedB) { failedB = true; return false; }
      return true;
    });
    await h.run('runLoadCheck', 0);
    await h.run('runLoadCheck', 2);
    await h.run('runLoadCheck', 4);
    assert.deepEqual(calls, ['load:A', 'load:B', 'load:B'], 'one successful node must not hide or duplicate a failed target');
  } finally { await database.close(); }
});
