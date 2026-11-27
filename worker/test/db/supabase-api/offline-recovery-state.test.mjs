import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../../src/generated/supabase-migrations.ts';
import { applyApplicationMigrations, applyMigration, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

const migration = await readFile(new URL('../../../../supabase/migrations/2_functions.sql', import.meta.url), 'utf8');
const generated = BUNDLED_SUPABASE_MIGRATIONS.find(({ version }) => version === '2_functions')?.sql;
assert.ok(generated);

for (const source of [migration, generated]) {
  assert.match(source, /last_notified\s*=\s*case\s+when\s+excluded\.enable\s*=\s*0\s+then\s+null/i);
  assert.match(source, /set\s+last_notified\s*=\s*nullif\(input_time,\s*''\)::timestamptz/i);
  // 迁移应保持 create or replace 的幂等重放，不靠 drop 重建既有函数。
  // （例外：返回类型变化、新增参数签名，或函数已在终态目录中退役时必须先
  // drop，避免旧重载造成调用歧义、或让升级安装残留已删入口。）
  const retired = [
    'cfm_mark_client_token_used', 'cfm_audit_logs_paged', 'cfm_estimate_history_relation',
    'cfm_build_history_rollup', 'cfm_build_ping_rollup',
    'cfm_delete_old_records', 'cfm_delete_old_ping_records', 'cfm_delete_old_ping_rollup',
    'cfm_expired_row_counts', 'cfm_ensure_ping_time_partitions', 'cfm_ensure_history_time_partitions',
    'cfm_prune_ping_time_partitions', 'cfm_prune_history_time_partitions',
    'cfm_history_storage_usage', 'cfm_bounded_storage_row_counts',
    'cfm_insert_gpu_snapshot', 'cfm_gpu_records', 'cfm_gpu_records_paged',
    'cfm_gpu_records_cursor', 'cfm_gpu_rollup_range',
    'cfm_backup_configuration_snapshot', 'cfm_restore_backup_data',
    'cfm_ping_records_paged', 'cfm_ping_records_cursor',
  ];
  const allowed = new RegExp(
    `drop function if exists public\\.(?!${retired.map(name => `${name}\\b`).join('|')})`, 'i',
  );
  assert.doesNotMatch(source, allowed);
  assert.match(source, /where n\.nspname = 'public' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated[\s\S]*?grant execute on function %s to service_role/i);
}

test('offline marker RPC keeps its effective privileges when the migrations are replayed', async () => {
  const database = await createTestDatabase({ migrate: false });
  try {
    for (let install = 0; install < 2; install++) {
      // First install applies the bundle; a repeat install re-runs only the
      // migration whose checksum changed (`/db-init` skips the rest).
      if (install === 0) await applyApplicationMigrations(database);
      else {
        await applyMigration(database, '1_schema');
        await applyMigration(database, '2_functions');
      }
      const { rows } = await database.query(`select
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_execute,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
          where grantee = 0 and privilege_type = 'EXECUTE') as public_execute
        from pg_proc p
        where p.oid = to_regprocedure('public.cfm_mark_offline_notification_sent(text,text,text)')`);
      assert.deepEqual(rows, [{ anon_execute: false,
        authenticated_execute: false, service_execute: true, public_execute: false }]);
    }
    for (const role of ['anon', 'authenticated']) {
      await database.exec(`set role ${role}`);
      try {
        await assert.rejects(rpc(database, 'cfm_mark_offline_notification_sent', {
          input_client: 'offline-gate', input_time: '', input_token: 'synthetic-token',
        }), { code: '42501' });
      } finally { await database.exec('reset role'); }
    }

    await database.exec(`set role service_role;
      insert into clients(uuid, name) values ('offline-gate', 'Synthetic offline node');
      insert into offline_notifications(client, enable, last_notified)
        values ('offline-gate', 1, '2026-09-09T00:00:00Z');`);
    const marker = async () => (await database.query(
      "select last_notified from offline_notifications where client = 'offline-gate'")).rows[0].last_notified;
    await rpc(database, 'cfm_set_offline_notifications', {
      input_items: [{ client: 'offline-gate', enable: false }],
    });
    assert.equal(await marker(), null, 'disabling offline notifications clears the prior marker');
    await rpc(database, 'cfm_set_offline_notifications', {
      input_items: [{ client: 'offline-gate', enable: true }],
    });
    const claim = await rpc(database, 'cfm_claim_notification_delivery', {
      input_key: 'offline:offline-gate', input_event_id: 'synthetic-outage', input_now: '2026-09-09T00:00:00Z',
    });
    assert.equal(claim.claimed, true);
    assert.equal(await rpc(database, 'cfm_complete_notification_delivery', {
      input_key: 'offline:offline-gate', input_event_id: 'synthetic-outage', input_token: claim.token,
      input_success: true, input_now: '2026-09-09T00:00:01Z',
    }), true);
    const mark = input_time => rpc(database, 'cfm_mark_offline_notification_sent', {
      input_client: 'offline-gate', input_time, input_token: claim.token,
    });
    assert.equal(await mark('2026-09-09T00:00:01Z'), true);
    assert.equal((await marker()).toISOString(), '2026-09-09T00:00:01.000Z');
    assert.equal(await mark(''), true);
    assert.equal(await marker(), null,
      'confirmed recovery stores NULL, not an empty timestamp or the old outage marker');
  } finally { await database.close(); }
});
