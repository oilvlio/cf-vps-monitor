-- 函数（RPC）终态。一次性从真实 Postgres 目录生成，之后手工维护。
-- 每个函数仅保留一份定义；历史导出器已加防覆盖保护，不用于日常更新。
-- 结构在 1_schema.sql；不要在这里新增表/列 DDL。
set local search_path = public;

-- 旧版本安装残留的签名（旧目录减新目录）。逐个 drop 让升级安装与全新安装
-- 得到同一个函数目录；这些名字在终态里不再存在。
drop function if exists public.cfm_audit_logs_paged(integer, integer);
drop function if exists public.cfm_estimate_history_relation(regclass);
drop function if exists public.cfm_mark_client_token_used(text, text);
-- Superseded by cfm_build_rollup(family, now, max_buckets).
drop function if exists public.cfm_build_history_rollup(text);
drop function if exists public.cfm_build_ping_rollup(text, integer);
drop table if exists public.ping_rollup_state cascade;
-- 生命周期统一走 cfm_partition_maintain；下面这些按行删除与独立 prune 入口退役。
drop function if exists public.cfm_delete_old_records(text, integer);
drop function if exists public.cfm_delete_old_ping_records(text, integer);
drop function if exists public.cfm_delete_old_ping_rollup(text, integer);
drop function if exists public.cfm_expired_row_counts(text, text, text);
drop function if exists public.cfm_expired_row_counts(text, text, text, text);
drop function if exists public.cfm_ensure_ping_time_partitions(integer);
drop function if exists public.cfm_ensure_history_time_partitions(integer);
drop function if exists public.cfm_prune_ping_time_partitions(timestamp with time zone, timestamp with time zone);
drop function if exists public.cfm_prune_history_time_partitions(timestamp with time zone);
drop function if exists public.cfm_history_storage_usage();
drop function if exists public.cfm_bounded_storage_row_counts(integer);
-- GPU history is retired; drop its RPCs so an upgraded install converges.
drop function if exists public.cfm_insert_gpu_snapshot(text, text, jsonb);
drop function if exists public.cfm_gpu_records(text, text, text, integer);
drop function if exists public.cfm_gpu_records_paged(text, text, text, integer, integer);
drop function if exists public.cfm_gpu_records_cursor(text, text, text, text, integer);
drop function if exists public.cfm_gpu_rollup_range(text, text, text);
-- Backup/restore was removed from the product; drop its RPCs so upgrades converge.
drop function if exists public.cfm_backup_configuration_snapshot();
drop function if exists public.cfm_restore_backup_data(jsonb);

CREATE OR REPLACE FUNCTION public.cfm_public_settings()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from settings;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_settings_by_keys(input_keys text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from settings
  where key = any(coalesce(input_keys, array[]::text[]));
$function$;

CREATE OR REPLACE FUNCTION public.cfm_set_settings(input_settings jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if input_settings is null or jsonb_typeof(input_settings) <> 'object' then
    raise exception 'input_settings must be a JSON object';
  end if;

  insert into settings (key, value)
  select key, value
  from jsonb_each_text(input_settings)
  on conflict (key) do update set value = excluded.value;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_public_clients()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select
      uuid, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, traffic_reset_day, sort_order, created_at, updated_at
    from clients
    order by sort_order asc, lower(name) asc, created_at asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_admin_clients()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select
      uuid, ''::text as token, ''::text as token_hash,
      token_last_used_at, token_last_used_ip, token_rotated_at,
      name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, traffic_reset_day, sort_order, created_at, updated_at
    from clients
    order by sort_order asc, lower(name) asc, created_at asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_scheduled_clients()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'uuid', uuid,
      'name', name,
      'created_at', created_at,
      'expired_at', expired_at
    )
    order by sort_order asc, lower(name) asc, created_at asc
  ), '[]'::jsonb)
  from (
    select uuid, name, created_at, expired_at, sort_order
    from clients
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_scheduled_clients_by_ids(input_uuids jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ids as (
    select distinct on (uuid) uuid, ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    order by uuid, ord
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by ids.ord), '[]'::jsonb)
  from ids
  join lateral (
    select uuid, name, created_at, expired_at
    from clients
    where clients.uuid = ids.uuid
  ) row_data on true;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client(input_uuid text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client_token_meta(input_uuid text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, coalesce(token_hash, '') as token_hash, name
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_clients_by_ids(input_uuids jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ids as (
    select distinct on (uuid) uuid, ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    order by uuid, ord
  )
  select coalesce(jsonb_agg(to_jsonb(c) order by ids.ord), '[]'::jsonb)
  from ids
  join clients c on c.uuid = ids.uuid;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client_ids()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(uuid), '[]'::jsonb)
  from clients;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_agent_client_by_token(input_token_hash text, input_token text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client_token_exists(input_token_hash text, input_token text DEFAULT ''::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  );
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client_create_conflict(input_uuid text, input_token_hash text, input_token text DEFAULT ''::text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when exists (select 1 from clients where uuid = input_uuid) then 'uuid'
    when exists (
      select 1
      from clients
      where token_hash = input_token_hash
         or (coalesce(input_token, '') <> '' and token = input_token)
    ) then 'token'
    else null
  end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_create_client(input_client jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  insert into clients (
    uuid, token, token_hash, token_rotated_at, name, sort_order,
    traffic_limit_type, traffic_reset_day
  )
  values (
    coalesce(nullif(input_client->>'uuid', ''), gen_random_uuid()::text),
    input_client->>'token',
    input_client->>'token_hash',
    now(),
    coalesce(input_client->>'name', ''),
    coalesce((input_client->>'sort_order')::integer, (select coalesce(max(sort_order), 0) + 1 from clients)),
    coalesce(nullif(input_client->>'traffic_limit_type', ''), 'sum'),
    least(greatest(coalesce((input_client->>'traffic_reset_day')::smallint, 1), 1), 31)
  )
  returning to_jsonb(clients);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_agent_client_identity_by_token(input_token_hash text, input_token text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, token_last_used_ip, token_rotated_at, created_at, name, hidden
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_mark_client_token_used(input_uuid text, input_ip text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  target_uuid text;
  previous_value text;
  updated_count integer;
  normalized_ip text := left(coalesce(trim(input_ip), ''), 128);
begin
  -- 在同一个事务内锁定并读取更新前的 IP，作为来源 IP 变化的权威「旧值」。
  -- 节流窗口（15 分钟）内不更新，直接返回 updated=false，previous_ip 无意义。
  select uuid, token_last_used_ip
    into target_uuid, previous_value
  from clients
  where uuid = input_uuid
    and (
      token_last_used_at is null
      or token_last_used_at < now() - interval '15 minutes'
    )
  for update;

  if target_uuid is null then
    return jsonb_build_object('updated', false, 'previous_ip', null);
  end if;

  update clients
  set token_last_used_at = now(),
      token_last_used_ip = case when normalized_ip <> '' then normalized_ip else token_last_used_ip end
  where uuid = input_uuid;
  get diagnostics updated_count = row_count;

  return jsonb_build_object(
    'updated', updated_count > 0,
    'previous_ip', nullif(previous_value, '')
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_rotate_client_token(input_uuid text, input_token text, input_token_hash text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update clients
  set token = input_token,
      token_hash = input_token_hash,
      token_last_used_at = null,
      token_last_used_ip = '',
      token_rotated_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(clients);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_client_returning(input_uuid text, input_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  row_data clients%rowtype;
begin
  if input_patch is null or jsonb_typeof(input_patch) <> 'object' then
    return null;
  end if;

  update clients
  set
    name = case when input_patch ? 'name' then coalesce(input_patch->>'name', '') else name end,
    cpu_name = case when input_patch ? 'cpu_name' then coalesce(input_patch->>'cpu_name', '') else cpu_name end,
    virtualization = case when input_patch ? 'virtualization' then coalesce(input_patch->>'virtualization', '') else virtualization end,
    arch = case when input_patch ? 'arch' then coalesce(input_patch->>'arch', '') else arch end,
    cpu_cores = case when input_patch ? 'cpu_cores' then coalesce((input_patch->>'cpu_cores')::integer, 0) else cpu_cores end,
    os = case when input_patch ? 'os' then coalesce(input_patch->>'os', '') else os end,
    kernel_version = case when input_patch ? 'kernel_version' then coalesce(input_patch->>'kernel_version', '') else kernel_version end,
    gpu_name = case when input_patch ? 'gpu_name' then coalesce(input_patch->>'gpu_name', '') else gpu_name end,
    ipv4 = case when input_patch ? 'ipv4' then coalesce(input_patch->>'ipv4', '') else ipv4 end,
    ipv6 = case when input_patch ? 'ipv6' then coalesce(input_patch->>'ipv6', '') else ipv6 end,
    region = case when input_patch ? 'region' then coalesce(input_patch->>'region', '') else region end,
    remark = case when input_patch ? 'remark' then coalesce(input_patch->>'remark', '') else remark end,
    public_remark = case when input_patch ? 'public_remark' then coalesce(input_patch->>'public_remark', '') else public_remark end,
    mem_total = case when input_patch ? 'mem_total' then coalesce((input_patch->>'mem_total')::double precision, 0) else mem_total end,
    swap_total = case when input_patch ? 'swap_total' then coalesce((input_patch->>'swap_total')::double precision, 0) else swap_total end,
    disk_total = case when input_patch ? 'disk_total' then coalesce((input_patch->>'disk_total')::double precision, 0) else disk_total end,
    version = case when input_patch ? 'version' then coalesce(input_patch->>'version', '') else version end,
    price = case when input_patch ? 'price' then coalesce((input_patch->>'price')::double precision, 0) else price end,
    billing_cycle = case when input_patch ? 'billing_cycle' then coalesce((input_patch->>'billing_cycle')::smallint, 0) else billing_cycle end,
    auto_renewal = case when input_patch ? 'auto_renewal' then case when lower(coalesce(input_patch->>'auto_renewal', '')) in ('true', '1') then 1 else 0 end else auto_renewal end,
    currency = case when input_patch ? 'currency' then coalesce(input_patch->>'currency', '$') else currency end,
    expired_at = case when input_patch ? 'expired_at' then nullif(input_patch->>'expired_at', '')::timestamptz else expired_at end,
    "group" = case when input_patch ? 'group' then coalesce(input_patch->>'group', '') else "group" end,
    tags = case when input_patch ? 'tags' then coalesce(input_patch->>'tags', '') else tags end,
    hidden = case when input_patch ? 'hidden' then case when lower(coalesce(input_patch->>'hidden', '')) in ('true', '1') then 1 else 0 end else hidden end,
    traffic_limit = case when input_patch ? 'traffic_limit' then coalesce((input_patch->>'traffic_limit')::bigint, 0) else traffic_limit end,
    traffic_limit_type = case when input_patch ? 'traffic_limit_type' then coalesce(input_patch->>'traffic_limit_type', 'sum') else traffic_limit_type end,
    traffic_reset_day = case when input_patch ? 'traffic_reset_day'
      then least(greatest(coalesce((input_patch->>'traffic_reset_day')::smallint, 1), 1), 31)
      else traffic_reset_day end,
    sort_order = case when input_patch ? 'sort_order' then coalesce((input_patch->>'sort_order')::integer, 0) else sort_order end,
    updated_at = now()
  where uuid = input_uuid
  returning * into row_data;

  if not found then
    return null;
  end if;
  return to_jsonb(row_data);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_client(input_uuid text, input_patch jsonb)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select public.cfm_update_client_returning(input_uuid, input_patch) is not null;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_delete_clients(input_uuids jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  ids text[];
  removed integer := 0;
  host_deleted integer := 0;
  ping_deleted integer := 0;
  dirty_deleted integer := 0;
begin
  select coalesce(array_agg(distinct trim(item)), array[]::text[])
  into ids
  from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) item
  where trim(item) <> '';

  if coalesce(array_length(ids, 1), 0) = 0 then
    return jsonb_build_object(
      'removed', 0,
      'deleted_records', jsonb_build_object(
        'host_rollup', 0, 'ping_rollup', 0, 'rollup_dirty', 0
      )
    );
  end if;

  -- Delete the parent first. That statement waits for any in-flight rollup
  -- holding a KEY SHARE lock on these clients, so the dependent deletes below
  -- run with a fresh snapshot and remove the rows that rollup just committed.
  delete from clients where uuid = any(ids);
  get diagnostics removed = row_count;

  delete from host_rollup where client = any(ids);
  get diagnostics host_deleted = row_count;

  delete from ping_rollup where client = any(ids);
  get diagnostics ping_deleted = row_count;

  delete from cfm_internal.rollup_dirty where client = any(ids);
  get diagnostics dirty_deleted = row_count;

  return jsonb_build_object(
    'removed', removed,
    'deleted_records', jsonb_build_object(
      'host_rollup', host_deleted,
      'ping_rollup', ping_deleted,
      'rollup_dirty', dirty_deleted
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_prune_client_references(input_uuids jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  remove_ids text[] := '{}';
  ping_tasks_updated integer := 0;
  load_notifications_updated integer := 0;
  load_notifications_deleted integer := 0;
  expiry_notifications_deleted integer := 0;
begin
  select coalesce(array_agg(distinct trim(uuid)), '{}')
  into remove_ids
  from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
  where trim(uuid) <> '';

  if array_length(remove_ids, 1) is null then
    return jsonb_build_object(
      'ping_tasks_updated', 0,
      'load_notifications_updated', 0,
      'load_notifications_deleted', 0,
      'expiry_notifications_deleted', 0
    );
  end if;

  with candidates as (
    select p.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(p.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from ping_tasks p
    where p.all_clients = 0
      and exists (
        select 1
        from jsonb_array_elements_text(p.clients) as item(client)
        where client = any(remove_ids)
      )
  ), updated as (
    update ping_tasks p
    set clients = candidates.next_clients
    from candidates
    where p.id = candidates.id
      and p.clients is distinct from candidates.next_clients
    returning 1
  )
  select count(*)::integer into ping_tasks_updated from updated;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from load_notifications l
    where exists (
      select 1
      from jsonb_array_elements_text(l.clients) as item(client)
      where client = any(remove_ids)
    )
  ), deleted as (
    delete from load_notifications l
    using candidates
    where l.id = candidates.id
      and jsonb_array_length(candidates.next_clients) = 0
    returning 1
  )
  select count(*)::integer into load_notifications_deleted from deleted;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from load_notifications l
    where exists (
      select 1
      from jsonb_array_elements_text(l.clients) as item(client)
      where client = any(remove_ids)
    )
  ), updated as (
    update load_notifications l
    set clients = candidates.next_clients
    from candidates
    where l.id = candidates.id
      and jsonb_array_length(candidates.next_clients) > 0
      and l.clients is distinct from candidates.next_clients
    returning 1
  )
  select count(*)::integer into load_notifications_updated from updated;

  delete from expiry_notifications
  where client = any(remove_ids);
  get diagnostics expiry_notifications_deleted = row_count;

  return jsonb_build_object(
    'ping_tasks_updated', ping_tasks_updated,
    'load_notifications_updated', load_notifications_updated,
    'load_notifications_deleted', load_notifications_deleted,
    'expiry_notifications_deleted', expiry_notifications_deleted
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_cleanup_orphan_client_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  ping_tasks_updated integer := 0;
  load_notifications_updated integer := 0;
  load_notifications_deleted integer := 0;
  offline_notifications_deleted integer := 0;
  expiry_notifications_deleted integer := 0;
  host_rollup_deleted integer := 0;
  ping_rollup_deleted integer := 0;
  dirty_deleted integer := 0;
begin
  with candidates as (
    select p.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(p.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from ping_tasks p
    where p.all_clients = 0
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from ping_tasks where ping_tasks.id = candidates.id))
    )
  ), updated as (
    update ping_tasks p
    set clients = changed.next_clients
    from changed
    where p.id = changed.id
    returning 1
  )
  select count(*)::integer into ping_tasks_updated from updated;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from load_notifications l
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from load_notifications where load_notifications.id = candidates.id))
    )
  ), deleted as (
    delete from load_notifications l
    using changed
    where l.id = changed.id and jsonb_array_length(changed.next_clients) = 0
    returning 1
  )
  select count(*)::integer into load_notifications_deleted from deleted;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from load_notifications l
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from load_notifications where load_notifications.id = candidates.id))
    )
  ), updated as (
    update load_notifications l
    set clients = changed.next_clients
    from changed
    where l.id = changed.id and jsonb_array_length(changed.next_clients) > 0
    returning 1
  )
  select count(*)::integer into load_notifications_updated from updated;

  delete from offline_notifications o where not exists (select 1 from clients c where c.uuid = o.client);
  get diagnostics offline_notifications_deleted = row_count;

  delete from expiry_notifications e where not exists (select 1 from clients c where c.uuid = e.client);
  get diagnostics expiry_notifications_deleted = row_count;

  delete from host_rollup h where not exists (select 1 from clients c where c.uuid = h.client);
  get diagnostics host_rollup_deleted = row_count;

  delete from ping_rollup r
  where not exists (select 1 from clients c where c.uuid = r.client)
     or not exists (select 1 from ping_tasks t where t.id = r.task_id);
  get diagnostics ping_rollup_deleted = row_count;

  delete from cfm_internal.rollup_dirty d
  where not exists (select 1 from clients c where c.uuid = d.client)
     or (d.family = 'ping' and not exists (select 1 from ping_tasks t where t.id = d.task_id));
  get diagnostics dirty_deleted = row_count;

  return jsonb_build_object(
    'ping_tasks_updated', ping_tasks_updated,
    'load_notifications_updated', load_notifications_updated,
    'load_notifications_deleted', load_notifications_deleted,
    'expiry_notifications_deleted', expiry_notifications_deleted,
    'offline_notifications_deleted', offline_notifications_deleted,
    'host_rollup_deleted', host_rollup_deleted,
    'ping_rollup_deleted', ping_rollup_deleted,
    'rollup_dirty_deleted', dirty_deleted
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_clients_hidden(input_uuids jsonb, input_hidden boolean)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with
    ids as (
      select distinct uuid
      from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
      where trim(uuid) <> ''
    ),
    updated as (
      update clients
      set hidden = case when input_hidden then 1 else 0 end,
          updated_at = now()
      where uuid in (select uuid from ids)
        and hidden is distinct from case when input_hidden then 1 else 0 end
      returning uuid
    )
  select count(*)::integer from updated;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_reorder_clients(input_uuids jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  input_count integer;
  existing_count integer;
  updated_count integer;
begin
  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  )
  select count(*) into input_count from input_order;
  if input_count = 0 then
    return 0;
  end if;

  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  )
  select count(*) into existing_count
  from clients c
  join input_order i on i.uuid = c.uuid;
  if existing_count <> input_count then
    raise exception 'Client uuid does not exist';
  end if;

  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  ),
  final_order as (
    select uuid, ord as sort_order
    from input_order
    union all
    select c.uuid, (input_count + row_number() over (order by c.sort_order asc, lower(c.name) asc, c.created_at asc))::integer
    from clients c
    where not exists (select 1 from input_order i where i.uuid = c.uuid)
  ),
  updated as (
    update clients c
    set sort_order = f.sort_order,
        updated_at = now()
    from final_order f
    where c.uuid = f.uuid
      and c.sort_order is distinct from f.sort_order
    returning c.uuid
  )
  select count(*) into updated_count from updated;

  return updated_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_client_capacity_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'clients', count(*)::integer,
    'gpu_clients', coalesce(sum(case when trim(coalesce(gpu_name, '')) <> '' then 1 else 0 end), 0)::integer
  )
  from clients;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_task_estimate_rows()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by sort_order asc, id asc), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, interval_sec, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_create_ping_task(input_task jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, timeout_ms, sort_order)
  values (
    coalesce(input_task->>'name', ''),
    case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else '[]'::jsonb end,
    case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end,
    coalesce(input_task->>'type', 'icmp'),
    coalesce(input_task->>'target', ''),
    coalesce((input_task->>'interval_sec')::integer, 60),
    least(greatest(coalesce((input_task->>'timeout_ms')::integer, 3000), 100), 5000),
    coalesce(nullif((input_task->>'sort_order')::integer, 0), (select coalesce(max(sort_order), 0) + 1 from ping_tasks))
  )
  returning to_jsonb(ping_tasks.*);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_ping_task(input_id integer, input_task jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update ping_tasks
  set
    name = coalesce(input_task->>'name', name),
    clients = case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else clients end,
    all_clients = case when input_task ? 'all_clients' then case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end else all_clients end,
    type = coalesce(input_task->>'type', type),
    target = coalesce(input_task->>'target', target),
    interval_sec = coalesce((input_task->>'interval_sec')::integer, interval_sec),
    timeout_ms = least(greatest(coalesce((input_task->>'timeout_ms')::integer, timeout_ms), 100), 5000)
  where id = input_id
  returning to_jsonb(ping_tasks.*);
$function$;

-- 返回所有节点级超时覆盖（task_id + client -> timeout_ms）。
-- 没有覆盖的节点—任务组合不出现在结果里，Worker 会回退到任务默认 timeout_ms。
CREATE OR REPLACE FUNCTION public.cfm_ping_task_client_timeouts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by task_id asc, client asc), '[]'::jsonb)
  from (
    select task_id, client, timeout_ms
    from ping_task_client_timeouts
  ) row_data;
$function$;

-- 设置或清除单个节点—任务的超时覆盖。input_timeout_ms 为 null 时删除覆盖。
CREATE OR REPLACE FUNCTION public.cfm_set_ping_task_client_timeout(
  input_task_id bigint,
  input_client text,
  input_timeout_ms integer
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  client_id text := nullif(trim(input_client), '');
begin
  if input_task_id is null or input_task_id <= 0 or client_id is null then
    raise exception 'invalid ping task timeout target' using errcode = '22023';
  end if;

  if input_timeout_ms is null then
    delete from ping_task_client_timeouts
    where task_id = input_task_id and client = client_id;
  else
    insert into ping_task_client_timeouts(task_id, client, timeout_ms)
    values (input_task_id, client_id, least(greatest(input_timeout_ms, 100), 5000))
    on conflict (task_id, client) do update set timeout_ms = excluded.timeout_ms;
  end if;

  return jsonb_build_object(
    'task_id', input_task_id,
    'client', client_id,
    'timeout_ms', case when input_timeout_ms is null then null else least(greatest(input_timeout_ms, 100), 5000) end
  );
end;
$function$;

-- Apply one editor delta and its timeout overrides in a single transaction.
-- Lock current task rows in ID order; never write a membership array read by a Worker.
CREATE OR REPLACE FUNCTION public.cfm_set_client_ping_assignment(
  input_client text, input_desired jsonb, input_base jsonb, input_timeouts jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  desired bigint[];
  base bigint[];
  changed_ids bigint[];
  target_ids bigint[];
  task ping_tasks%rowtype;
  timeout_item jsonb;
  updated jsonb := '[]'::jsonb;
  timeout_count integer := 0;
  task_id bigint;
begin
  if input_client is null or trim(input_client) = ''
    or jsonb_typeof(input_desired) is distinct from 'array'
    or jsonb_typeof(input_base) is distinct from 'array'
    or jsonb_typeof(input_timeouts) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'status', 400, 'error', '任务列表格式不对');
  end if;
  select coalesce(array_agg(distinct value::bigint), '{}'::bigint[]) into desired from jsonb_array_elements_text(input_desired);
  select coalesce(array_agg(distinct value::bigint), '{}'::bigint[]) into base from jsonb_array_elements_text(input_base);
  select coalesce(array_agg(id), '{}'::bigint[]) into changed_ids from (
    (select unnest(desired) as id except select unnest(base))
    union (select unnest(base) except select unnest(desired))
  ) delta;
  if cardinality(changed_ids) > 40 then
    return jsonb_build_object('ok', false, 'status', 400, 'error', '一次最多调整 40 个任务');
  end if;

  perform 1 from clients where uuid = input_client for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 404, 'error', '服务器不存在，可能已被删除');
  end if;
  select coalesce(array_agg(distinct id), '{}'::bigint[]) into target_ids from (
    select unnest(changed_ids) as id
    union select (value->>'task_id')::bigint from jsonb_array_elements(input_timeouts)
  ) targets;
  perform id from ping_tasks where id = any(target_ids) order by id for update;

  -- Validate the complete request before changing any row.
  foreach task_id in array changed_ids loop
    select * into task from ping_tasks where id = task_id;
    if not found then
      if task_id = any(desired) then
        return jsonb_build_object('ok', false, 'status', 400, 'error', '有任务已被删除，请刷新后重试');
      end if;
      continue;
    end if;
    if task.all_clients <> 0 then
      return jsonb_build_object('ok', false, 'status', 400, 'error', '全局任务不能按服务器调整');
    end if;
    if task_id = any(desired) and not (task.clients ? input_client) and jsonb_array_length(task.clients) >= 500 then
      return jsonb_build_object('ok', false, 'status', 400, 'error', '任务最多绑定 500 台服务器');
    end if;
  end loop;
  for timeout_item in select value from jsonb_array_elements(input_timeouts) loop
    select * into task from ping_tasks where id = (timeout_item->>'task_id')::bigint;
    if not found or not (task.id = any(desired) or task.all_clients <> 0 or task.clients ? input_client) then
      return jsonb_build_object('ok', false, 'status', 400, 'error', 'Ping 任务不属于当前服务器');
    end if;
    if not (timeout_item ? 'timeout_ms') or (timeout_item->'timeout_ms' <> 'null'::jsonb
      and ((timeout_item->>'timeout_ms')::integer not between 100 and 5000)) then
      return jsonb_build_object('ok', false, 'status', 400, 'error', '超时设置格式不对');
    end if;
  end loop;

  for task in select * from ping_tasks where id = any(changed_ids) order by id loop
    if task.id = any(desired) and not (task.clients ? input_client) then
      update ping_tasks set clients = clients || jsonb_build_array(input_client) where id = task.id returning * into task;
      updated := updated || jsonb_build_array(to_jsonb(task));
    elsif not (task.id = any(desired)) and task.clients ? input_client then
      update ping_tasks set clients = clients - input_client where id = task.id returning * into task;
      updated := updated || jsonb_build_array(to_jsonb(task));
    end if;
  end loop;
  for timeout_item in select value from jsonb_array_elements(input_timeouts) loop
    perform cfm_set_ping_task_client_timeout((timeout_item->>'task_id')::bigint, input_client, (timeout_item->>'timeout_ms')::integer);
    timeout_count := timeout_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'tasks', updated, 'timeouts', timeout_count);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_reorder_ping_tasks(input_ids jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  input_id integer;
  final_id integer;
  final_ids integer[] := '{}';
  changed_count integer := 0;
  next_order integer := 1;
  old_order integer;
begin
  -- 必须按传入顺序取值：DISTINCT 不保证保序（实际会被改写成按 id 升序，导致手动排序「保存后又回退」），
  -- 因此用 WITH ORDINALITY + ORDER BY ord 取原顺序，再在循环里去重（保留首次出现的位置）。
  for input_id in
    select value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) with ordinality as item(value, ord)
    where value ~ '^[0-9]+$' and value::integer > 0
    order by ord
  loop
    if not (input_id = any(final_ids)) then
      final_ids := array_append(final_ids, input_id);
    end if;
  end loop;

  if cardinality(final_ids) = 0 then
    return 0;
  end if;

  if exists (
    select 1
    from unnest(final_ids) id
    where not exists (select 1 from ping_tasks where ping_tasks.id = id)
  ) then
    raise exception 'Ping task id does not exist';
  end if;

  for final_id in
    select id
    from ping_tasks
    where not (id = any(final_ids))
    order by sort_order asc, id asc
  loop
    final_ids := array_append(final_ids, final_id);
  end loop;

  foreach final_id in array final_ids loop
    select sort_order into old_order from ping_tasks where id = final_id;
    if old_order is distinct from next_order then
      update ping_tasks set sort_order = next_order where id = final_id;
      changed_count := changed_count + 1;
    end if;
    next_order := next_order + 1;
  end loop;

  return changed_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_delete_ping_task(input_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  removed jsonb;
begin
  -- Parent first: waits for an in-flight rollup holding KEY SHARE, so the
  -- dependent deletes below see and remove the rows it committed.
  delete from public.ping_tasks where id = input_id returning to_jsonb(ping_tasks.*) into removed;

  delete from public.ping_rollup where task_id = input_id;
  delete from cfm_internal.rollup_dirty where family = 'ping' and task_id = input_id;

  return removed;
end;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.ensure_partition_policies()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Drop rows whose relation disappeared or became a child partition. This
  -- keeps the policy table correct when an earlier migration replaces a heap
  -- with a partitioned parent under the same name.
  delete from cfm_internal.partition_policy pp
  where not exists (select 1 from pg_class c where c.oid = pp.parent)
     or exists (select 1 from pg_inherits i where i.inhrelid = pp.parent);

  insert into cfm_internal.partition_policy(parent, grain, runway_days, retention_key, gate_family)
  select to_regclass(v.name), v.grain, v.runway_days, v.retention_key, v.gate_family
  from (values
    ('public.records', 'day', 2, 'record_preserve_time', 'host'),
    ('public.ping_snapshots', 'day', 2, 'ping_record_preserve_time', 'ping'),
    ('public.host_rollup', 'week', 14, 'rollup_preserve_time', null),
    ('public.ping_rollup', 'week', 14, 'rollup_preserve_time', null)
  ) as v(name, grain, runway_days, retention_key, gate_family)
  where to_regclass(v.name) is not null
  on conflict (parent) do nothing;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.setting_hours(input_key text, input_default integer, input_min integer, input_max integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select least(greatest(
    coalesce((
      select case when value ~ '^[0-9]{1,7}$' then value::integer end
      from public.settings
      where key = input_key
    ), input_default),
    input_min
  ), input_max);
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.retention_hours(input_key text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when input_key = 'rollup_preserve_time'
      then cfm_internal.setting_hours('rollup_preserve_time', 2160, 168, 8760)
    else cfm_internal.setting_hours(coalesce(input_key, 'record_preserve_time'), 168, 48, 720)
  end;
$function$;

-- Reads are split at the raw retention boundary: raw is authoritative for
-- `time >= now - R_raw`, rollups for anything older. Align to the 30-minute
-- base bucket so a read bucket never straddles the two sources.
CREATE OR REPLACE FUNCTION cfm_internal.read_raw_from(p_retention_key text, p_start timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  select greatest(
    coalesce(p_start, '-infinity'::timestamptz),
    date_bin(
      interval '30 minutes',
      now() - make_interval(hours => cfm_internal.retention_hours(p_retention_key)),
      timestamptz '1970-01-01'
    )
  );
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.partition_children(input_parent regclass)
 RETURNS TABLE(relname text, range_start timestamp with time zone, range_end timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  select
    c.relname,
    (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\)'))[1]::timestamptz,
    (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz
  from pg_inherits i
  join pg_class c on c.oid = i.inhrelid
  where i.inhparent = input_parent
  order by 2 nulls first, 1;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_partition_maintain(input_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  policy record;
  retention_hours integer;
  horizon timestamptz;
  target timestamptz;
  frontier timestamptz;
  cursor_ts timestamptz;
  step interval;
  child_name text;
  parent_name text;
  created integer := 0;
  dropped integer := 0;
  pending integer := 0;
  skipped integer := 0;
  lock_timeouts integer := 0;
  dropped_by_parent jsonb := '{}'::jsonb;
  watermark timestamptz;
  previous_lock_timeout text := current_setting('lock_timeout');
begin
  perform cfm_internal.ensure_partition_policies();

  if not pg_try_advisory_xact_lock(hashtext('cfm_partition_maintain')) then
    return jsonb_build_object('created', 0, 'dropped', 0, 'pending', 0, 'skipped', 0, 'locked', true);
  end if;

  perform set_config('lock_timeout', '5s', true);

  for policy in select * from cfm_internal.partition_policy order by parent::text loop
    if (select relkind from pg_class where oid = policy.parent) is distinct from 'p' then
      skipped := skipped + 1;
      continue;
    end if;

    begin
      retention_hours := cfm_internal.retention_hours(policy.retention_key);
      step := case policy.grain when 'week' then interval '7 days' else interval '1 day' end;
      horizon := input_now - make_interval(hours => retention_hours);
      target := input_now + make_interval(days => policy.runway_days);
      parent_name := format('%s.%s',
        (select n.nspname from pg_namespace n join pg_class c on c.relnamespace = n.oid where c.oid = policy.parent),
        (select c.relname from pg_class c where c.oid = policy.parent));

      select max(pc.range_end) into frontier
      from cfm_internal.partition_children(policy.parent) pc;

      if frontier is null or frontier <= horizon then
        cursor_ts := date_trunc(policy.grain, horizon, 'UTC');
      else
        cursor_ts := frontier;
      end if;

      while cursor_ts < target loop
        if exists (
          select 1
          from cfm_internal.partition_children(policy.parent) pc
          where pc.range_start is not null
            and pc.range_start < cursor_ts + step
            and pc.range_end > cursor_ts
        ) then
          cursor_ts := cursor_ts + step;
          skipped := skipped + 1;
          continue;
        end if;

        child_name := regexp_replace(parent_name, '^.*\.', '')
          || '_' || to_char(cursor_ts at time zone 'UTC', 'YYYYMMDD');
        begin
          execute format(
            'create table if not exists public.%I partition of %s for values from (%L) to (%L)',
            child_name, policy.parent, cursor_ts, cursor_ts + step
          );
          created := created + 1;
        exception when duplicate_table then
          null;
        end;
        cursor_ts := cursor_ts + step;
      end loop;

      for child_name in
        select pc.relname
        from cfm_internal.partition_children(policy.parent) pc
        where pc.range_end is not null and pc.range_end <= horizon
        order by pc.range_end
      loop
        if policy.gate_family is not null then
          select rs.watermark into watermark
          from cfm_internal.rollup_state rs
          where rs.family = policy.gate_family;

          if watermark is null or (watermark - policy.gate_lag) < (
            select pc.range_end
            from cfm_internal.partition_children(policy.parent) pc
            where pc.relname = child_name
          ) then
            continue;
          end if;
        end if;

        begin
          execute format('drop table public.%I', child_name);
          dropped := dropped + 1;
          dropped_by_parent := jsonb_set(dropped_by_parent, array[parent_name],
            to_jsonb(coalesce((dropped_by_parent->>parent_name)::integer, 0) + 1));
        exception
          when lock_not_available then
            pending := pending + 1;
            lock_timeouts := lock_timeouts + 1;
          when undefined_table then null;
        end;
      end loop;

      -- A MINVALUE child means "no lower bound"; a MAXVALUE child means "no
      -- upper bound". min()/max() would silently skip the NULL and turn an open
      -- bound into a closed one, so track it explicitly.
      insert into cfm_internal.partition_bounds(parent, min_start, max_end, updated_at)
      select
        policy.parent,
        case when bool_or(pc.range_start is null) then null else min(pc.range_start) end,
        case when bool_or(pc.range_end is null) then null else max(pc.range_end) end,
        input_now
      from cfm_internal.partition_children(policy.parent) pc
      on conflict (parent) do update
        set min_start = excluded.min_start,
            max_end = excluded.max_end,
            updated_at = excluded.updated_at;
    exception
      when lock_not_available then
        pending := pending + 1;
        lock_timeouts := lock_timeouts + 1;
    end;
  end loop;

  perform set_config('lock_timeout', previous_lock_timeout, true);

  insert into cfm_internal.partition_maintenance_state(
    singleton, updated_at, pending_partitions, lock_timeouts
  ) values (true, input_now, pending, lock_timeouts)
  on conflict (singleton) do update set
    updated_at = excluded.updated_at,
    pending_partitions = excluded.pending_partitions,
    lock_timeouts = excluded.lock_timeouts;

  return jsonb_build_object(
    'created', created,
    'dropped', dropped,
    'dropped_by_parent', dropped_by_parent,
    'pending', pending,
    'skipped', skipped,
    'locked', false
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_history_maintenance_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  with clock as (
    select statement_timestamp() as at
  ), rollup_families(family) as (
    values ('host'::text), ('ping'::text)
  ), dirty as (
    select family, count(*)::bigint as dirty_buckets, min(queued_at) as oldest_dirty_at
    from cfm_internal.rollup_dirty
    group by family
  ), rollups as (
    select coalesce(jsonb_object_agg(f.family, jsonb_build_object(
      'watermark', rs.watermark,
      'lag_seconds', case when rs.watermark is null then null
        else greatest(0, floor(extract(epoch from (c.at - rs.watermark))))::bigint end,
      'dirty_buckets', coalesce(d.dirty_buckets, 0),
      'oldest_dirty_at', d.oldest_dirty_at,
      'oldest_dirty_age_seconds', case when d.oldest_dirty_at is null then null
        else greatest(0, floor(extract(epoch from (c.at - d.oldest_dirty_at))))::bigint end
    )), '{}'::jsonb) as value
    from rollup_families f
    cross join clock c
    left join cfm_internal.rollup_state rs on rs.family = f.family
    left join dirty d on d.family = f.family
  ), partitions as (
    select coalesce(jsonb_object_agg(format('%I.%I', pn.nspname, pc.relname), jsonb_build_object(
      'min_start', pb.min_start,
      'max_end', pb.max_end,
      'runway_seconds', case when pb.max_end is null then null
        else floor(extract(epoch from (pb.max_end - c.at)))::bigint end,
      'gate_family', pp.gate_family,
      'gate_watermark', rs.watermark,
      'gate_clearance_seconds', case when pp.gate_family is null or rs.watermark is null or pb.max_end is null then null
        else floor(extract(epoch from (rs.watermark - pp.gate_lag - pb.max_end)))::bigint end
    )), '{}'::jsonb) as value
    from cfm_internal.partition_policy pp
    join pg_class pc on pc.oid = pp.parent
    join pg_namespace pn on pn.oid = pc.relnamespace
    cross join clock c
    left join cfm_internal.partition_bounds pb on pb.parent = pp.parent
    left join cfm_internal.rollup_state rs on rs.family = pp.gate_family
  ), maintenance as (
    select jsonb_build_object(
      'updated_at', s.updated_at,
      'pending_partitions', coalesce(s.pending_partitions, 0),
      'lock_timeouts', coalesce(s.lock_timeouts, 0)
    ) as value
    from (select 1) singleton
    left join cfm_internal.partition_maintenance_state s on s.singleton
  )
  select jsonb_build_object(
    'checked_at', c.at,
    'rollups', r.value,
    'partitions', p.value,
    'partition_maintenance', m.value
  )
  from clock c cross join rollups r cross join partitions p cross join maintenance m;
$function$;




CREATE OR REPLACE FUNCTION public.cfm_delete_old_audit_logs(input_before_time text, input_max_batches integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  audit_logs_deleted integer;
begin
  with doomed as (
    select id from audit_logs where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from audit_logs where id in (select id from doomed) returning 1
  )
  select count(*)::integer into audit_logs_deleted from deleted;

  return jsonb_build_object('audit_logs', audit_logs_deleted,
    'has_more', exists(select 1 from audit_logs where time < input_before_time::timestamptz));
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_offline_notifications()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, grace_period, last_notified,
           offline_since, month_key, month_offline_ms
    from offline_notifications
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_expiry_notifications()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, advance_days, last_notified
    from expiry_notifications
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_set_expiry_notifications(input_items jsonb)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      coalesce(nullif(item->>'advance_days', '')::integer, 7) as advance_days,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into expiry_notifications (client, enable, advance_days)
    select client, enable, advance_days
    from parsed
    on conflict (client) do update set
      enable = excluded.enable,
      advance_days = excluded.advance_days
    where expiry_notifications.enable is distinct from excluded.enable
       or expiry_notifications.advance_days is distinct from excluded.advance_days
    returning client
  )
  select count(*)::integer from upserted;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.notification_delivery_token_matches(input_key text, input_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  perform 1 from cfm_internal.notification_delivery_state
  where key = input_key and claim_token = input_token and status = 'sent' and retired_at is null
  for update;
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_mark_expiry_notification_sent(input_client text, input_time text, input_token text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- Keep the same owner -> rule -> ledger lock order as claim and restore.
  perform 1 from clients where uuid = input_client for update;
  if not found then return false; end if;
  perform 1 from expiry_notifications where client = input_client and enable <> 0 for update;
  if not found then return false; end if;
  if not cfm_internal.notification_delivery_token_matches('expiry:' || input_client, input_token) then
    return false;
  end if;
  update expiry_notifications set last_notified = nullif(input_time, '')::timestamptz where client = input_client;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_audit_logs_paged(input_page integer DEFAULT 1, input_limit integer DEFAULT 50, input_action text DEFAULT NULL::text, input_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  safe_page integer := greatest(coalesce(input_page, 1), 1);
  safe_limit integer := least(greatest(coalesce(input_limit, 50), 1), 500);
  action_filter text := nullif(trim(coalesce(input_action, '')), '');
  search_text text := left(trim(coalesce(input_search, '')), 200);
  search_pattern text := null;
begin
  -- 关键词当字面量匹配：转义 LIKE 通配符（反斜杠、% 和 _），否则搜 "_" 会命中所有行。
  if search_text <> '' then
    search_pattern := '%' || replace(replace(replace(search_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return (
  with rows as (
    select id, time, "user", action, detail, level
    from audit_logs
    where (action_filter is null or action = action_filter)
      and (
        search_pattern is null
        or id::text ilike search_pattern
        or "user" ilike search_pattern
        or action ilike search_pattern
        or detail ilike search_pattern
      )
    order by time desc, id desc
    limit safe_limit + 1
    offset (safe_page - 1) * safe_limit
  ),
  limited as (
    select *
    from rows
    order by time desc, id desc
    limit safe_limit
  )
  select jsonb_build_object(
    'logs', coalesce((select jsonb_agg(to_jsonb(limited) order by time desc, id desc) from limited), '[]'::jsonb),
    'total', (safe_page - 1) * safe_limit + (select count(*) from limited) + case when (select count(*) from rows) > safe_limit then 1 else 0 end,
    'has_more', (select count(*) from rows) > safe_limit,
    -- 动作下拉框的候选项：必须来自全表，而不是当前页，否则筛选后下拉框只剩被选中的那一项。
    'actions', coalesce((
      select jsonb_agg(a.action order by a.action)
      from (select distinct action from audit_logs where action <> '') a
    ), '[]'::jsonb)
  )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_themes()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by updated_at desc, name asc), '[]'::jsonb)
  from (
    select *
    from themes
    order by updated_at desc, name asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_theme(input_short text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select *
    from themes
    where short = input_short
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_upsert_theme(input_theme jsonb, input_assets jsonb DEFAULT '[]'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if input_theme is null or jsonb_typeof(input_theme) <> 'object' then
    return;
  end if;

  insert into themes (
    short, name, description, version, author, url, preview_path, style_path,
    manifest_json, config_json, custom_css, updated_at
  )
  values (
    input_theme->>'short',
    coalesce(input_theme->>'name', ''),
    coalesce(input_theme->>'description', ''),
    coalesce(input_theme->>'version', ''),
    coalesce(input_theme->>'author', ''),
    coalesce(input_theme->>'url', ''),
    coalesce(input_theme->>'preview_path', ''),
    coalesce(input_theme->>'style_path', ''),
    coalesce(input_theme->>'manifest_json', '{}'),
    coalesce(input_theme->>'config_json', '{}'),
    coalesce(input_theme->>'custom_css', ''),
    now()
  )
  on conflict (short) do update set
    name = excluded.name,
    description = excluded.description,
    version = excluded.version,
    author = excluded.author,
    url = excluded.url,
    preview_path = excluded.preview_path,
    style_path = excluded.style_path,
    manifest_json = excluded.manifest_json,
    config_json = excluded.config_json,
    updated_at = now();

  delete from theme_assets where theme_short = input_theme->>'short';

  insert into theme_assets (theme_short, path, content_type, content_base64, size_bytes)
  select
    input_theme->>'short',
    asset->>'path',
    coalesce(asset->>'content_type', ''),
    coalesce(asset->>'content_base64', ''),
    coalesce(nullif(asset->>'size_bytes', '')::integer, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(input_assets) = 'array' then input_assets else '[]'::jsonb end
  ) asset;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_theme_settings(input_short text, input_config_json text, input_custom_css text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  updated_count integer;
begin
  update themes
  set config_json = input_config_json, custom_css = input_custom_css, updated_at = now()
  where short = input_short;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_delete_theme(input_short text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  deleted_count integer;
begin
  delete from themes where short = input_short;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_theme_asset(input_short text, input_path text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select *
    from theme_assets
    where theme_short = input_short
      and path = input_path
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_load_notifications()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by id), '[]'::jsonb)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    order by id asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_load_notification(input_id integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    where id = input_id
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_create_load_notification(input_item jsonb)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  insert into load_notifications (name, clients, metric, threshold, ratio, interval_min)
  values (
    coalesce(input_item->>'name', ''),
    case when jsonb_typeof(input_item->'clients') = 'array' then input_item->'clients' else '[]'::jsonb end,
    coalesce(input_item->>'metric', 'cpu'),
    coalesce((input_item->>'threshold')::double precision, 80),
    coalesce((input_item->>'ratio')::double precision, 0.8),
    coalesce((input_item->>'interval_min')::integer, 15)
  );
$function$;

CREATE OR REPLACE FUNCTION public.cfm_load_metric_window_stats(input_clients jsonb, input_start text, input_end text, input_metric text, input_threshold double precision)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ids as (
    select distinct trim(value) as client
    from jsonb_array_elements_text(coalesce(input_clients, '[]'::jsonb)) as item(value)
    where trim(value) <> ''
  ),
  samples as (
    select
      records.client,
      case
        when input_metric = 'ram' then case when ram_total > 0 then (ram::double precision / ram_total) * 100 else 0 end
        when input_metric = 'load' then load
        when input_metric = 'disk' then case when disk_total > 0 then (disk::double precision / disk_total) * 100 else 0 end
        when input_metric = 'temp' then temp
        else coalesce(cpu, 0)
      end as metric_value
    from records
    join ids on ids.client = records.client
    where records.time >= input_start::timestamptz
      and records.time <= input_end::timestamptz
      -- 负载不可用的采样点直接排除：既不计入 samples，也不拉低均值。
      -- 若当成 0 参与统计，节点看起来「一直不超阈值」，与「没有数据」是两回事。
      and (input_metric <> 'load' or records.load is not null)
      and (input_metric <> 'disk' or (records.disk is not null and records.disk_total > 0))
      and (input_metric <> 'temp' or records.temp is not null)
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select
      client,
      count(*)::integer as samples,
      coalesce(sum(case when metric_value >= input_threshold then 1 else 0 end), 0)::integer as exceeded,
      coalesce(avg(metric_value), 0)::double precision as avg_value
    from samples
    group by client
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_load_notification(input_id integer, input_patch jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  updated_count integer;
begin
  if input_patch is null or jsonb_typeof(input_patch) <> 'object' then
    return false;
  end if;

  update load_notifications
  set
    name = case when input_patch ? 'name' then coalesce(input_patch->>'name', '') else name end,
    clients = case when input_patch ? 'clients' and jsonb_typeof(input_patch->'clients') = 'array' then input_patch->'clients' else clients end,
    metric = case when input_patch ? 'metric' and input_patch->>'metric' in ('cpu', 'ram', 'load', 'disk', 'temp') then input_patch->>'metric' else metric end,
    threshold = case when input_patch ? 'threshold' then coalesce((input_patch->>'threshold')::double precision, threshold) else threshold end,
    ratio = case when input_patch ? 'ratio' then coalesce((input_patch->>'ratio')::double precision, ratio) else ratio end,
    interval_min = case when input_patch ? 'interval_min' then coalesce((input_patch->>'interval_min')::integer, interval_min) else interval_min end,
    last_notified = case when input_patch ? 'last_notified' then nullif(input_patch->>'last_notified', '')::timestamptz else last_notified end
  where id = input_id;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_delete_load_notification(input_id integer)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  delete from load_notifications where id = input_id;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.raw_write_allowed(p_parent regclass, p_time timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  -- Ask the partition tree itself, not the cached partition_bounds row: a raw
  -- write is allowed exactly when some existing child can hold the row. This
  -- keeps the guard correct right after a partition is created, before the
  -- next maintenance pass refreshes partition_bounds.
  select exists (
    select 1
    from cfm_internal.partition_children(p_parent) pc
    where (pc.range_start is null or p_time >= pc.range_start)
      and (pc.range_end is null or p_time < pc.range_end)
  );
$function$;

CREATE OR REPLACE FUNCTION public.cfm_insert_ping_snapshot(input_client text, input_time text, input_results jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  values_json jsonb;
  observed_at timestamptz;
  bucket_start timestamptz;
  watermark timestamptz;
  late_window interval;
  changed integer;
begin
  if input_client is null or input_results is null or jsonb_typeof(input_results) <> 'array' then
    return;
  end if;

  observed_at := coalesce(input_time::timestamptz, now());
  -- Ping uses the agent's observedAt, but a future clock must not create future
  -- buckets. Clamp it forward in time only.
  observed_at := least(observed_at, now());

  late_window := make_interval(hours => greatest(
    2,
    cfm_internal.retention_hours('ping_record_preserve_time') - 24
  ));
  if observed_at < now() - late_window then
    return;
  end if;

  if not cfm_internal.raw_write_allowed('public.ping_snapshots'::regclass, observed_at) then
    return;
  end if;

  select coalesce(jsonb_object_agg(
      item->>'taskId',
      round((item->>'value')::numeric)::integer
    ), '{}'::jsonb)
  into values_json
  from jsonb_array_elements(input_results) item
  where (item->>'taskId') ~ '^[0-9]{1,9}$'
    and (item->>'value') is not null
    and (item->>'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
    and (item->>'value')::numeric between -2147483648 and 2147483647;

  if values_json = '{}'::jsonb then
    return;
  end if;

  insert into public.ping_snapshots (client, time, values_json)
  values (input_client, observed_at, values_json)
  on conflict (client, time) do update
    set values_json = ping_snapshots.values_json || excluded.values_json
    where not (ping_snapshots.values_json @> excluded.values_json);
  get diagnostics changed = row_count;
  -- A byte-identical retransmission must not churn the row nor re-queue the
  -- bucket, so the dirty enqueue below only runs when something changed.
  if changed = 0 then
    return;
  end if;

  bucket_start := date_bin(interval '30 minutes', observed_at, timestamptz '1970-01-01');
  select rs.watermark into watermark
  from cfm_internal.rollup_state rs
  where rs.family = 'ping';

  if watermark is not null and bucket_start + interval '30 minutes' <= watermark then
    insert into cfm_internal.rollup_dirty(family, client, task_id, bucket_start)
    select 'ping', input_client, t.id::integer, bucket_start
    from jsonb_object_keys(values_json) as key
    join public.ping_tasks t on t.id::text = key
    where t.id between 1 and 2147483647
    on conflict do nothing;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_recent_records(input_client text, input_limit integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select *
    from records
    where client = input_client
    order by time desc
    limit least(greatest(coalesce(input_limit, 30), 1), 1000)
  ) row_data
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_records_range_limited(input_client text, input_start text, input_end text, input_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select *
    from records
    where client = input_client
      and time >= input_start::timestamptz
      and time <= input_end::timestamptz
    order by time desc
    limit least(greatest(coalesce(input_limit, 100), 1), 2000)
  ) row_data
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_latest_record_times_for_clients(input_clients jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with requested as (
    select distinct value as client
    from jsonb_array_elements_text(coalesce(input_clients, '[]'::jsonb)) as value
    where trim(value) <> ''
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select r.client, max(r.time) as last_time
    from records r
    join requested on requested.client = r.client
    group by r.client
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_records(input_client text, input_task_id integer, input_limit integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select client, input_task_id as task_id, time, (values_json ->> input_task_id::text)::integer as value
    from ping_snapshots
    where client = input_client and values_json ? input_task_id::text
    order by time desc
    limit least(greatest(coalesce(input_limit, 120), 1), 1000)
  ) row_data
  );
end;
$function$;

-- Retire the old signature so PostgREST has a single unambiguous overload.
drop function if exists public.cfm_ping_records_paged(text, integer, integer, integer);
CREATE OR REPLACE FUNCTION public.cfm_ping_records_paged(input_client text, input_task_id integer, input_page integer DEFAULT 1, input_limit integer DEFAULT 120, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  with
    params as (
      select greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select client, input_task_id as task_id, time, (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client and values_json ? input_task_id::text
        and (input_start is null or time >= input_start::timestamptz)
        and (input_end is null or time <= input_end::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn from raw_rows
    ),
    data_rows as (
      select client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows)
      + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$function$;

drop function if exists public.cfm_ping_records_cursor(text, integer, text, integer);
CREATE OR REPLACE FUNCTION public.cfm_ping_records_cursor(input_client text, input_task_id integer, input_cursor text DEFAULT NULL::text, input_limit integer DEFAULT 120, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select client, input_task_id as task_id, time, (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client and values_json ? input_task_id::text
        and (input_cursor is null or time < input_cursor::timestamptz)
        and (input_start is null or time >= input_start::timestamptz)
        and (input_end is null or time <= input_end::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn from raw_rows
    ),
    data_rows as (
      select client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows)
      + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value
      then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_records_for_tasks(input_client text, input_task_ids jsonb, input_limit integer DEFAULT 120, input_cursor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  task_id integer;
  safe_limit integer := least(greatest(coalesce(input_limit, 120), 1), 1000);
  result jsonb := '{}'::jsonb;
begin
  for task_id in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end) as value
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    result := result || jsonb_build_object(
      task_id::text,
      coalesce((
        select jsonb_agg(to_jsonb(row_data) order by time asc)
        from (
          select client, task_id as task_id, time, (values_json ->> task_id::text)::integer as value
          from ping_snapshots
          where client = input_client and values_json ? task_id::text
            and (input_cursor is null or time < input_cursor::timestamptz)
          order by time desc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_partition_tree_total_bytes(input_table regclass)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with recursive tree(relid) as (
    select input_table::oid
    union all
    select i.inhrelid from pg_inherits i join tree t on t.relid=i.inhparent
  ) select coalesce(sum(pg_total_relation_size(relid)),0)::bigint from tree;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_history_storage_bytes()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'records', public.cfm_partition_tree_total_bytes('public.records'::regclass),
    'ping_snapshots', public.cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass),
    'ping_rollup', public.cfm_partition_tree_total_bytes('public.ping_rollup'::regclass),
    'host_rollup', public.cfm_partition_tree_total_bytes('public.host_rollup'::regclass),
    'total',
      public.cfm_partition_tree_total_bytes('public.records'::regclass)
      + public.cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass)
      + public.cfm_partition_tree_total_bytes('public.host_rollup'::regclass)
      + public.cfm_partition_tree_total_bytes('public.ping_rollup'::regclass)
  ) || jsonb_build_object('allocated_bytes',
      public.cfm_partition_tree_total_bytes('public.records'::regclass)
      + public.cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass)
      + public.cfm_partition_tree_total_bytes('public.host_rollup'::regclass)
      + public.cfm_partition_tree_total_bytes('public.ping_rollup'::regclass));
$function$;

CREATE OR REPLACE FUNCTION public.cfm_public_ping_tasks()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, type, target, interval_sec, timeout_ms, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_users_count()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select count(*)::integer
  from users;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_user_password(input_uuid text, input_passwd text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  update users
  set passwd = input_passwd,
      updated_at = now()
  where uuid = input_uuid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_user_password_rotate_session(input_uuid text, input_passwd text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update users
  set passwd = input_passwd,
      session_version = session_version + 1,
      password_changed_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_validate_admin_session(user_uuid text, expected_session_version integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select uuid, username, session_version
    from users
    where uuid = user_uuid
      and session_version = expected_session_version
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_create_initial_admin(p_uuid text, p_username text, p_password_hash text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if nullif(trim(coalesce(p_uuid, '')), '') is null
    or nullif(trim(coalesce(p_username, '')), '') is null
    or coalesce(p_password_hash, '') = ''
  then
    raise exception 'user uuid, username, and password hash are required';
  end if;

  lock table public.users in share row exclusive mode;
  if exists (select 1 from public.users) then
    return false;
  end if;
  insert into public.users (uuid, username, passwd, password_changed_at)
  values (p_uuid, p_username, p_password_hash, now());
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_login_rate_limits(input_buckets jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with buckets as (
    select distinct value as bucket
    from jsonb_array_elements_text(case when jsonb_typeof(input_buckets) = 'array' then input_buckets else '[]'::jsonb end)
    where trim(value) <> ''
  )
  select coalesce(jsonb_agg(to_jsonb(l) order by l.bucket), '[]'::jsonb)
  from login_rate_limits l
  join buckets b on b.bucket = l.bucket;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_record_login_failures(input_buckets jsonb, input_failed_at text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  bucket_name text;
  failed_at timestamptz := input_failed_at::timestamptz;
  saved public.login_rate_limits%rowtype;
  next_lock timestamptz;
begin
  if failed_at is null then
    raise exception 'failure time is required';
  end if;
  for bucket_name in
    select distinct value
    from jsonb_array_elements_text(case when jsonb_typeof(input_buckets) = 'array' then input_buckets else '[]'::jsonb end)
    where trim(value) <> ''
    order by value
  loop
    insert into public.login_rate_limits as limits
      (bucket, failures, first_failed_at, last_failed_at, locked_until)
    values (bucket_name, 1, failed_at, failed_at, null)
    on conflict (bucket) do update set
      failures = case
        when greatest(excluded.last_failed_at, limits.last_failed_at) - limits.first_failed_at <= interval '15 minutes'
          then least(limits.failures, 2147483646) + 1
        else 1 end,
      first_failed_at = case
        when greatest(excluded.last_failed_at, limits.last_failed_at) - limits.first_failed_at <= interval '15 minutes'
          then limits.first_failed_at
        else greatest(excluded.last_failed_at, limits.last_failed_at) end,
      last_failed_at = greatest(excluded.last_failed_at, limits.last_failed_at),
      failure_revision = gen_random_uuid()
    returning * into saved;

    next_lock := case when saved.failures >= 5 then
      saved.last_failed_at + interval '1 second' * least(900, 30 * power(2, least(saved.failures - 5, 5)))
      else null end;
    update public.login_rate_limits
    set locked_until = greatest(next_lock,
      case when saved.locked_until > saved.last_failed_at then saved.locked_until else null end)
    where bucket = bucket_name;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_clear_observed_login_failures(input_states jsonb)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  delete from public.login_rate_limits as limits
  using jsonb_array_elements(case when jsonb_typeof(input_states) = 'array' then input_states else '[]'::jsonb end) as observed(value)
  where limits.bucket = observed.value->>'bucket'
    and limits.failure_revision = (observed.value->>'failure_revision')::uuid;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_delete_login_rate_limits_before(input_before_time text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  delete from login_rate_limits
  where last_failed_at < input_before_time::timestamptz
    and (locked_until is null or locked_until < now());
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.retire_notification_deliveries(input_keys text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  delivery_key text;
begin
  for delivery_key in select distinct key from unnest(input_keys) item(key) order by key
  loop
    -- Claims lock their owner before the ledger. Delete/replace already holds
    -- that same owner, so a concurrently created claim cannot escape retirement.
    update cfm_internal.notification_delivery_state
    set retired_at = coalesce(retired_at, now())
    where key = delivery_key;
    delete from cfm_internal.notification_delivery_state
    where key = delivery_key and not (
      status = 'pending' and claim_token is not null and next_attempt_at > now()
    );
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.retire_client_notification_deliveries(input_client text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select cfm_internal.retire_notification_deliveries(coalesce(array_agg(key order by key), array[]::text[]))
  from cfm_internal.notification_delivery_state
  where key in ('offline:' || input_client, 'expiry:' || input_client)
    or (key ~ '^load:[0-9]+:.+$' and substring(key from '^load:[0-9]+:(.+)$') = input_client);
$function$;


CREATE OR REPLACE FUNCTION public.cfm_insert_audit_log(input_user text, input_action text, input_detail text, input_level text DEFAULT 'info'::text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  insert into audit_logs ("user", action, detail, level)
  values (
    coalesce(input_user, ''),
    coalesce(input_action, ''),
    coalesce(input_detail, ''),
    coalesce(nullif(input_level, ''), 'info')
  );
$function$;

CREATE OR REPLACE FUNCTION public.cfm_try_claim_audit_throttle(input_key text, input_now timestamp with time zone, input_throttle_ms bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  claimed boolean;
begin
  insert into settings (key, value)
  values (input_key, to_char(input_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  on conflict (key) do update
    set value = excluded.value
    where case
      when settings.value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then true
      else settings.value collate "C" <= to_char(
        (input_now - make_interval(secs => input_throttle_ms / 1000.0)) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    end
  returning true into claimed;

  -- where 为假时一行都不返回，claimed 会被置为 null，那代表「没抢到」。
  return coalesce(claimed, false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_rotate_user_session(input_uuid text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update users
  set session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_update_user_username_rotate_session(input_uuid text, input_username text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update users
  set username = input_username,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$function$;

CREATE OR REPLACE FUNCTION public.cfm_login_user(input_username text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where username = input_username
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_user_by_uuid(input_uuid text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where uuid = input_uuid
    limit 1
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_enable_user_totp(input_uuid text, input_secret_enc text, input_recovery_code_hashes jsonb, input_used_step bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  updated_user users%rowtype;
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_secret_enc, '')), '') is null
    or input_used_step < 0
    or jsonb_typeof(input_recovery_code_hashes) is distinct from 'array'
    or jsonb_array_length(input_recovery_code_hashes) <> 8
  then
    raise exception 'invalid TOTP enrollment data';
  end if;

  update users
  set totp_secret_enc = input_secret_enc,
      totp_enabled_at = now(),
      totp_last_used_step = input_used_step,
      recovery_code_hashes = input_recovery_code_hashes,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_disable_user_totp(input_uuid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  updated_user users%rowtype;
begin
  update users
  set totp_secret_enc = null,
      totp_enabled_at = null,
      totp_last_used_step = -1,
      recovery_code_hashes = '[]'::jsonb,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_replace_user_recovery_codes(input_uuid text, input_recovery_code_hashes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  updated_user users%rowtype;
begin
  if jsonb_typeof(input_recovery_code_hashes) is distinct from 'array'
    or jsonb_array_length(input_recovery_code_hashes) <> 8
  then
    raise exception 'exactly eight recovery code hashes are required';
  end if;

  update users
  set recovery_code_hashes = input_recovery_code_hashes,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_consume_totp_step(input_uuid text, input_step bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if input_step < 0 then
    return false;
  end if;

  update users
  set totp_last_used_step = input_step,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
    and totp_secret_enc is not null
    and totp_last_used_step < input_step;

  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_consume_recovery_code(input_uuid text, input_code_hash text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if input_code_hash !~ '^[A-Za-z0-9_-]{43}$' then
    return false;
  end if;

  update users
  set recovery_code_hashes = recovery_code_hashes - input_code_hash,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
    and recovery_code_hashes ? input_code_hash;

  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_recover_single_admin(input_uuid text, input_username text, input_passwd text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  user_count integer;
  target_uuid text;
  recovered users%rowtype;
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_username, '')), '') is null
    or coalesce(input_passwd, '') = ''
  then
    raise exception 'user uuid, username, and password hash are required';
  end if;

  select count(*)::integer into user_count from users;

  if user_count = 0 then
    insert into users (uuid, username, passwd, password_changed_at)
    values (input_uuid, input_username, input_passwd, now())
    returning * into recovered;
  elsif user_count = 1 then
    select uuid into target_uuid from users limit 1;
    update users
    set username = input_username,
        passwd = input_passwd,
        session_version = session_version + 1,
        password_changed_at = now(),
        totp_secret_enc = null,
        totp_enabled_at = null,
        totp_last_used_step = -1,
        recovery_code_hashes = '[]'::jsonb,
        updated_at = now()
    where uuid = target_uuid
    returning * into recovered;
  else
    raise exception 'admin recovery supports exactly one admin user';
  end if;

  return to_jsonb(recovered);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_set_offline_notifications(input_items jsonb)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      -- 与前端 DEFAULT_GRACE_PERIOD_SEC 及列默认值一致（360）。
      coalesce(nullif(item->>'grace_period', '')::integer, 360) as grace_period,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into offline_notifications (client, enable, grace_period)
    select client, enable, grace_period
    from parsed
    on conflict (client) do update set
      enable = excluded.enable,
      grace_period = excluded.grace_period,
      last_notified = case
        when excluded.enable = 0 then null
        else offline_notifications.last_notified
      end,
      offline_since = case
        when excluded.enable = 0 then null
        else offline_notifications.offline_since
      end
    where offline_notifications.enable is distinct from excluded.enable
       or offline_notifications.grace_period is distinct from excluded.grace_period
       or (excluded.enable = 0 and (
            offline_notifications.last_notified is not null
            or offline_notifications.offline_since is not null
          ))
    returning client
  )
  select count(*)::integer from upserted;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_mark_offline_notification_sent(input_client text, input_time text, input_token text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- Keep the same owner -> rule -> ledger lock order as claim and restore.
  perform 1 from clients where uuid = input_client for update;
  if not found then return false; end if;
  perform 1 from offline_notifications where client = input_client and enable <> 0 for update;
  if not found then return false; end if;
  if not cfm_internal.notification_delivery_token_matches('offline:' || input_client, input_token) then
    return false;
  end if;
  update offline_notifications set last_notified = nullif(input_time, '')::timestamptz where client = input_client;
  return true;
end;
$function$;

-- 记录一次离线/恢复转换，并把「本次离线起点」和「本月累计离线」落到规则行。
-- 与 cfm_mark_offline_notification_sent 共用同一套 owner -> rule -> ledger 锁顺序
-- 和投递 token 校验，避免通知成功后状态被另一路请求覆盖。
CREATE OR REPLACE FUNCTION public.cfm_record_offline_transition(
  input_client text,
  input_phase text,
  input_time text DEFAULT NULL::text,
  input_since text DEFAULT NULL::text,
  input_month_key text DEFAULT NULL::text,
  input_month_offline_ms bigint DEFAULT NULL::bigint,
  input_token text DEFAULT NULL::text
)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  perform 1 from clients where uuid = input_client for update;
  if not found then return false; end if;
  perform 1 from offline_notifications where client = input_client and enable <> 0 for update;
  if not found then return false; end if;
  if not cfm_internal.notification_delivery_token_matches('offline:' || input_client, input_token) then
    return false;
  end if;

  if input_phase = 'offline' then
    update offline_notifications
       set last_notified = nullif(input_time, '')::timestamptz,
           offline_since = coalesce(offline_since, nullif(input_since, '')::timestamptz)
     where client = input_client;
    return true;
  end if;

  if input_phase = 'recovery' then
    update offline_notifications
       set last_notified = null,
           offline_since = null,
           month_key = nullif(input_month_key, ''),
           month_offline_ms = coalesce(input_month_offline_ms, 0)
     where client = input_client;
    return true;
  end if;

  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ip_change_notifications()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable
    from ip_change_notifications
  ) row_data;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ip_change_notification_enabled(input_uuid text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from ip_change_notifications
    where client = input_uuid and enable <> 0
  );
$function$;

CREATE OR REPLACE FUNCTION public.cfm_set_ip_change_notifications(input_items jsonb)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into ip_change_notifications (client, enable)
    select client, enable
    from parsed
    on conflict (client) do update set
      enable = excluded.enable
    where ip_change_notifications.enable is distinct from excluded.enable
    returning client
  )
  select count(*)::integer from upserted;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.notification_delivery_entity_exists(input_key text, input_lock boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  entity_id text;
  client_id text;
  key_parts text[];
begin
  if input_key like 'offline:%' or input_key like 'expiry:%' then
    client_id := substring(input_key from position(':' in input_key) + 1);
    if client_id = '' then return null; end if;
    if input_lock then
      perform 1 from clients where uuid = client_id for share;
    else
      perform 1 from clients where uuid = client_id;
    end if;
    if not found then return false; end if;
    if input_key like 'offline:%' then
      if input_lock then
        perform 1 from offline_notifications where client = client_id and enable <> 0 for share;
      else
        perform 1 from offline_notifications where client = client_id and enable <> 0;
      end if;
    else
      if input_lock then
        perform 1 from expiry_notifications where client = client_id and enable <> 0 for share;
      else
        perform 1 from expiry_notifications where client = client_id and enable <> 0;
      end if;
    end if;
    return found;
  elsif input_key ~ '^load:[0-9]+:.+$' then
    key_parts := regexp_match(input_key, '^load:([0-9]+):(.+)$');
    entity_id := key_parts[1];
    client_id := key_parts[2];
    if input_lock then
      perform 1 from clients where uuid = client_id for share;
    else
      perform 1 from clients where uuid = client_id;
    end if;
    if not found then return false; end if;
    if input_lock then
      perform 1 from load_notifications
      where id::text = entity_id and (clients = '[]'::jsonb or clients ? client_id) for share;
    else
      perform 1 from load_notifications
      where id::text = entity_id and (clients = '[]'::jsonb or clients ? client_id);
    end if;
    return found;
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_claim_notification_delivery(input_key text, input_event_id text, input_now timestamp with time zone, input_repeat_ms bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  current_state cfm_internal.notification_delivery_state%rowtype;
  token text;
begin
  if input_now is null then raise exception 'notification delivery time is required'; end if;
  if cfm_internal.notification_delivery_entity_exists(input_key, true) is false then
    return jsonb_build_object('claimed', false, 'delivered', false, 'token', null);
  end if;
  insert into cfm_internal.notification_delivery_state
    (key, event_id, status, attempts, next_attempt_at, updated_at)
  values (input_key, input_event_id, 'pending', 0, input_now, input_now)
  on conflict (key) do nothing;

  select * into current_state from cfm_internal.notification_delivery_state
  where key = input_key for update;
  if current_state.status = 'pending' and current_state.claim_token is not null
    and current_state.next_attempt_at > input_now then
    return jsonb_build_object('claimed', false, 'delivered', false, 'token', null);
  end if;
  if current_state.retired_at is null and current_state.event_id = input_event_id then
    if current_state.status = 'sent' and coalesce(input_repeat_ms, 0) <= 0 then
      -- Pre-upgrade sent rows did not retain a completion credential. Create one
      -- lazily without re-sending or changing their original delivery time.
      token := coalesce(current_state.claim_token, gen_random_uuid()::text);
      update cfm_internal.notification_delivery_state set claim_token = token where key = input_key;
      return jsonb_build_object('claimed', false, 'delivered', true, 'token', token);
    end if;
    if current_state.next_attempt_at > input_now then
      return jsonb_build_object('claimed', false, 'delivered', false, 'token', null);
    end if;
  end if;

  token := gen_random_uuid()::text;
  update cfm_internal.notification_delivery_state
  set event_id = input_event_id, status = 'pending', claim_token = token,
      retired_at = null, delivered_at = null,
      attempts = case when current_state.retired_at is not null or current_state.event_id <> input_event_id or current_state.status = 'sent'
        then 1 else least(current_state.attempts + 1, 100000) end,
      next_attempt_at = input_now + interval '90 seconds', updated_at = input_now
  where key = input_key;
  return jsonb_build_object('claimed', true, 'delivered', false, 'token', token);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_complete_notification_delivery(input_key text, input_event_id text, input_token text, input_success boolean, input_now timestamp with time zone, input_repeat_ms bigint DEFAULT 0)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  changed integer;
begin
  perform 1 from cfm_internal.notification_delivery_state
  where key = input_key and event_id = input_event_id and claim_token = input_token and status = 'pending'
  for update;
  if not found then return false; end if;
  delete from cfm_internal.notification_delivery_state
  where key = input_key and event_id = input_event_id and claim_token = input_token
    and status = 'pending' and retired_at is not null;
  if found then return false; end if;
  update cfm_internal.notification_delivery_state
  set status = case when input_success then 'sent' else 'failed' end,
      delivered_at = case when input_success then input_now else delivered_at end,
      next_attempt_at = input_now + make_interval(secs => case when input_success
        then least(greatest(coalesce(input_repeat_ms, 0), 0), 604800000) / 1000.0
        else least(1800, 120 * power(2, least(greatest(attempts - 1, 0), 4))) end),
      claim_token = case when input_success then input_token else null end, updated_at = input_now
  where key = input_key and event_id = input_event_id
    and claim_token = input_token and status = 'pending' and retired_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;


CREATE OR REPLACE FUNCTION cfm_internal.retire_entity_notification_deliveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  delivery_keys text[];
begin
  if tg_table_name = 'clients' then
    if tg_op = 'DELETE' then
      perform cfm_internal.retire_client_notification_deliveries(old.uuid);
    elsif new.expired_at is distinct from old.expired_at then
      perform cfm_internal.retire_notification_deliveries(array['expiry:' || old.uuid]);
    end if;
  elsif tg_table_name = 'offline_notifications' then
    if tg_op = 'DELETE' or row(new.enable, new.grace_period) is distinct from row(old.enable, old.grace_period) then
      perform cfm_internal.retire_notification_deliveries(array['offline:' || old.client]);
    end if;
  elsif tg_table_name = 'expiry_notifications' then
    if tg_op = 'DELETE' or row(new.enable, new.advance_days) is distinct from row(old.enable, old.advance_days) then
      perform cfm_internal.retire_notification_deliveries(array['expiry:' || old.client]);
    end if;
  elsif tg_table_name = 'load_notifications' then
    if tg_op = 'DELETE' or row(new.clients, new.metric, new.threshold, new.ratio, new.interval_min)
      is distinct from row(old.clients, old.metric, old.threshold, old.ratio, old.interval_min) then
      select coalesce(array_agg(key order by key), array[]::text[]) into delivery_keys
      from cfm_internal.notification_delivery_state where key like 'load:' || old.id::text || ':%';
      perform cfm_internal.retire_notification_deliveries(delivery_keys);
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_cleanup_notification_delivery_state(input_now timestamp with time zone, input_batch_size integer DEFAULT 1000, input_max_batches integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  safe_batch integer := least(greatest(coalesce(input_batch_size, 1000), 1), 5000);
  safe_batches integer := least(greatest(coalesce(input_max_batches, 1), 1), 20);
  batch integer;
  changed integer;
  removed integer;
  total_removed integer := 0;
  remaining boolean;
begin
  if input_now is null then raise exception 'notification cleanup time is required'; end if;
  for batch in 1..safe_batches loop
    with candidates as materialized (
      select key, status = 'pending' and claim_token is not null and next_attempt_at > input_now as active
      from cfm_internal.notification_delivery_state
      where (retired_at is not null and not (status = 'pending' and claim_token is not null and next_attempt_at > input_now))
        or (retired_at is null and cfm_internal.notification_delivery_entity_exists(key, false) is false)
      order by key
      limit safe_batch
      for update skip locked
    ), retired as (
      update cfm_internal.notification_delivery_state s
      set retired_at = input_now
      from candidates c where s.key = c.key and c.active and s.retired_at is null
      returning 1
    ), deleted as (
      delete from cfm_internal.notification_delivery_state s
      using candidates c where s.key = c.key and not c.active
      returning 1
    )
    select (select count(*) from retired) + (select count(*) from deleted), (select count(*) from deleted)
      into changed, removed;
    total_removed := total_removed + removed;
    exit when changed = 0;
  end loop;
  -- Waiting leases remain unfinished work for the next Cron; they are never
  -- deleted just to make a cleanup pass appear complete.
  select exists (
    select 1 from cfm_internal.notification_delivery_state
    where retired_at is not null or cfm_internal.notification_delivery_entity_exists(key, false) is false
  ) into remaining;
  return jsonb_build_object('notification_delivery_state', total_removed, 'has_more', remaining);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_mark_load_notification_sent(input_id integer, input_client text, input_time text, input_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  perform 1 from clients where uuid = input_client for update;
  if not found then return false; end if;
  perform 1 from load_notifications
  where id = input_id and (clients = '[]'::jsonb or clients ? input_client) for update;
  if not found then return false; end if;
  if not cfm_internal.notification_delivery_token_matches('load:' || input_id::text || ':' || input_client, input_token) then
    return false;
  end if;
  update load_notifications set last_notified = nullif(input_time, '')::timestamptz where id = input_id;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_records_for_tasks_range(input_client text, input_task_ids jsonb, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text, input_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  tid integer;
  -- 与分桶读取保持同一个上限：调用方（公开 /records/ping）允许请求到 1500 行，
  -- 这里再截到 1000 会让“请求多少就返回多少”的边界悄悄失效。
  safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 2000);
  result jsonb := '{}'::jsonb;
begin
  for tid in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end) as item(value)
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    result := result || jsonb_build_object(
      tid::text,
      coalesce((
        select jsonb_agg(to_jsonb(row_data) order by time asc)
        from (
          select * from (
            select client, tid as task_id, time, (values_json ->> tid::text)::double precision as value
            from ping_snapshots
            where client = input_client and values_json ? tid::text
              and (input_start is null or time >= input_start::timestamptz)
              and (input_end is null or time <= input_end::timestamptz)
            union all
            select r.client, r.task_id, r.bucket_start, coalesce(r.p50_latency, -1)
            from ping_rollup r
            where r.client = input_client and r.task_id = tid
              and (input_start is null or r.bucket_start >= input_start::timestamptz)
              and (input_end is null or r.bucket_start + interval '30 minutes' <= input_end::timestamptz)
              and not exists (select 1 from ping_snapshots s where s.client = r.client
                and s.values_json ? r.task_id::text
                and s.time >= r.bucket_start and s.time < r.bucket_start + interval '30 minutes')
          ) available
          order by time desc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_records_for_tasks_range_bucketed(input_client text, input_task_ids jsonb, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text, input_bucket_sec integer DEFAULT 900, input_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  tid integer;
  -- 桶宽上限给到一天：monitor 兼容层的 step 可达 10080（7 天窗口 + points 下限 60），
  -- 桶宽被压到 3600 时 SQL 的桶和适配器的网格对不上。
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 900), 60), 86400);
  -- monitor 的点预算是 1440，窗口两端还会各多一个不完整的桶，所以上限必须高于
  -- 1500；截到 1000 会静默丢掉最老的桶，窗口 loss 也会只覆盖返回的那一段。
  safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 2000);
  result jsonb := '{}'::jsonb;
begin
  for tid in
    select distinct value::integer
    from jsonb_array_elements_text(
      case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end
    ) as item(value)
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    result := result || jsonb_build_object(
      tid::text,
      coalesce((
        select jsonb_agg(to_jsonb(row_data) order by time asc)
        from (
          select time, task_id,
            coalesce(sum(p50_latency * success_count) / nullif(sum(success_count), 0), -1) as value,
            sum(sample_count)::integer as sample_count,
            sum(success_count)::integer as success_count,
            sum(loss_count)::integer as loss_count,
            sum(avg_latency * success_count) / nullif(sum(success_count), 0) as avg_latency,
            min(min_latency) as min_latency, max(max_latency) as max_latency,
            sum(p50_latency * success_count) / nullif(sum(success_count), 0) as p50_latency,
            sum(p75_latency * success_count) / nullif(sum(success_count), 0) as p75_latency
          from (select
            to_timestamp(bucket_start) as time,
            tid as task_id,
            -- 代表值 value 是桶内中位数（不取整）：单个重传/抖动尖峰不会拉高整个桶，
            -- 平均值另给 avg_latency。桶内没有成功样本时 value 为 -1（丢包）。
            coalesce(percentile_cont(0.5) within group (order by raw_value) filter (where raw_value >= 0), -1) as value,
            count(*)::integer as sample_count,
            count(*) filter (where raw_value >= 0)::integer as success_count,
            count(*) filter (where raw_value < 0)::integer as loss_count,
            avg(nullif(raw_value, -1)) filter (where raw_value >= 0) as avg_latency,
            min(nullif(raw_value, -1)) filter (where raw_value >= 0) as min_latency,
            max(nullif(raw_value, -1)) filter (where raw_value >= 0) as max_latency,
            percentile_cont(0.5) within group (order by raw_value) filter (where raw_value >= 0) as p50_latency,
            percentile_cont(0.75) within group (order by raw_value) filter (where raw_value >= 0) as p75_latency
          from (
            select
              floor(extract(epoch from time) / safe_bucket)::bigint * safe_bucket as bucket_start,
              (values_json ->> tid::text)::integer as raw_value
            from ping_snapshots
            where client = input_client
              and values_json ? tid::text
              and (input_start is null or time >= input_start::timestamptz)
              and (input_end is null or time <= input_end::timestamptz)
          ) raw
          group by bucket_start
          union all
          -- Increasing raw retention cannot resurrect pruned rows. Keep their
          -- existing 30-minute rollups visible without counting raw twice.
          select to_timestamp(floor(extract(epoch from r.bucket_start) / safe_bucket) * safe_bucket) as time,
            tid as task_id, coalesce(r.p50_latency, -1) as value,
            r.sample_count, r.success_count, r.loss_count,
            r.sum_latency / nullif(r.success_count, 0) as avg_latency,
            r.min_latency, r.max_latency, r.p50_latency, r.p75_latency
          from ping_rollup r
          where r.client = input_client and r.task_id = tid
            and (input_start is null or r.bucket_start >= input_start::timestamptz)
            and (input_end is null or r.bucket_start + interval '30 minutes' <= input_end::timestamptz)
            and not exists (select 1 from ping_snapshots s where s.client = r.client
              and s.values_json ? tid::text
              and s.time >= r.bucket_start and s.time < r.bucket_start + interval '30 minutes')
          ) available
          group by time, task_id
          -- 超出 limit 时丢最老的桶、保留最新的（与 metrics 的 cfm_records_range_aggregated
          -- 一致）：图表右侧的最新数据不能因为截断消失。外层 jsonb_agg 仍按时间升序输出。
          order by time desc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_stats_for_tasks_range(input_client text, input_task_ids jsonb, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ids as (
    select distinct value::integer as tid
    from jsonb_array_elements_text(
      case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end
    ) as item(value)
    where value ~ '^[0-9]{1,9}$' and value::integer > 0
    limit 50
  ),
  raw_from as (
    select cfm_internal.read_raw_from('ping_record_preserve_time', input_start::timestamptz) as at
  ),
  recent_raw as (
    select i.tid, (s.values_json ->> i.tid::text)::integer as v
    from ids i
    join ping_snapshots s
      on s.client = input_client
     and s.values_json ? i.tid::text
     and (input_start is null or s.time >= input_start::timestamptz)
     and (input_end is null or s.time <= input_end::timestamptz)
     and s.time >= (select at from raw_from)
  ),
  -- Same fallback as host reads: use raw rows for old 30-minute buckets that
  -- have no rollup row, otherwise the stale raw copy would double count.
  old_raw_fallback as (
    select i.tid, (s.values_json ->> i.tid::text)::integer as v
    from ids i
    join ping_snapshots s
      on s.client = input_client
     and s.values_json ? i.tid::text
     and (input_start is null or s.time >= input_start::timestamptz)
     and (input_end is null or s.time <= input_end::timestamptz)
     and s.time < (select at from raw_from)
     and not exists (
       select 1 from ping_rollup r
       where r.client = s.client
         and r.task_id = i.tid
         and r.bucket_start = date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01')
     )
  ),
  raw_agg as (
    select
      tid,
      count(*)::integer as samples,
      count(*) filter (where v >= 0)::integer as success_count,
      count(*) filter (where v < 0)::integer as loss_count,
      coalesce(sum(v) filter (where v >= 0), 0) as sum_latency,
      coalesce(sum(v::double precision * v::double precision) filter (where v >= 0), 0) as sumsq_latency,
      min(v) filter (where v >= 0) as min_latency,
      max(v) filter (where v >= 0) as max_latency,
      percentile_cont(0.5) within group (order by v) filter (where v >= 0) as p50_latency,
      percentile_cont(0.75) within group (order by v) filter (where v >= 0) as p75_latency
    from (select * from recent_raw union all select * from old_raw_fallback) raw
    group by tid
  ),
  old_agg as (
    select
      r.task_id as tid,
      sum(r.sample_count)::integer as samples,
      sum(r.success_count)::integer as success_count,
      sum(r.loss_count)::integer as loss_count,
      sum(r.sum_latency) as sum_latency,
      sum(r.sumsq_latency) as sumsq_latency,
      min(r.min_latency) as min_latency,
      max(r.max_latency) as max_latency,
      sum(r.p50_latency * r.success_count) filter (where r.p50_latency is not null)
        / nullif(sum(r.success_count) filter (where r.p50_latency is not null), 0) as p50_latency,
      sum(r.p75_latency * r.success_count) filter (where r.p75_latency is not null)
        / nullif(sum(r.success_count) filter (where r.p75_latency is not null), 0) as p75_latency
    from ping_rollup r
    join ids i on i.tid = r.task_id
    cross join raw_from rf
    where r.client = input_client
      and (input_start is null or r.bucket_start >= input_start::timestamptz)
      and (input_end is null or r.bucket_start + interval '30 minutes' <= input_end::timestamptz)
      and (r.bucket_start + interval '30 minutes' <= rf.at
        or not exists (select 1 from ping_snapshots s where s.client = r.client
          and s.values_json ? r.task_id::text
          and s.time >= r.bucket_start and s.time < r.bucket_start + interval '30 minutes'))
    group by r.task_id
  ),
  merged as (
    select tid, samples, success_count, loss_count, sum_latency, sumsq_latency,
      min_latency, max_latency, p50_latency, p75_latency
    from raw_agg
    union all
    select tid, samples, success_count, loss_count, sum_latency, sumsq_latency,
      min_latency, max_latency, p50_latency, p75_latency
    from old_agg
  ),
  agg as (
    select
      tid,
      sum(samples)::integer as samples,
      sum(success_count)::integer as success_count,
      sum(loss_count)::integer as loss_count,
      sum(sum_latency) as sum_latency,
      sum(sumsq_latency) as sumsq_latency,
      min(min_latency) as min_latency,
      max(max_latency) as max_latency,
      sum(p50_latency * success_count) filter (where p50_latency is not null)
        / nullif(sum(success_count) filter (where p50_latency is not null), 0) as p50_latency,
      sum(p75_latency * success_count) filter (where p75_latency is not null)
        / nullif(sum(success_count) filter (where p75_latency is not null), 0) as p75_latency
    from merged
    group by tid
  )
  select coalesce(
    jsonb_object_agg(
      tid::text,
      jsonb_build_object(
        'samples', samples,
        'success_count', success_count,
        'loss_count', loss_count,
        'loss_rate', case when samples > 0 then loss_count::double precision * 100 / samples else null end,
        'avg_latency', case when success_count > 0 then sum_latency / success_count end,
        'min_latency', min_latency,
        'max_latency', max_latency,
        'p50_latency', p50_latency,
        'p75_latency', p75_latency,
        'jitter', case when success_count > 1 then sqrt(greatest(0,
          (sumsq_latency - sum_latency * sum_latency / success_count) / (success_count - 1))) end
      )
    ),
    '{}'::jsonb
  )
  from agg;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_home_ping_assignments()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_object_agg(h.client, h.task_id), '{}'::jsonb)
  from client_home_ping h
  join ping_tasks p on p.id = h.task_id
  where p.all_clients <> 0 or p.clients ? h.client;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_set_home_ping_task(input_client text, input_task_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if input_task_id is null then
    delete from client_home_ping where client = input_client;
    return jsonb_build_object('client', input_client, 'task_id', null);
  end if;

  if not exists (select 1 from clients where uuid = input_client) then
    raise exception 'client_not_found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from ping_tasks p
    where p.id = input_task_id
      and (p.all_clients <> 0 or p.clients ? input_client)
  ) then
    raise exception 'task_not_applicable' using errcode = 'P0001';
  end if;

  insert into client_home_ping (client, task_id, updated_at)
  values (input_client, input_task_id, now())
  on conflict (client) do update
    set task_id = excluded.task_id, updated_at = excluded.updated_at;

  return jsonb_build_object('client', input_client, 'task_id', input_task_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_traffic_apply_samples(input_client text, input_samples jsonb, input_from text, input_to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  st_scope text;
  st_boot bigint;
  st_ifaces jsonb;
  st_last_ts bigint;
  sample jsonb;
  v_ts bigint;
  v_boot bigint;
  v_scope text;
  v_offset integer;
  v_ifaces jsonb;
  v_day date;
  v_name text;
  v_cur jsonb;
  v_prev jsonb;
  cur_up bigint;
  cur_down bigint;
  prev_up bigint;
  prev_down bigint;
  d_up bigint;
  d_down bigint;
  v_reboot boolean;
  applied integer := 0;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  total_up numeric;
  total_down numeric;
begin
  if input_samples is not null and jsonb_typeof(input_samples) = 'array' and jsonb_array_length(input_samples) > 0 then
    if jsonb_array_length(input_samples) > 500 then
      raise exception 'too_many_samples' using errcode = '22023';
    end if;

    -- 保证状态行存在并加锁：scope = '' 且 last_ts = 0 表示「还没有基线」。
    insert into traffic_counter_state (client, scope) values (input_client, '')
    on conflict (client) do nothing;
    select scope, boot, interfaces, last_ts into st_scope, st_boot, st_ifaces, st_last_ts
      from traffic_counter_state where client = input_client for update;

    for sample in select value from jsonb_array_elements(input_samples) loop
      begin
        if jsonb_typeof(sample) is distinct from 'object'
          or jsonb_typeof(sample -> 'ts') is distinct from 'number'
          or jsonb_typeof(sample -> 'scope') is distinct from 'string'
          or jsonb_typeof(sample -> 'interfaces') is distinct from 'object' then
          continue;
        end if;
        v_ts := floor((sample ->> 'ts')::numeric)::bigint;
        -- 拒绝非正数和明显在未来的时间：否则一个坏时间戳会把 last_ts 顶上去，之后所有样本都被当成「旧样本」。
        if v_ts <= 0 or v_ts > now_ms + 3600000 then
          continue;
        end if;
        v_scope := sample ->> 'scope';
        v_boot := case when jsonb_typeof(sample -> 'boot') = 'number'
          then greatest(floor((sample ->> 'boot')::numeric), 0)::bigint else 0 end;
        v_offset := case when jsonb_typeof(sample -> 'utc_offset') = 'number'
          then least(greatest(floor((sample ->> 'utc_offset')::numeric), -43200), 50400)::integer else 0 end;
        v_ifaces := sample -> 'interfaces';
        if (select count(*) from jsonb_object_keys(v_ifaces)) > 128 then
          continue;
        end if;
      exception when others then
        continue;
      end;
      if v_ts <= st_last_ts then
        continue;
      end if;

      -- 增量记在样本「Agent 本地日期」上：UTC 时间 + Agent 上报的偏移。
      v_day := ((to_timestamp(v_ts / 1000.0) at time zone 'UTC') + make_interval(secs => v_offset))::date;

      d_up := 0;
      d_down := 0;
      if st_last_ts > 0 and st_scope = v_scope then
        v_reboot := v_boot > 0 and st_boot > 0 and abs(v_boot - st_boot) > 60;
        for v_name, v_cur in select key, value from jsonb_each(v_ifaces) loop
          if jsonb_typeof(v_cur) is distinct from 'object' then
            continue;
          end if;
          cur_up := case when jsonb_typeof(v_cur -> 'up') = 'number'
            then least(greatest(floor((v_cur ->> 'up')::numeric), 0), 1000000000000000)::bigint end;
          cur_down := case when jsonb_typeof(v_cur -> 'down') = 'number'
            then least(greatest(floor((v_cur ->> 'down')::numeric), 0), 1000000000000000)::bigint end;
          if cur_up is null or cur_down is null then
            continue;
          end if;
          if v_reboot then
            d_up := d_up + cur_up;
            d_down := d_down + cur_down;
          else
            v_prev := st_ifaces -> v_name;
            if jsonb_typeof(v_prev) = 'object' then
              prev_up := case when jsonb_typeof(v_prev -> 'up') = 'number'
                then least(greatest(floor((v_prev ->> 'up')::numeric), 0), 1000000000000000)::bigint end;
              prev_down := case when jsonb_typeof(v_prev -> 'down') = 'number'
                then least(greatest(floor((v_prev ->> 'down')::numeric), 0), 1000000000000000)::bigint end;
              if prev_up is not null and prev_down is not null then
                d_up := d_up + case when cur_up >= prev_up then cur_up - prev_up else cur_up end;
                d_down := d_down + case when cur_down >= prev_down then cur_down - prev_down else cur_down end;
              end if;
            end if;
          end if;
        end loop;
      end if;

      if d_up > 0 or d_down > 0 then
        insert into traffic_daily (client, day, up, down, updated_at)
        values (input_client, v_day, d_up, d_down, now())
        on conflict (client, day) do update
          set up = traffic_daily.up + excluded.up,
              down = traffic_daily.down + excluded.down,
              updated_at = now();
      end if;

      st_scope := v_scope;
      if v_boot > 0 then
        st_boot := v_boot;
      end if;
      st_ifaces := v_ifaces;
      st_last_ts := v_ts;
      applied := applied + 1;
    end loop;

    if applied > 0 then
      update traffic_counter_state
        set scope = st_scope, boot = st_boot, interfaces = st_ifaces, last_ts = st_last_ts, updated_at = now()
        where client = input_client;
      -- 顺手清理该节点超出保留窗口（约 400 天）的旧日桶，走主键前缀索引，不需要单独的定时任务。
      delete from traffic_daily where client = input_client and day < current_date - 400;
    end if;
  end if;

  select coalesce(sum(up), 0), coalesce(sum(down), 0) into total_up, total_down
    from traffic_daily
    where client = input_client and day >= input_from::date and day <= input_to::date;
  return jsonb_build_object('up', total_up::bigint, 'down', total_down::bigint, 'applied', applied);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_traffic_import(input_client text, input_days jsonb, input_baseline jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  item jsonb;
  v_day date;
  v_up bigint;
  v_down bigint;
  handled integer := 0;
begin
  if input_days is not null and jsonb_typeof(input_days) = 'array' then
    if jsonb_array_length(input_days) > 400 then
      raise exception 'too_many_days' using errcode = '22023';
    end if;
    for item in select value from jsonb_array_elements(input_days) loop
      begin
        -- is distinct from：缺字段时 jsonb_typeof 是 null，<> 会得到 null 而绕过校验。
        if jsonb_typeof(item) is distinct from 'object'
          or jsonb_typeof(item -> 'up') is distinct from 'number'
          or jsonb_typeof(item -> 'down') is distinct from 'number' then
          continue;
        end if;
        v_day := (item ->> 'date')::date;
        v_up := least(greatest(floor((item ->> 'up')::numeric), 0), 1000000000000000)::bigint;
        v_down := least(greatest(floor((item ->> 'down')::numeric), 0), 1000000000000000)::bigint;
      exception when others then
        continue;
      end;
      if v_day between current_date - 400 and current_date + 2 then
        insert into traffic_daily (client, day, up, down, updated_at)
        values (input_client, v_day, v_up, v_down, now())
        on conflict (client, day) do update
          set up = greatest(traffic_daily.up, excluded.up),
              down = greatest(traffic_daily.down, excluded.down),
              updated_at = now()
          where traffic_daily.up < excluded.up or traffic_daily.down < excluded.down;
      end if;
      handled := handled + 1;
    end loop;
  end if;

  if jsonb_typeof(input_baseline) = 'object'
    and jsonb_typeof(input_baseline -> 'scope') = 'string'
    and coalesce(input_baseline ->> 'scope', '') <> ''
    and jsonb_typeof(input_baseline -> 'interfaces') = 'object'
    and (select count(*) from jsonb_object_keys(input_baseline -> 'interfaces')) <= 128 then
    insert into traffic_counter_state (client, scope, boot, interfaces, last_ts)
    values (
      input_client,
      input_baseline ->> 'scope',
      case when jsonb_typeof(input_baseline -> 'boot') = 'number'
        then greatest(floor((input_baseline ->> 'boot')::numeric), 0)::bigint else 0 end,
      input_baseline -> 'interfaces',
      1
    )
    on conflict (client) do update
      set scope = excluded.scope, boot = excluded.boot, interfaces = excluded.interfaces,
          last_ts = 1, updated_at = now()
      where traffic_counter_state.last_ts = 0;
  end if;

  return jsonb_build_object('days', handled);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_home_ping_rows(input_start text, input_end text, input_row_limit integer DEFAULT 400)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with assigned as (
    select h.client, h.task_id, p.name
    from client_home_ping h
    join ping_tasks p on p.id = h.task_id
    where p.all_clients <> 0 or p.clients ? h.client
  ),
  raw as (
    select a.client, s.time, (s.values_json ->> a.task_id::text)::integer as value
    from assigned a
    join ping_snapshots s on s.client = a.client
    where s.time >= input_start::timestamptz
      and s.time <= input_end::timestamptz
      and s.values_json ? a.task_id::text
  )
  select coalesce(jsonb_object_agg(
    g.client,
    jsonb_build_object('task_id', g.task_id, 'name', g.name, 'rows', g.rows)
  ), '{}'::jsonb)
  from (
    select a.client, a.task_id, a.name,
      coalesce((
        select jsonb_agg(jsonb_build_object('time', r.time, 'value', r.value) order by r.time asc)
        from (
          select time, value from raw
          where raw.client = a.client
          order by time desc
          limit least(greatest(coalesce(input_row_limit, 400), 1), 1000)
        ) r
      ), '[]'::jsonb) as rows
    from assigned a
  ) g;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_insert_monitor_record(input_record jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  observed_at timestamptz;
  client_id text;
  bucket_start timestamptz;
  watermark timestamptz;
begin
  if input_record is null or jsonb_typeof(input_record) <> 'object' then
    return;
  end if;

  client_id := nullif(input_record->>'client', '');
  if client_id is null then
    return;
  end if;

  observed_at := coalesce((input_record->>'time')::timestamptz, now());
  if not cfm_internal.raw_write_allowed('public.records'::regclass, observed_at) then
    return;
  end if;

  insert into public.records (
    client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
    disk, disk_total, net_in, net_out, net_total_up, net_total_down,
    process_count, connections, connections_udp, uptime
  ) values (
    client_id,
    observed_at,
    coalesce((input_record->>'cpu')::double precision, 0),
    coalesce((input_record->>'gpu')::double precision, 0),
    coalesce((input_record->>'ram')::double precision, 0),
    coalesce((input_record->>'ram_total')::double precision, 0),
    coalesce((input_record->>'swap')::double precision, 0),
    coalesce((input_record->>'swap_total')::double precision, 0),
    case when jsonb_typeof(input_record->'load') = 'null' then null
      else coalesce((input_record->>'load')::double precision, 0) end,
    case when jsonb_typeof(input_record->'load5') = 'null' then null
      else coalesce((input_record->>'load5')::double precision, 0) end,
    case when jsonb_typeof(input_record->'load15') = 'null' then null
      else coalesce((input_record->>'load15')::double precision, 0) end,
    (input_record->>'temp')::double precision,
    (input_record->>'disk')::double precision,
    (input_record->>'disk_total')::double precision,
    coalesce((input_record->>'net_in')::double precision, 0),
    coalesce((input_record->>'net_out')::double precision, 0),
    coalesce((input_record->>'net_total_up')::double precision, 0),
    coalesce((input_record->>'net_total_down')::double precision, 0),
    coalesce((input_record->>'process_count')::integer, 0),
    coalesce((input_record->>'connections')::integer, 0),
    coalesce((input_record->>'connections_udp')::integer, 0),
    (input_record->>'uptime')::double precision
  )
  on conflict (client, time) do update set
    cpu = excluded.cpu,
    gpu = excluded.gpu,
    ram = excluded.ram,
    ram_total = excluded.ram_total,
    swap = excluded.swap,
    swap_total = excluded.swap_total,
    load = excluded.load,
    load5 = excluded.load5,
    load15 = excluded.load15,
    temp = excluded.temp,
    disk = excluded.disk,
    disk_total = excluded.disk_total,
    net_in = excluded.net_in,
    net_out = excluded.net_out,
    net_total_up = excluded.net_total_up,
    net_total_down = excluded.net_total_down,
    process_count = excluded.process_count,
    connections = excluded.connections,
    connections_udp = excluded.connections_udp,
    uptime = excluded.uptime;

  bucket_start := date_bin(interval '30 minutes', observed_at, timestamptz '1970-01-01');
  select rs.watermark into watermark
  from cfm_internal.rollup_state rs
  where rs.family = 'host';

  if watermark is not null and bucket_start + interval '30 minutes' <= watermark then
    insert into cfm_internal.rollup_dirty(family, client, task_id, bucket_start)
    values ('host', client_id, 0, bucket_start)
    on conflict do nothing;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_records_range_paged(input_client text, input_start text, input_end text, input_page integer DEFAULT 1, input_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  with
    params as (
      select greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select records.*
      from records, params
      where client = input_client
        and time >= input_start::timestamptz
        and time <= input_end::timestamptz
      order by time desc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn from raw_rows
    ),
    data_rows as (
      select client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows)
      + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_records_range_cursor(input_client text, input_start text, input_end text, input_cursor text DEFAULT NULL::text, input_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select *
      from records, params
      where client = input_client
        and time >= input_start::timestamptz
        and time <= input_end::timestamptz
        and (input_cursor is null or time < input_cursor::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn from raw_rows
    ),
    data_rows as (
      select client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'total', (select count(*) from data_rows)
      + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value
      then (select min(time) from data_rows) else null end
  )) || jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb)
  )
  from params
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_records_range_bucketed(input_client text, input_start text, input_end text, input_bucket_sec integer DEFAULT 900, input_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 900), 60), 86400);
  safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 2000);
  raw_from timestamptz := cfm_internal.read_raw_from('record_preserve_time', input_start::timestamptz);
begin
  return (
    with candidates as (
      select r.time, to_jsonb(r) as record
      from records r
      where r.client = input_client
        and r.time >= input_start::timestamptz and r.time <= input_end::timestamptz
        and (r.time >= raw_from or not exists (
          select 1 from public.host_rollup h where h.client = r.client
            and h.bucket_start = date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01')
            and h.bucket_start >= input_start::timestamptz
            and h.bucket_start + interval '30 minutes' <= least(raw_from, input_end::timestamptz)
        ))
      union all
      select h.last_time,
        coalesce(h.last_record, jsonb_build_object(
          'client', h.client, 'time', h.last_time,
          'cpu', h.sum_cpu / nullif(h.sample_count, 0),
          'ram', h.sum_ram / nullif(h.sample_count, 0), 'ram_total', c.mem_total,
          'swap', h.sum_swap / nullif(h.sample_count, 0), 'swap_total', c.swap_total,
          'disk', case when h.disk_samples is null then null
            else h.sum_disk / nullif(h.disk_samples, 0) end,
          'disk_total', null, 'uptime', null, 'load', null, 'load5', null, 'load15', null, 'temp', null,
          'net_in', h.sum_net_in / nullif(h.sample_count, 0),
          'net_out', h.sum_net_out / nullif(h.sample_count, 0),
          'process_count', h.sum_process_count / nullif(h.sample_count, 0),
          'connections', h.sum_connections / nullif(h.sample_count, 0),
          'connections_udp', h.sum_connections_udp / nullif(h.sample_count, 0)
        )) as record
      from public.host_rollup h join public.clients c on c.uuid = h.client
      where h.client = input_client and h.bucket_start >= input_start::timestamptz
        and h.bucket_start + interval '30 minutes' <= input_end::timestamptz
        and (h.bucket_start + interval '30 minutes' <= raw_from
          or not exists (select 1 from records r where r.client = h.client
            and r.time >= h.bucket_start and r.time < h.bucket_start + interval '30 minutes'))
    ), ranked as (
      select time, record,
        row_number() over (
          partition by floor(extract(epoch from time) / safe_bucket)
          order by time desc
        ) as rn
      from candidates
    )
    select coalesce(jsonb_agg(record order by time asc), '[]'::jsonb)
    from (
      select time, record
      from ranked
      where rn = 1
      order by time desc
      limit safe_limit
    ) row_data
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_records_range_aggregated(input_client text, input_start text, input_end text, input_bucket_sec integer DEFAULT 60, input_limit integer DEFAULT 2000, input_sample_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  -- 桶宽上限给到一天：monitor 兼容层的 step 可达 10080（7 天窗口 + points 下限 60），
  -- 桶宽被压到 3600 时 SQL 的桶和适配器的网格对不上。
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 60), 60), 86400);
  safe_limit integer := least(greatest(coalesce(input_limit, 2000), 1), 4000);
  safe_sample integer := least(greatest(coalesce(input_sample_sec, 60), 3), 3600);
  raw_from timestamptz := cfm_internal.read_raw_from('record_preserve_time', input_start::timestamptz);
begin
  return coalesce((
    with old_rollup as (
      select
        (floor(extract(epoch from h.bucket_start) / safe_bucket)::bigint * safe_bucket) as bucket_ts,
        sum(h.sample_count)::integer as samples,
        sum(h.sum_cpu) as cpu_sum, max(h.max_cpu) as cpu_max,
        sum(h.sum_ram) as ram_sum,
        sum(case when h.disk_samples is not null then h.sum_disk else 0 end) as disk_sum,
        sum(h.sum_swap) as swap_sum,
        sum(coalesce(h.disk_samples, 0)) as disk_samples,
        sum(h.sum_net_in) as net_rx_sum, sum(h.sum_net_out) as net_tx_sum,
        max(h.max_net_in) as net_rx_max, max(h.max_net_out) as net_tx_max,
        sum(h.sum_connections) as tcp_sum, sum(h.sum_connections_udp) as udp_sum,
        sum(h.sum_process_count) as procs_sum
      from public.host_rollup h
      where h.client = input_client
        and h.bucket_start >= input_start::timestamptz
        and h.bucket_start + interval '30 minutes' <= input_end::timestamptz
        and (h.bucket_start + interval '30 minutes' <= raw_from
          or not exists (select 1 from records r where r.client = h.client
            and r.time >= h.bucket_start and r.time < h.bucket_start + interval '30 minutes'))
      group by 1
    ),
    recent_raw as (
      select
        (floor(extract(epoch from r.time) / safe_bucket)::bigint * safe_bucket) as bucket_ts,
        count(*)::integer as samples,
        sum(r.cpu) as cpu_sum, max(r.cpu) as cpu_max,
        sum(r.ram) as ram_sum, sum(r.disk) as disk_sum, sum(r.swap) as swap_sum,
        count(r.disk) as disk_samples,
        sum(r.net_in) as net_rx_sum, sum(r.net_out) as net_tx_sum,
        max(r.net_in) as net_rx_max, max(r.net_out) as net_tx_max,
        sum(r.connections) as tcp_sum, sum(r.connections_udp) as udp_sum,
        sum(r.process_count) as procs_sum
      from records r
      where r.client = input_client
        and r.time >= input_start::timestamptz
        and r.time >= raw_from
        and r.time <= input_end::timestamptz
      group by bucket_ts
    ),
    -- Keep raw rows for incomplete edge buckets even when a rollup exists:
    -- the rollup represents the whole 30-minute bucket and cannot be clipped.
    old_raw_fallback as (
      select
        (floor(extract(epoch from r.time) / safe_bucket)::bigint * safe_bucket) as bucket_ts,
        count(*)::integer as samples,
        sum(r.cpu) as cpu_sum, max(r.cpu) as cpu_max,
        sum(r.ram) as ram_sum, sum(r.disk) as disk_sum, sum(r.swap) as swap_sum,
        count(r.disk) as disk_samples,
        sum(r.net_in) as net_rx_sum, sum(r.net_out) as net_tx_sum,
        max(r.net_in) as net_rx_max, max(r.net_out) as net_tx_max,
        sum(r.connections) as tcp_sum, sum(r.connections_udp) as udp_sum,
        sum(r.process_count) as procs_sum
      from records r
      where r.client = input_client
        and r.time >= input_start::timestamptz
        and r.time < raw_from
        and r.time <= input_end::timestamptz
        and (
          date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01') < input_start::timestamptz
          or date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01') + interval '30 minutes' > input_end::timestamptz
          or not exists (
            select 1 from public.host_rollup h
            where h.client = r.client
              and h.bucket_start = date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01')
          )
        )
      group by bucket_ts
    ),
    aggregate_parts as (
      select * from old_rollup
      union all select * from recent_raw
      union all select * from old_raw_fallback
    ),
    aggregated as (
      select bucket_ts,
        sum(samples)::integer as samples,
        sum(cpu_sum) / nullif(sum(samples), 0) as cpu,
        max(cpu_max) as cpu_max,
        cast(sum(ram_sum) / nullif(sum(samples), 0) as bigint) as mem_used,
        cast(sum(disk_sum) / nullif(sum(disk_samples), 0) as bigint) as disk_used,
        cast(sum(swap_sum) / nullif(sum(samples), 0) as bigint) as swap_used,
        cast(sum(net_rx_sum) / nullif(sum(samples), 0) as bigint) as net_rx,
        cast(sum(net_tx_sum) / nullif(sum(samples), 0) as bigint) as net_tx,
        max(net_rx_max) as net_rx_max, max(net_tx_max) as net_tx_max,
        cast(round(sum(tcp_sum) / nullif(sum(samples), 0)) as bigint) as tcp,
        cast(round(sum(udp_sum) / nullif(sum(samples), 0)) as bigint) as udp,
        cast(round(sum(procs_sum) / nullif(sum(samples), 0)) as bigint) as procs
      from aggregate_parts
      group by bucket_ts
    ),
    limited as (
      select * from aggregated order by bucket_ts desc limit safe_limit
    )
    select jsonb_agg(jsonb_build_object(
      'ts', bucket_ts,
      'samples', samples,
      'minutes', least(safe_bucket / 60, greatest(1, round(samples * safe_sample / 60.0)::integer)),
      'cpu', cpu,
      'cpu_max', cpu_max,
      'mem_used', mem_used,
      'disk_used', disk_used,
      'net_rx', net_rx,
      'net_tx', net_tx,
      'net_rx_max', net_rx_max,
      'net_tx_max', net_tx_max,
      'swap_used', swap_used,
      'tcp', tcp,
      'udp', udp,
      'procs', procs
    ) order by bucket_ts asc)
    from limited
  ), '[]'::jsonb);
end;
$function$;

-- Best-effort Worker fallback when the rollup-backed aggregate RPC is unavailable.
-- It intentionally reads only raw rows and returns the identical JSON shape.
CREATE OR REPLACE FUNCTION public.cfm_records_range_aggregated_raw(input_client text, input_start text, input_end text, input_bucket_sec integer DEFAULT 60, input_limit integer DEFAULT 2000, input_sample_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 60), 60), 86400);
  safe_limit integer := least(greatest(coalesce(input_limit, 2000), 1), 4000);
  safe_sample integer := least(greatest(coalesce(input_sample_sec, 60), 3), 3600);
begin
  return coalesce((
    with raw_buckets as (
      select
        (floor(extract(epoch from r.time) / safe_bucket)::bigint * safe_bucket) as bucket_ts,
        count(*)::integer as samples,
        avg(r.cpu) as cpu,
        max(r.cpu) as cpu_max,
        cast(avg(r.ram) as bigint) as mem_used,
        cast(avg(r.disk) as bigint) as disk_used,
        cast(avg(r.swap) as bigint) as swap_used,
        cast(avg(r.net_in) as bigint) as net_rx,
        cast(avg(r.net_out) as bigint) as net_tx,
        max(r.net_in) as net_rx_max,
        max(r.net_out) as net_tx_max,
        cast(round(avg(r.connections)) as bigint) as tcp,
        cast(round(avg(r.connections_udp)) as bigint) as udp,
        cast(round(avg(r.process_count)) as bigint) as procs
      from public.records r
      where r.client = input_client
        and r.time >= input_start::timestamptz
        and r.time <= input_end::timestamptz
      group by bucket_ts
    ), limited as (
      select * from raw_buckets order by bucket_ts desc limit safe_limit
    )
    select jsonb_agg(jsonb_build_object(
      'ts', bucket_ts,
      'samples', samples,
      'minutes', least(safe_bucket / 60, greatest(1, round(samples * safe_sample / 60.0)::integer)),
      'cpu', cpu,
      'cpu_max', cpu_max,
      'mem_used', mem_used,
      'disk_used', disk_used,
      'net_rx', net_rx,
      'net_tx', net_tx,
      'net_rx_max', net_rx_max,
      'net_tx_max', net_tx_max,
      'swap_used', swap_used,
      'tcp', tcp,
      'udp', udp,
      'procs', procs
    ) order by bucket_ts asc)
    from limited
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_traffic_totals(input_clients jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with wanted as (
    select distinct value as client
    from jsonb_array_elements_text(coalesce(input_clients, '[]'::jsonb))
  ),
  totals as (
    select t.client,
      sum(t.up)::bigint as total_up,
      sum(t.down)::bigint as total_down,
      max(t.day) as latest_day
    from traffic_daily t
    join wanted w on w.client = t.client
    group by t.client
  ),
  latest as (
    select t.client,
      sum(t.up)::bigint as day_up,
      sum(t.down)::bigint as day_down
    from traffic_daily t
    join totals a on a.client = t.client and a.latest_day = t.day
    group by t.client
  )
  select coalesce(jsonb_object_agg(a.client, jsonb_build_object(
    'day_rx', case when a.latest_day between current_date - 1 and current_date + 1
      then coalesce(l.day_down, 0) else 0 end,
    'day_tx', case when a.latest_day between current_date - 1 and current_date + 1
      then coalesce(l.day_up, 0) else 0 end,
    'total_rx', a.total_down,
    'total_tx', a.total_up
  )), '{}'::jsonb)
  from totals a
  left join latest l on l.client = a.client;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.rollup_range(p_family text, p_from timestamp with time zone, p_to timestamp with time zone, p_client text DEFAULT NULL::text, p_task_id integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  inserted integer := 0;
begin
  if p_to <= p_from then
    return 0;
  end if;

  if p_family = 'host' then
    delete from public.host_rollup
    where bucket_start >= p_from and bucket_start < p_to
      and (p_client is null or client = p_client);

    insert into public.host_rollup(
      client, bucket_start, sample_count,
      sum_cpu, min_cpu, max_cpu,
      sum_ram, min_ram, max_ram,
      sum_disk, min_disk, max_disk,
      sum_swap, min_swap, max_swap,
      sum_net_in, min_net_in, max_net_in,
      sum_net_out, min_net_out, max_net_out,
      sum_connections, min_connections, max_connections,
      sum_connections_udp, min_connections_udp, max_connections_udp,
      sum_process_count, min_process_count, max_process_count,
      first_time, last_time, last_record, disk_samples
    )
    select
      r.client,
      date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01'),
      count(*)::integer,
      sum(r.cpu), min(r.cpu), max(r.cpu),
      sum(r.ram), min(r.ram), max(r.ram),
      coalesce(sum(r.disk), 0), min(r.disk), max(r.disk),
      sum(r.swap), min(r.swap), max(r.swap),
      sum(r.net_in), min(r.net_in), max(r.net_in),
      sum(r.net_out), min(r.net_out), max(r.net_out),
      sum(r.connections), min(r.connections), max(r.connections),
      sum(r.connections_udp), min(r.connections_udp), max(r.connections_udp),
      sum(r.process_count), min(r.process_count), max(r.process_count),
      min(r.time), max(r.time),
      (select to_jsonb(latest) from public.records latest
        where latest.client = r.client and latest.time = max(r.time)), count(r.disk)::integer
    from public.records r
    where r.time >= p_from and r.time < p_to
      and (p_client is null or r.client = p_client)
    group by r.client, date_bin(interval '30 minutes', r.time, timestamptz '1970-01-01')
    on conflict (client, bucket_start) do update set
      sample_count = excluded.sample_count,
      sum_cpu = excluded.sum_cpu, min_cpu = excluded.min_cpu, max_cpu = excluded.max_cpu,
      sum_ram = excluded.sum_ram, min_ram = excluded.min_ram, max_ram = excluded.max_ram,
      sum_disk = excluded.sum_disk, min_disk = excluded.min_disk, max_disk = excluded.max_disk,
      sum_swap = excluded.sum_swap, min_swap = excluded.min_swap, max_swap = excluded.max_swap,
      sum_net_in = excluded.sum_net_in, min_net_in = excluded.min_net_in, max_net_in = excluded.max_net_in,
      sum_net_out = excluded.sum_net_out, min_net_out = excluded.min_net_out, max_net_out = excluded.max_net_out,
      sum_connections = excluded.sum_connections,
      min_connections = excluded.min_connections, max_connections = excluded.max_connections,
      sum_connections_udp = excluded.sum_connections_udp,
      min_connections_udp = excluded.min_connections_udp, max_connections_udp = excluded.max_connections_udp,
      sum_process_count = excluded.sum_process_count,
      min_process_count = excluded.min_process_count, max_process_count = excluded.max_process_count,
      first_time = excluded.first_time, last_time = excluded.last_time,
      last_record = excluded.last_record, disk_samples = excluded.disk_samples;
    get diagnostics inserted = row_count;

  elsif p_family = 'ping' then
    delete from public.ping_rollup
    where bucket_start >= p_from and bucket_start < p_to
      and (p_client is null or client = p_client)
      and (p_task_id is null or task_id = p_task_id);

    with expanded as (
      select s.client, s.time, t.id as task_id, item.value as raw_value
      from public.ping_snapshots s
      cross join lateral jsonb_each_text(
        case when jsonb_typeof(s.values_json) = 'object' then s.values_json else '{}'::jsonb end
      ) item
      join public.ping_tasks t
        on t.id = case when item.key ~ '^[0-9]{1,9}$' then item.key::integer end
      join public.clients c on c.uuid = s.client
      where s.time >= p_from and s.time < p_to
        and (p_client is null or s.client = p_client)
        and (p_task_id is null or t.id = p_task_id)
      for key share of t, c
    ), typed as (
      select client, time, task_id,
        case when raw_value ~ '^-?[0-9]{1,10}$'
          then case when raw_value::numeric between -2147483648 and 2147483647
            then raw_value::integer end
        end as value
      from expanded
    )
    insert into public.ping_rollup(
      client, task_id, bucket_start, sample_count, success_count, loss_count,
      sum_latency, sumsq_latency, min_latency, max_latency, p50_latency, p75_latency
    )
    select
      client, task_id,
      date_bin(interval '30 minutes', time, timestamptz '1970-01-01'),
      count(*)::integer,
      count(*) filter (where value >= 0)::integer,
      count(*) filter (where value < 0)::integer,
      coalesce(sum(value) filter (where value >= 0), 0),
      coalesce(sum(value::double precision * value::double precision) filter (where value >= 0), 0),
      min(value) filter (where value >= 0),
      max(value) filter (where value >= 0),
      percentile_cont(0.5) within group (order by value) filter (where value >= 0),
      percentile_cont(0.75) within group (order by value) filter (where value >= 0)
    from typed
    where value is not null
    group by client, task_id, date_bin(interval '30 minutes', time, timestamptz '1970-01-01')
    on conflict (client, task_id, bucket_start) do update set
      sample_count = excluded.sample_count,
      success_count = excluded.success_count,
      loss_count = excluded.loss_count,
      sum_latency = excluded.sum_latency,
      sumsq_latency = excluded.sumsq_latency,
      min_latency = excluded.min_latency,
      max_latency = excluded.max_latency,
      p50_latency = excluded.p50_latency,
      p75_latency = excluded.p75_latency;
    get diagnostics inserted = row_count;

  else
    raise exception 'unknown rollup family: %', p_family using errcode = '22023';
  end if;

  return inserted;
end;
$function$;

CREATE OR REPLACE FUNCTION cfm_internal.rollup_bucket(p_family text, p_client text, p_task_id integer, p_bucket_start timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  has_raw boolean := false;
  bucket_end timestamptz := p_bucket_start + interval '30 minutes';
begin
  if p_family = 'host' then
    select exists (
      select 1 from public.records
      where client = p_client and time >= p_bucket_start and time < bucket_end
    ) into has_raw;
  elsif p_family = 'ping' then
    select exists (
      select 1 from public.ping_snapshots
      where client = p_client and time >= p_bucket_start and time < bucket_end
        and values_json ? p_task_id::text
    ) into has_raw;
  else
    raise exception 'unknown rollup family: %', p_family using errcode = '22023';
  end if;

  -- Raw rows can disappear only when the partition gate has already moved past
  -- the bucket. Keeping the existing rollup is safer than deleting it.
  if not has_raw then
    return 0;
  end if;

  return cfm_internal.rollup_range(
    p_family,
    p_bucket_start,
    bucket_end,
    p_client,
    case when p_family = 'ping' then nullif(p_task_id, 0) else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_build_rollup(input_family text, input_now timestamp with time zone DEFAULT now(), input_max_buckets integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  fam text := lower(coalesce(input_family, ''));
  step constant interval := interval '30 minutes';
  max_buckets integer := least(greatest(coalesce(input_max_buckets, 48), 1), 96);
  retention_hours integer;
  watermark timestamptz;
  earliest timestamptz;
  work_from timestamptz;
  work_to timestamptz;
  floor_now timestamptz;
  dirty record;
  dirty_processed integer := 0;
  buckets integer := 0;
  failed_buckets integer := 0;
  bucket_start_ts timestamptz;
begin
  if fam not in ('host', 'ping') then
    raise exception 'unknown rollup family: %', input_family using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cfm_build_rollup:' || fam));
  perform public.cfm_partition_maintain(input_now);

  for dirty in
    select * from cfm_internal.rollup_dirty
    where family = fam
    order by bucket_start
    limit max_buckets
  loop
    -- Keep failed work queued; successful buckets can still commit independently.
    begin
      perform cfm_internal.rollup_bucket(fam, dirty.client, dirty.task_id, dirty.bucket_start);
      delete from cfm_internal.rollup_dirty
      where family = fam
        and client = dirty.client
        and task_id = dirty.task_id
        and bucket_start = dirty.bucket_start;
      dirty_processed := dirty_processed + 1;
    exception when others then
      failed_buckets := failed_buckets + 1;
    end;
  end loop;

  retention_hours := cfm_internal.retention_hours('rollup_preserve_time');
  floor_now := date_bin(step, input_now, timestamptz '1970-01-01');

  select rs.watermark into watermark
  from cfm_internal.rollup_state rs
  where rs.family = fam
  for update;

  if watermark is null then
    if fam = 'host' then
      select min(r.time) into earliest from public.records r;
    else
      select min(s.time) into earliest from public.ping_snapshots s;
    end if;

    watermark := greatest(
      date_bin(step, coalesce(earliest, input_now), timestamptz '1970-01-01'),
      date_bin(step, input_now - make_interval(hours => retention_hours), timestamptz '1970-01-01')
    );

    insert into cfm_internal.rollup_state(family, watermark)
    values (fam, watermark)
    on conflict (family) do nothing;

    select rs.watermark into watermark
    from cfm_internal.rollup_state rs
    where rs.family = fam
    for update;
  end if;

  work_to := least(floor_now, watermark + max_buckets * step);

  if work_to > watermark then
    work_from := watermark - interval '2 hours';
    begin
      perform cfm_internal.rollup_range(fam, work_from, work_to);
    exception when others then
      -- Advance only through a contiguous successful prefix. A failed bucket
      -- must remain reachable on the next pass, including the overlap window.
      bucket_start_ts := work_from;
      while bucket_start_ts < work_to loop
        begin
          perform cfm_internal.rollup_range(fam, bucket_start_ts, bucket_start_ts + step);
        exception when others then
          failed_buckets := failed_buckets + 1;
          work_to := greatest(watermark, bucket_start_ts);
          exit;
        end;
        bucket_start_ts := bucket_start_ts + step;
      end loop;
    end;
    buckets := floor(extract(epoch from (work_to - watermark)) / 1800)::integer;
    update cfm_internal.rollup_state
    set watermark = work_to, updated_at = input_now
    where family = fam;
  end if;

  select rs.watermark into watermark
  from cfm_internal.rollup_state rs
  where rs.family = fam;

  return jsonb_build_object(
    'family', fam,
    'watermark', watermark,
    'buckets', buckets,
    'dirty', dirty_processed,
    'failed_buckets', failed_buckets,
    'has_more', watermark < floor_now or exists (select 1 from cfm_internal.rollup_dirty where family = fam)
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.cfm_ping_rollup_range(input_client text, input_task_ids jsonb, input_start text DEFAULT NULL::text, input_end text DEFAULT NULL::text, input_step_sec integer DEFAULT 1800, input_limit integer DEFAULT 1500)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with args as (
    select input_client client, coalesce(input_start::timestamptz, now() - interval '30 days') start_at, coalesce(input_end::timestamptz, now()) end_at,
      least(86400::numeric, ceil(greatest(coalesce(input_step_sec,1800),1800)::numeric / 1800) * 1800)::integer step_sec,
      least(greatest(coalesce(input_limit,1500),1),2000) lim,
      coalesce((select watermark from cfm_internal.rollup_state where family = 'ping'), '-infinity'::timestamptz) watermark
  ), ids as (
    select distinct value::integer task_id
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids)='array' then input_task_ids else '[]'::jsonb end) x(value)
    where value ~ '^[0-9]{1,9}$' and value::integer > 0
  ), raw_expanded as (
    select s.client, s.time, item.key task_key, item.value raw_value
    from ping_snapshots s
    cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
    cross join args a
  where s.client=a.client and s.time >= a.start_at and s.time <= a.end_at
    and (s.time >= a.watermark - interval '2 hours'
      or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') < a.start_at
      or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') + interval '30 minutes' > a.end_at)
  ), raw_typed as (
    select client, time,
      case when task_key ~ '^[0-9]{1,9}$' then task_key::integer end task_id,
      case when raw_value ~ '^-?[0-9]{1,10}$'
        then case when raw_value::numeric between -2147483648 and 2147483647 then raw_value::integer end
      end value
    from raw_expanded
  ), base as (
    select r.task_id, r.bucket_start time, r.sample_count, r.success_count, r.loss_count,
      r.sum_latency, r.sumsq_latency, r.min_latency, r.max_latency, r.p50_latency, r.p75_latency
    from ping_rollup r cross join args a
    join ids i on i.task_id=r.task_id
    where r.client=a.client and r.bucket_start >= a.start_at
      and r.bucket_start + interval '30 minutes' <= a.end_at
      and r.bucket_start + interval '30 minutes' <= a.watermark - interval '2 hours'
    union all
    select i.task_id, s.time, 1,
      case when s.value >= 0 then 1 else 0 end,
      case when s.value < 0 then 1 else 0 end,
      case when s.value >= 0 then s.value else 0 end,
      case when s.value >= 0 then s.value::double precision * s.value::double precision else 0 end,
      case when s.value >= 0 then s.value end,
      case when s.value >= 0 then s.value end,
      case when s.value >= 0 then s.value::double precision end,
      case when s.value >= 0 then s.value::double precision end
    from raw_typed s
    join ids i on i.task_id=s.task_id
    cross join args a
    where s.value is not null and (
      date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') < a.start_at
      or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') + interval '30 minutes' > a.end_at
      or s.time >= a.watermark - interval '2 hours'
    )
  ), grouped as (
    select task_id,
      date_bin(make_interval(secs => a.step_sec), time, timestamptz '1970-01-01') bucket_start,
      sum(sample_count)::integer sample_count, sum(success_count)::integer success_count,
      sum(loss_count)::integer loss_count, sum(sum_latency) sum_latency, sum(sumsq_latency) sumsq_latency,
      min(min_latency) min_latency, max(max_latency) max_latency,
      case when a.step_sec = 1800
        then percentile_cont(0.5) within group (order by p50_latency) filter (where p50_latency is not null)
        else sum(p50_latency * success_count) filter (where p50_latency is not null) / nullif(sum(success_count) filter (where p50_latency is not null),0)
      end p50_latency,
      case when a.step_sec = 1800
        then percentile_cont(0.75) within group (order by p75_latency) filter (where p75_latency is not null)
        else sum(p75_latency * success_count) filter (where p75_latency is not null) / nullif(sum(success_count) filter (where p75_latency is not null),0)
      end p75_latency
    from base cross join args a group by task_id, a.step_sec,
      date_bin(make_interval(secs => a.step_sec), time, timestamptz '1970-01-01')
  ), ranked as (
    select *, row_number() over(partition by task_id order by bucket_start desc) rn from grouped
  )
  select coalesce(jsonb_object_agg(task_id::text, rows), '{}'::jsonb) from (
    select task_id, jsonb_agg(jsonb_build_object(
      'time', bucket_start, 'task_id', task_id, 'value', coalesce(p50_latency,-1),
      'sample_count',sample_count,'success_count',success_count,'loss_count',loss_count,
      'avg_latency',sum_latency/nullif(success_count,0),'min_latency',min_latency,'max_latency',max_latency,
      'p50_latency',p50_latency,'p75_latency',p75_latency
    ) order by bucket_start) rows
    from ranked cross join args where rn <= args.lim group by task_id
  ) result;
$function$;

CREATE OR REPLACE FUNCTION public.cfm_ping_stats_from_rollup(input_client text, input_task_ids jsonb, input_start text, input_end text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with args as (
    select input_client client, input_start::timestamptz start_at, input_end::timestamptz end_at,
      coalesce((select watermark from cfm_internal.rollup_state where family = 'ping'), '-infinity'::timestamptz) watermark
  ), ids as (
    select distinct value::integer task_id
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids)='array' then input_task_ids else '[]'::jsonb end) x(value)
    where value ~ '^[0-9]{1,9}$' and value::integer > 0 limit 50
  ), raw_expanded as (
    select s.client, s.time, item.key task_key, item.value raw_value
    from ping_snapshots s
    cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
    cross join args a
    where s.client=a.client and s.time >= a.start_at and s.time <= a.end_at
      and (s.time >= a.watermark - interval '2 hours'
        or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') < a.start_at
        or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') + interval '30 minutes' > a.end_at)
  ), raw_typed as (
    select client, time,
      case when task_key ~ '^[0-9]{1,9}$' then task_key::integer end task_id,
      case when raw_value ~ '^-?[0-9]{1,10}$'
        then case when raw_value::numeric between -2147483648 and 2147483647 then raw_value::integer end
      end value
    from raw_expanded
  ), base as (
    select r.task_id, r.bucket_start time, r.sample_count, r.success_count, r.loss_count,
      r.sum_latency, r.sumsq_latency, r.min_latency, r.max_latency, r.p50_latency, r.p75_latency
    from ping_rollup r cross join args a
    join ids i on i.task_id=r.task_id
    where r.client=a.client and r.bucket_start >= a.start_at
      and r.bucket_start + interval '30 minutes' <= a.end_at
      and r.bucket_start + interval '30 minutes' <= a.watermark - interval '2 hours'
    union all
    -- Compute raw percentiles before merging with historical bucket summaries.
    -- Treating each raw value as a one-sample "percentile" and averaging them
    -- makes both P50 and P75 equal to the arithmetic mean.
    select i.task_id, min(s.time), count(*)::integer,
      count(*) filter (where s.value >= 0)::integer,
      count(*) filter (where s.value < 0)::integer,
      coalesce(sum(s.value) filter (where s.value >= 0), 0),
      coalesce(sum(s.value::double precision * s.value::double precision) filter (where s.value >= 0), 0),
      min(s.value) filter (where s.value >= 0),
      max(s.value) filter (where s.value >= 0),
      percentile_cont(0.5) within group (order by s.value) filter (where s.value >= 0),
      percentile_cont(0.75) within group (order by s.value) filter (where s.value >= 0)
    from raw_typed s
    join ids i on i.task_id=s.task_id
    cross join args a
    where s.value is not null and (
      date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') < a.start_at
      or date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01') + interval '30 minutes' > a.end_at
      or s.time >= a.watermark - interval '2 hours'
    )
    group by i.task_id
  ), agg as (
    select task_id, sum(sample_count)::integer samples, sum(success_count)::integer success_count,
      sum(loss_count)::integer loss_count, sum(sum_latency) sum_latency, sum(sumsq_latency) sumsq_latency,
      min(min_latency) min_latency, max(max_latency) max_latency,
      sum(p50_latency * success_count) filter (where p50_latency is not null)
        / nullif(sum(success_count) filter (where p50_latency is not null),0) p50_latency,
      sum(p75_latency * success_count) filter (where p75_latency is not null)
        / nullif(sum(success_count) filter (where p75_latency is not null),0) p75_latency
    from base group by task_id
  )
  select coalesce(jsonb_object_agg(task_id::text,jsonb_build_object(
    'samples',samples,'success_count',success_count,'loss_count',loss_count,
    'loss_rate',case when samples>0 then loss_count::double precision*100/samples end,
    'avg_latency',sum_latency/nullif(success_count,0),'min_latency',min_latency,'max_latency',max_latency,
    'p50_latency',p50_latency,'p75_latency',p75_latency,
    'jitter',case when success_count>1 then sqrt(greatest(0,
      (sumsq_latency - sum_latency*sum_latency/success_count)/(success_count-1))) end
  )), '{}'::jsonb) from agg;
$function$;





-- 函数权限：public 一律收回，只授权给服务端角色。
-- 用遍历代替逐函数样板：新增 public RPC 会自动收回 PUBLIC 执行权并授权给
-- service_role，不会因为漏写一行而暴露给 anon / authenticated。
do $$
declare
  fn record;
begin
  for fn in
    select format('%I.%I(%s)', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid)) as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname like 'cfm\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;

  -- cfm_internal 默认只允许 owner；需要的调用方在下面显式授权。
  for fn in
    select format('%I.%I(%s)', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid)) as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cfm_internal' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
  end loop;
end $$;

-- 应用角色额外需要的 public RPC（service_role 已由上面的循环授权）。
grant execute on function public.cfm_partition_maintain(timestamp with time zone) to cf_monitor_app;
grant execute on function public.cfm_partition_tree_total_bytes(regclass) to cf_monitor_app;
grant execute on function public.cfm_home_ping_assignments() to cf_monitor_app;
grant execute on function public.cfm_set_home_ping_task(text, bigint) to cf_monitor_app;
grant execute on function public.cfm_home_ping_rows(text, text, integer) to cf_monitor_app;
grant execute on function public.cfm_build_rollup(text, timestamp with time zone, integer) to cf_monitor_app;
grant execute on function public.cfm_ping_rollup_range(text, jsonb, text, text, integer, integer) to cf_monitor_app;
grant execute on function public.cfm_ping_stats_from_rollup(text, jsonb, text, text) to cf_monitor_app;

-- cfm_internal 允许被应用/服务端角色调用的函数。
grant execute on function cfm_internal.setting_hours(text, integer, integer, integer) to cf_monitor_app, service_role;
grant execute on function cfm_internal.retention_hours(text) to cf_monitor_app, service_role;
grant execute on function cfm_internal.read_raw_from(text, timestamp with time zone) to cf_monitor_app, service_role;
grant execute on function cfm_internal.notification_delivery_entity_exists(text, boolean) to service_role;
grant execute on function cfm_internal.notification_delivery_token_matches(text, text) to service_role;
grant execute on function cfm_internal.retire_notification_deliveries(text[]) to service_role;
grant execute on function cfm_internal.retire_client_notification_deliveries(text) to service_role;

create or replace trigger cfm_client_delivery_retirement after delete or update of expired_at on public.clients
for each row execute function cfm_internal.retire_entity_notification_deliveries();

create or replace trigger cfm_offline_delivery_retirement after delete or update on public.offline_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

create or replace trigger cfm_expiry_delivery_retirement after delete or update on public.expiry_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

create or replace trigger cfm_load_delivery_retirement after delete or update on public.load_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

-- 安装引导（幂等）：填充 partition_bounds 并预建原始分区。
-- 必须放在函数定义之后：全新安装执行 1_schema 时维护函数尚不存在。
do $$ begin perform public.cfm_partition_maintain(now()); end $$;

notify pgrst, 'reload schema';
