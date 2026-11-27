import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApplicationMigrations, applyMigration, createTestDatabase } from '../../../../scripts/test-support/postgres.mjs';

async function unrelatedPrivileges(database) {
  const { rows } = await database.query(`
    select
      has_schema_privilege('anon', 'public', 'usage') as schema_usage,
      has_schema_privilege('authenticated', 'public', 'usage') as authenticated_schema_usage,
      has_table_privilege('anon', 'public.unrelated_application_data', 'select') as table_select,
      has_table_privilege('authenticated', 'public.unrelated_application_data', 'insert') as table_insert,
      has_function_privilege('anon', 'public.unrelated_application_value()', 'execute') as function_execute,
      has_sequence_privilege('anon', 'public.unrelated_application_sequence', 'usage') as sequence_usage,
      (select nspacl::text from pg_namespace where nspname = 'public') as schema_acl,
      (select jsonb_agg(jsonb_build_array(defaclrole, defaclnamespace, defaclobjtype, defaclacl::text)
        order by defaclrole, defaclnamespace, defaclobjtype) from pg_default_acl) as default_acls
  `);
  return rows[0];
}

test('AUD-09 installation preserves unrelated shared-schema access and defaults', async () => {
  const database = await createTestDatabase({ migrate: false });
  try {
    await database.exec(`
      create table public.unrelated_application_data (id integer primary key, value text);
      create sequence public.unrelated_application_sequence;
      create function public.unrelated_application_value() returns integer language sql as $$ select 42 $$;
      grant select on public.unrelated_application_data to anon;
      grant insert on public.unrelated_application_data to authenticated;
      grant usage on public.unrelated_application_sequence to anon;
      grant execute on function public.unrelated_application_value() to anon;
      alter default privileges in schema public grant select on tables to anon;
      alter default privileges in schema public grant execute on functions to authenticated;
    `);
    const before = await unrelatedPrivileges(database);
    assert.equal(before.table_select, true, 'fixture starts with a working unrelated app');
    await applyApplicationMigrations(database);
    const after = await unrelatedPrivileges(database);
    // This app may add its own role's schema USAGE; existing ACL entries must survive.
    assert.equal(after.schema_usage, true, 'installation must preserve anon schema usage');
    assert.equal(after.authenticated_schema_usage, true);
    assert.equal(after.table_select, true, 'installation must preserve unrelated SELECT');
    assert.equal(after.table_insert, true);
    assert.equal(after.function_execute, true);
    assert.equal(after.sequence_usage, true);
    assert.deepEqual(after.default_acls, before.default_acls, 'unrelated future objects keep their owner defaults');

    const appAccess = (await database.query(`
      select
        has_table_privilege('cf_monitor_app', 'public.unrelated_application_data', 'select') as unrelated_select,
        has_sequence_privilege('cf_monitor_app', 'public.unrelated_application_sequence', 'usage') as unrelated_sequence,
        has_table_privilege('anon', 'public.settings', 'select') as public_settings,
        (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname in ('clients','records',
          'host_rollup','ping_rollup',
          'users','login_rate_limits','settings','themes','theme_assets','ping_tasks',
          'ping_snapshots','offline_notifications',
          'expiry_notifications','load_notifications','audit_logs','ip_change_notifications') and c.relrowsecurity and c.relforcerowsecurity) as protected_tables,
        (select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname like 'cfm_%' and
          (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) as public_rpcs
    `)).rows[0];
    assert.deepEqual(appAccess, {
      unrelated_select: false, unrelated_sequence: false, public_settings: false,
      protected_tables: 16, public_rpcs: 0,
    });
    await applyMigration(database, '1_schema');
    await applyMigration(database, '2_functions');
    assert.deepEqual(await unrelatedPrivileges(database), after, 'repeat install preserves the same ACLs');
  } finally {
    await database.close();
  }
});
