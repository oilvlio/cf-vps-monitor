export async function snapshot(client) {
  const functions = (await client.query(`
    select
      n.nspname as schema,
      p.proname as name,
      pg_get_function_identity_arguments(p.oid) as args,
      pg_get_function_result(p.oid) as result,
      p.prosecdef as security_definer,
      p.provolatile as volatility,
      p.proisstrict as strict,
      p.prosrc as source,
      coalesce((
        select jsonb_agg(jsonb_build_object('grantee', pg_get_userbyid(a.grantee), 'privilege', a.privilege_type)
          order by pg_get_userbyid(a.grantee), a.privilege_type)
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee <> p.proowner
      ), '[]'::jsonb) as grants
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname in ('public', 'cfm_internal')
      and l.lanname in ('sql', 'plpgsql')
    order by n.nspname, p.proname, args
  `)).rows;

  const tables = (await client.query(`
    select
      n.nspname as schema,
      c.relname as name,
      c.relkind as kind,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced,
      pg_get_partkeydef(c.oid) as partition_key,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'identity', a.attidentity
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]'::jsonb) as columns
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'cfm_internal')
      and c.relkind in ('r', 'p')
      and not c.relispartition
    order by n.nspname, c.relname
  `)).rows;

  const indexes = (await client.query(`
    select n.nspname as schema, c.relname as table_name, i.relname as index_name,
      pg_get_indexdef(i.oid) as definition
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'cfm_internal')
      and c.relkind in ('r', 'p')
      and not c.relispartition
    order by n.nspname, c.relname, i.relname
  `)).rows;

  const constraints = (await client.query(`
    select n.nspname as schema, c.relname as table_name, con.conname as name,
      con.contype as type, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'cfm_internal')
      and c.relkind in ('r', 'p')
      and not c.relispartition
    order by n.nspname, c.relname, con.conname
  `)).rows;

  const policies = (await client.query(`
    select schemaname as schema, tablename as table_name, policyname as name,
      cmd, roles::text[] as roles, qual, with_check
    from pg_policies
    where schemaname in ('public', 'cfm_internal')
    order by schemaname, tablename, policyname
  `)).rows;

  const triggers = (await client.query(`
    select n.nspname as schema, c.relname as table_name, t.tgname as name,
      pg_get_triggerdef(t.oid) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'cfm_internal')
      and not t.tgisinternal
      and not c.relispartition
    order by n.nspname, c.relname, t.tgname
  `)).rows;

  const relations = (await client.query(`
    select n.nspname as schema, c.relname as name, c.relkind as kind,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
          'privilege', a.privilege_type, 'grantable', a.is_grantable
        ) order by a.grantee = 0, pg_get_userbyid(a.grantee), a.privilege_type)
        from aclexplode(coalesce(c.relacl,
          acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
        where a.grantee <> c.relowner
      ), '[]'::jsonb) as grants
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'cfm_internal')
      and c.relkind in ('r', 'p', 'S') and not c.relispartition
    order by n.nspname, c.relname
  `)).rows;
  return { functions, tables, indexes, constraints, policies, triggers, relations };
}
