import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('assignment validates the whole delta and commits membership and timeouts atomically', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());
  await db.exec(`insert into clients(uuid) values ('a'),('b');
    insert into ping_tasks(id,name,target,clients,all_clients) values
    (1,'one','example.com','["b"]',0),(2,'two','example.com','[]',0),(3,'global','example.com','[]',1);`);
  const assign = (desired, base = [], timeouts = [], client = 'a') => rpc(db, 'cfm_set_client_ping_assignment', {
    input_client: client, input_desired: desired, input_base: base, input_timeouts: timeouts,
  });
  const members = async () => (await db.query('select id, clients from ping_tasks order by id')).rows;
  const original = await members();
  assert.equal((await assign([1, 999])).ok, false);
  assert.deepEqual(await members(), original);
  assert.equal((await assign([1], [], [{ task_id: 2, timeout_ms: 1000 }])).ok, false);
  assert.deepEqual(await members(), original);
  assert.equal((await assign([1], [], [{ task_id: 1, timeout_ms: 50 }])).ok, false);
  assert.deepEqual(await members(), original);
  assert.equal((await assign([3])).ok, false);
  assert.equal((await assign([], [], [], 'missing')).status, 404);

  await db.exec(`create function fail_timeout() returns trigger language plpgsql as $$ begin raise exception 'synthetic timeout write failure'; end $$;
    create trigger fail_timeout before insert on ping_task_client_timeouts for each row execute function fail_timeout();`);
  await assert.rejects(assign([1], [], [{ task_id: 1, timeout_ms: 1000 }]), /synthetic timeout write failure/);
  assert.deepEqual(await members(), original, 'a late write failure rolls back the membership update');
  await db.exec('drop trigger fail_timeout on ping_task_client_timeouts');

  const result = await assign([1, 2], [], [{ task_id: 1, timeout_ms: 1000 }, { task_id: 3, timeout_ms: 2000 }]);
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.timeouts, 2);
  assert.deepEqual((await members())[0].clients, ['b', 'a']);
  assert.equal((await assign([], [])).tasks.length, 0, 'stale unchanged selections preserve current membership');
  assert.equal((await assign([], [999])).ok, true, 'removing an already deleted task is harmless');
  await assign([1], [1, 2], [{ task_id: 1, timeout_ms: null }]);
  assert.deepEqual((await members())[1].clients, []);
  assert.deepEqual((await db.query('select task_id,timeout_ms from ping_task_client_timeouts')).rows, [{ task_id: 3, timeout_ms: 2000 }]);
  await db.exec('set role service_role');
  assert.equal((await assign([1], [1])).ok, true);
  await db.exec('reset role; set role anon');
  await assert.rejects(assign([]), /permission denied/);
});
