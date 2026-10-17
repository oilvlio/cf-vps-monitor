import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';
import { decryptBackup, encryptBackup, validateBackup } from './backup.ts';

const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key' };
const database = { provider: 'supabase-api', env };
const copy = value => JSON.parse(JSON.stringify(value));
const password = 'synthetic-backup-password';

async function configuration(sql) {
  return (await sql.query(`select jsonb_build_object(
    'site_title', (select value from settings where key='site_title'),
    'clients', (select coalesce(jsonb_agg(uuid order by uuid),'[]'::jsonb) from clients),
    'ping_tasks', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'clients',clients) order by id),'[]'::jsonb) from ping_tasks)
  ) as value`)).rows[0].value;
}

function projected(backup) {
  return {
    site_title: backup.settings.site_title,
    clients: backup.clients.map(row => row.uuid).sort(),
    ping_tasks: backup.ping_tasks.map(row => ({ id: row.id, clients: row.clients })).sort((a, b) => a.id - b.id),
  };
}

async function seed(sql, second = false) {
  await sql.exec(`
    insert into clients(uuid,name,token,hidden,auto_renewal,traffic_reset_day)
      values ('node-a','Synthetic A','synthetic-token-a',1,1,12);
    insert into ping_tasks(id,name,clients,all_clients,type,target,interval_sec,sort_order)
      values (1,'Synthetic A','["node-a"]'::jsonb,0,'icmp','a.audit.example.com',60,1);
    update settings set value='Before' where key='site_title';
  `);
  if (second) await sql.exec(`
    insert into clients(uuid,name,token) values ('node-b','Synthetic B','synthetic-token-b');
    insert into ping_tasks(id,name,clients,all_clients,type,target,interval_sec,sort_order)
      values (2,'Synthetic B','["node-b"]'::jsonb,0,'icmp','b.audit.example.com',60,2);
  `);
}

async function withSnapshot(run, { afterFirst = null, second = false } = {}) {
  const sql = await createTestDatabase();
  try {
    await sql.exec('set role service_role');
    await seed(sql, second);
    let responses = 0;
    let after = null;
    const before = await configuration(sql);
    const loader = createWorkerLoader({ db: null, globals: { fetch: async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, env.SUPABASE_URL, 'no external requests');
      const args = JSON.parse(init.body);
      const name = parsed.pathname.split('/').at(-1);
      const value = name === 'cfm_settings_by_keys'
        ? (await sql.query('select cfm_settings_by_keys($1::text[]) as result', [args.input_keys])).rows[0].result
        : await rpc(sql, name, args);
      responses += 1;
      if (responses === 1 && afterFirst) {
        // The real first read has completed. Commit a valid administrator change
        // before the caller can start its next database request.
        await sql.exec(`begin;\n${afterFirst}\nupdate settings set value='After' where key='site_title';\ncommit;`);
        after = await configuration(sql);
      }
      return Response.json(value);
    } } });
    const { buildBackupSnapshot } = loader.load('worker/src/utils/backup-snapshot.ts');
    await run({ sql, before, snapshot: () => buildBackupSnapshot(database),
      getAfter: () => after, getResponses: () => responses });
  } finally { await sql.close(); }
}

const interleavings = [
  { name: 'create', sql: `
    insert into clients(uuid,name,token) values ('node-b','Synthetic B','synthetic-token-b');
    insert into ping_tasks(id,name,clients,all_clients,type,target,interval_sec,sort_order)
      values (2,'Synthetic B','["node-b"]'::jsonb,0,'icmp','b.audit.example.com',60,2);
  ` },
  { name: 'delete', second: true, sql: "delete from ping_tasks where id=2; delete from clients where uuid='node-b';" },
  { name: 'reference replacement', sql: `
    insert into clients(uuid,name,token) values ('node-b','Synthetic B','synthetic-token-b');
    update ping_tasks set clients='["node-b"]'::jsonb where id=1;
    delete from clients where uuid='node-a';
  ` },
];

for (const change of interleavings) {
  test(`R-D05 ${change.name} between database responses yields one restorable configuration`, async () => {
    await withSnapshot(async ({ sql, before, snapshot, getAfter }) => {
      const backup = await snapshot();
      const validated = validateBackup(backup);
      assert.equal(validated.ok, true, JSON.stringify(validated.errors));
      const actual = projected(copy(backup));
      assert.ok([before, getAfter()].some(expected => isDeepStrictEqual(expected, actual)),
        `backup must describe one committed configuration: ${JSON.stringify(actual)}`);
      const encrypted = await encryptBackup(backup, password);
      assert.equal(encrypted.ok, true);
      const decrypted = await decryptBackup(encrypted.encryptedBackup, password);
      assert.equal(decrypted.ok, true);
      await rpc(sql, 'cfm_restore_backup_data', { input_backup: decrypted.backup });
      assert.deepEqual(await configuration(sql), actual);
    }, { afterFirst: change.sql, second: change.second });
  });
}

test('R-D05 no-concurrency export keeps normalized fields', async () => {
  await withSnapshot(async ({ sql, before, snapshot }) => {
    const backup = await snapshot();
    assert.equal(validateBackup(backup).ok, true);
    assert.deepEqual(projected(copy(backup)), before);
    assert.equal(backup.clients[0].hidden, true);
    assert.equal(backup.clients[0].auto_renewal, true);
    assert.equal(backup.clients[0].traffic_reset_day, 12);
    const access = (await sql.query(`select p.provolatile as volatility,
      has_function_privilege('anon',p.oid,'execute') as anon,
      has_function_privilege('authenticated',p.oid,'execute') as authenticated,
      has_function_privilege('service_role',p.oid,'execute') as service
      from pg_proc p where p.oid='public.cfm_backup_configuration_snapshot()'::regprocedure`)).rows[0];
    assert.deepEqual(access, { volatility: 's', anon: false, authenticated: false, service: true },
      'backup secrets use the caller snapshot and are executable only through the Worker role');
    assert.deepEqual(copy(backup.ping_tasks[0].clients), ['node-a']);
    const encrypted = await encryptBackup(backup, password);
    assert.equal(encrypted.ok, true);
    const decrypted = await decryptBackup(encrypted.encryptedBackup, password);
    assert.equal(decrypted.ok, true);
    await rpc(sql, 'cfm_restore_backup_data', { input_backup: decrypted.backup });
    assert.deepEqual(await configuration(sql), before);
  });
});
