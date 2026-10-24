-- 全部 RPC 函数的最终定义，以及统一的 EXECUTE 授权（默认只给 service_role）。
-- 每个函数只保留一份定义；历史上的重复 create or replace 已合并。
set local search_path = public;

-- 清理历史遗留的旧签名，必须先于下面的 create 执行。
drop function if exists public.cfm_mark_offline_notification_sent(text, text);
drop function if exists public.cfm_mark_expiry_notification_sent(text, text);
drop function if exists public.cfm_rotate_client_token(text, text);
drop function if exists public.cfm_set_client_install_token(text, text);

-- Phase 1 Worker Data API RPC. These functions are called only by the Worker
-- with Supabase service_role; browsers still talk only to the Worker.
create or replace function public.cfm_public_settings()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from settings;
$$;

create or replace function public.cfm_settings_by_keys(input_keys text[])
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from settings
  where key = any(coalesce(input_keys, array[]::text[]));
$$;

create or replace function public.cfm_set_settings(input_settings jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_settings is null or jsonb_typeof(input_settings) <> 'object' then
    raise exception 'input_settings must be a JSON object';
  end if;

  insert into settings (key, value)
  select key, value
  from jsonb_each_text(input_settings)
  on conflict (key) do update set value = excluded.value;
end;
$$;

create or replace function public.cfm_public_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select
      uuid, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, sort_order, created_at, updated_at
    from clients
    order by sort_order asc, lower(name) asc, created_at asc
  ) row_data;
$$;

create or replace function public.cfm_admin_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_scheduled_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_scheduled_clients_by_ids(input_uuids jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_client(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_client_token_meta(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, coalesce(token_hash, '') as token_hash, name
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_clients_by_ids(input_uuids jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with ids as (
    select distinct on (uuid) uuid, ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    order by uuid, ord
  )
  select coalesce(jsonb_agg(to_jsonb(c) order by ids.ord), '[]'::jsonb)
  from ids
  join clients c on c.uuid = ids.uuid;
$$;

create or replace function public.cfm_client_ids()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(uuid), '[]'::jsonb)
  from clients;
$$;

create or replace function public.cfm_agent_client_by_token(input_token_hash text, input_token text default '')
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_client_token_exists(input_token_hash text, input_token text default '')
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  );
$$;

create or replace function public.cfm_client_create_conflict(input_uuid text, input_token_hash text, input_token text default '')
returns text
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_create_client(input_client jsonb)
returns jsonb
language sql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_agent_client_identity_by_token(input_token_hash text, input_token text default '')
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, token_last_used_ip, token_rotated_at, created_at, name, hidden
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_mark_client_token_used(input_uuid text, input_ip text default '')
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
  normalized_ip text := left(coalesce(trim(input_ip), ''), 128);
begin
  update clients
  set token_last_used_at = now(),
      token_last_used_ip = case when normalized_ip <> '' then normalized_ip else token_last_used_ip end
  where uuid = input_uuid
    and (
      token_last_used_at is null
      or token_last_used_at < now() - interval '15 minutes'
    );
  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_rotate_client_token(input_uuid text, input_token text, input_token_hash text)
returns jsonb
language sql
set search_path = public
as $$
  update clients
  set token = input_token,
      token_hash = input_token_hash,
      token_last_used_at = null,
      token_last_used_ip = '',
      token_rotated_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(clients);
$$;

create or replace function public.cfm_update_client_returning(input_uuid text, input_patch jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_update_client(input_uuid text, input_patch jsonb)
returns boolean
language sql
set search_path = public
as $$
  select public.cfm_update_client_returning(input_uuid, input_patch) is not null;
$$;

create or replace function public.cfm_delete_clients(input_uuids jsonb)
returns jsonb
language sql
set search_path = public
as $$
  with
    ids as (
      select distinct uuid
      from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
      where trim(uuid) <> ''
    ),
    deleted_records as (delete from records where client in (select uuid from ids) returning 1),
    deleted_gpu_records as (delete from gpu_records where client in (select uuid from ids) returning 1),
    deleted_gpu_snapshots as (delete from gpu_snapshots where client in (select uuid from ids) returning 1),
    deleted_ping_records as (delete from ping_records where client in (select uuid from ids) returning 1),
    deleted_ping_snapshots as (delete from ping_snapshots where client in (select uuid from ids) returning 1),
    deleted_clients as (delete from clients where uuid in (select uuid from ids) returning 1)
  select jsonb_build_object(
    'removed', (select count(*) from deleted_clients),
    'deleted_records', jsonb_build_object(
      'records', (select count(*) from deleted_records),
      'gpu_records', (select count(*) from deleted_gpu_records),
      'gpu_snapshots', (select count(*) from deleted_gpu_snapshots),
      'ping_records', (select count(*) from deleted_ping_records),
      'ping_snapshots', (select count(*) from deleted_ping_snapshots)
    )
  );
$$;

create or replace function public.cfm_prune_client_references(input_uuids jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_cleanup_orphan_client_data()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  ping_tasks_updated integer := 0;
  load_notifications_updated integer := 0;
  load_notifications_deleted integer := 0;
  offline_notifications_deleted integer := 0;
  expiry_notifications_deleted integer := 0;
  records_deleted integer := 0;
  gpu_records_deleted integer := 0;
  gpu_snapshots_deleted integer := 0;
  ping_records_deleted integer := 0;
  ping_snapshots_deleted integer := 0;
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
    where l.id = changed.id
      and jsonb_array_length(changed.next_clients) = 0
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
    where l.id = changed.id
      and jsonb_array_length(changed.next_clients) > 0
    returning 1
  )
  select count(*)::integer into load_notifications_updated from updated;

  delete from offline_notifications o where not exists (select 1 from clients c where c.uuid = o.client);
  get diagnostics offline_notifications_deleted = row_count;

  delete from expiry_notifications e where not exists (select 1 from clients c where c.uuid = e.client);
  get diagnostics expiry_notifications_deleted = row_count;

  delete from records r where not exists (select 1 from clients c where c.uuid = r.client);
  get diagnostics records_deleted = row_count;

  delete from gpu_records g where not exists (select 1 from clients c where c.uuid = g.client);
  get diagnostics gpu_records_deleted = row_count;

  delete from gpu_snapshots g where not exists (select 1 from clients c where c.uuid = g.client);
  get diagnostics gpu_snapshots_deleted = row_count;

  delete from ping_records p where not exists (select 1 from clients c where c.uuid = p.client);
  get diagnostics ping_records_deleted = row_count;

  delete from ping_snapshots p where not exists (select 1 from clients c where c.uuid = p.client);
  get diagnostics ping_snapshots_deleted = row_count;

  return jsonb_build_object(
    'ping_tasks_updated', ping_tasks_updated,
    'load_notifications_updated', load_notifications_updated,
    'load_notifications_deleted', load_notifications_deleted,
    'expiry_notifications_deleted', expiry_notifications_deleted,
    'offline_notifications_deleted', offline_notifications_deleted,
    'records_deleted', records_deleted,
    'gpu_records_deleted', gpu_records_deleted,
    'gpu_snapshots_deleted', gpu_snapshots_deleted,
    'ping_records_deleted', ping_records_deleted,
    'ping_snapshots_deleted', ping_snapshots_deleted
  );
end;
$$;

create or replace function public.cfm_update_clients_hidden(input_uuids jsonb, input_hidden boolean)
returns integer
language sql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_reorder_clients(input_uuids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_client_capacity_counts()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'clients', count(*)::integer,
    'gpu_clients', coalesce(sum(case when trim(coalesce(gpu_name, '')) <> '' then 1 else 0 end), 0)::integer
  )
  from clients;
$$;

create or replace function public.cfm_ping_task_estimate_rows()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by sort_order asc, id asc), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, interval_sec, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$$;

create or replace function public.cfm_create_ping_task(input_task jsonb)
returns jsonb
language sql
set search_path = public
as $$
  insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order)
  values (
    coalesce(input_task->>'name', ''),
    case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else '[]'::jsonb end,
    case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end,
    coalesce(input_task->>'type', 'icmp'),
    coalesce(input_task->>'target', ''),
    coalesce((input_task->>'interval_sec')::integer, 60),
    coalesce(nullif((input_task->>'sort_order')::integer, 0), (select coalesce(max(sort_order), 0) + 1 from ping_tasks))
  )
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_update_ping_task(input_id integer, input_task jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update ping_tasks
  set
    name = coalesce(input_task->>'name', name),
    clients = case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else clients end,
    all_clients = case when input_task ? 'all_clients' then case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end else all_clients end,
    type = coalesce(input_task->>'type', type),
    target = coalesce(input_task->>'target', target),
    interval_sec = coalesce((input_task->>'interval_sec')::integer, interval_sec)
  where id = input_id
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_reorder_ping_tasks(input_ids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  input_id integer;
  final_id integer;
  final_ids integer[] := '{}';
  changed_count integer := 0;
  next_order integer := 1;
  old_order integer;
begin
  for input_id in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) as value
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    final_ids := array_append(final_ids, input_id);
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
$$;

create or replace function public.cfm_delete_ping_task(input_id integer)
returns jsonb
language sql
set search_path = public
as $$
  delete from ping_tasks
  where id = input_id
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_delete_old_records(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  records_deleted integer;
  gpu_records_deleted integer;
  gpu_snapshots_deleted integer;
begin
  with doomed as (
    select id from records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into records_deleted from deleted;

  with doomed as (
    select id from gpu_records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from gpu_records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into gpu_records_deleted from deleted;

  with doomed as (
    select id from gpu_snapshots where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from gpu_snapshots where id in (select id from doomed) returning 1
  )
  select count(*)::integer into gpu_snapshots_deleted from deleted;

  return jsonb_build_object(
    'records', records_deleted,
    'gpu_records', gpu_records_deleted,
    'gpu_snapshots', gpu_snapshots_deleted,
    'has_more', exists(select 1 from records where time < input_before_time::timestamptz)
      or exists(select 1 from gpu_records where time < input_before_time::timestamptz)
      or exists(select 1 from gpu_snapshots where time < input_before_time::timestamptz)
  );
end;
$$;

create or replace function public.cfm_delete_old_ping_records(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  ping_records_deleted integer;
  ping_snapshots_deleted integer;
begin
  with doomed as (
    select id from ping_records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from ping_records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into ping_records_deleted from deleted;

  with doomed as (
    select id from ping_snapshots where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from ping_snapshots where id in (select id from doomed) returning 1
  )
  select count(*)::integer into ping_snapshots_deleted from deleted;

  return jsonb_build_object(
    'ping_records', ping_records_deleted,
    'ping_snapshots', ping_snapshots_deleted,
    'has_more', exists(select 1 from ping_records where time < input_before_time::timestamptz)
      or exists(select 1 from ping_snapshots where time < input_before_time::timestamptz)
  );
end;
$$;

create or replace function public.cfm_delete_old_audit_logs(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_offline_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, grace_period, last_notified
    from offline_notifications
  ) row_data;
$$;

create or replace function public.cfm_expiry_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, advance_days, last_notified
    from expiry_notifications
  ) row_data;
$$;

create or replace function public.cfm_set_expiry_notifications(input_items jsonb)
returns integer
language sql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_mark_expiry_notification_sent(input_client text, input_time text, input_token text default null)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_audit_logs_paged(input_page integer default 1, input_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with args as (
    select
      greatest(coalesce(input_page, 1), 1) as safe_page,
      least(greatest(coalesce(input_limit, 50), 1), 500) as safe_limit
  ),
  rows as (
    select id, time, "user", action, detail, level
    from audit_logs, args
    order by time desc
    limit (select safe_limit + 1 from args)
    offset (select (safe_page - 1) * safe_limit from args)
  ),
  limited as (
    select *
    from rows
    limit (select safe_limit from args)
  )
  select jsonb_build_object(
    'logs', coalesce((select jsonb_agg(to_jsonb(limited) order by time desc) from limited), '[]'::jsonb),
    'total', (select (safe_page - 1) * safe_limit from args) + (select count(*) from limited) + case when (select count(*) from rows) > (select safe_limit from args) then 1 else 0 end,
    'has_more', (select count(*) from rows) > (select safe_limit from args)
  )
  );
end;
$$;

create or replace function public.cfm_themes()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by updated_at desc, name asc), '[]'::jsonb)
  from (
    select *
    from themes
    order by updated_at desc, name asc
  ) row_data;
$$;

create or replace function public.cfm_theme(input_short text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from themes
    where short = input_short
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_upsert_theme(input_theme jsonb, input_assets jsonb default '[]'::jsonb)
returns void
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_update_theme_settings(
  input_short text,
  input_config_json text,
  input_custom_css text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
begin
  update themes
  set config_json = input_config_json, custom_css = input_custom_css, updated_at = now()
  where short = input_short;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_delete_theme(input_short text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from themes where short = input_short;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

create or replace function public.cfm_theme_asset(input_short text, input_path text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from theme_assets
    where theme_short = input_short
      and path = input_path
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_load_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by id), '[]'::jsonb)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    order by id asc
  ) row_data;
$$;

create or replace function public.cfm_load_notification(input_id integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    where id = input_id
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_create_load_notification(input_item jsonb)
returns void
language sql
set search_path = public
as $$
  insert into load_notifications (name, clients, metric, threshold, ratio, interval_min)
  values (
    coalesce(input_item->>'name', ''),
    case when jsonb_typeof(input_item->'clients') = 'array' then input_item->'clients' else '[]'::jsonb end,
    coalesce(input_item->>'metric', 'cpu'),
    coalesce((input_item->>'threshold')::double precision, 80),
    coalesce((input_item->>'ratio')::double precision, 0.8),
    coalesce((input_item->>'interval_min')::integer, 15)
  );
$$;

create or replace function public.cfm_load_metric_window_stats(
  input_clients jsonb,
  input_start text,
  input_end text,
  input_metric text,
  input_threshold double precision
)
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_update_load_notification(input_id integer, input_patch jsonb)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_delete_load_notification(input_id integer)
returns void
language sql
set search_path = public
as $$
  delete from load_notifications where id = input_id;
$$;

create or replace function public.cfm_insert_gpu_snapshot(input_client text, input_time text, input_gpus jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_gpus is null or jsonb_typeof(input_gpus) <> 'array' or jsonb_array_length(input_gpus) = 0 then
    return;
  end if;

  insert into gpu_snapshots (client, time, devices_json)
  values (input_client, input_time::timestamptz, input_gpus);
end;
$$;

create or replace function public.cfm_insert_ping_snapshot(input_client text, input_time text, input_results jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  values_json jsonb;
begin
  if input_results is null or jsonb_typeof(input_results) <> 'array' then
    return;
  end if;

  select coalesce(jsonb_object_agg(item->>'taskId', round((item->>'value')::double precision)::integer), '{}'::jsonb)
  into values_json
  from jsonb_array_elements(input_results) item
  where (item->>'taskId') ~ '^[0-9]+$'
    and (item->>'value') is not null;

  if values_json = '{}'::jsonb then
    return;
  end if;

  insert into ping_snapshots (client, time, values_json, batch_hash)
  values (input_client, input_time::timestamptz, values_json,
    encode(sha256(convert_to(values_json::text, 'UTF8')), 'hex'))
  on conflict (client, time, batch_hash) where batch_hash is not null do nothing;
end;
$$;

create or replace function public.cfm_recent_records(input_client text, input_limit integer default 30)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_records_range_limited(
  input_client text,
  input_start text,
  input_end text,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_latest_record_times_for_clients(input_clients jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

create or replace function public.cfm_gpu_records(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with snapshot_rows as (
    select id, client, time, devices_json
    from gpu_snapshots
    where client = input_client
      and (input_start is null or input_end is null or time >= input_start::timestamptz)
      and (input_start is null or input_end is null or time <= input_end::timestamptz)
    order by time desc
    limit least(greatest(coalesce(input_limit, 100), 1), 1000)
  ),
  flat_rows as (
    select
      s.id,
      s.client,
      s.time,
      coalesce((device->>'device_index')::integer, 0) as device_index,
      coalesce(device->>'device_name', '') as device_name,
      coalesce((device->>'mem_total')::double precision, 0) as mem_total,
      coalesce((device->>'mem_used')::double precision, 0) as mem_used,
      coalesce((device->>'utilization')::double precision, 0) as utilization,
      coalesce((device->>'temperature')::double precision, 0) as temperature
    from snapshot_rows s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
  )
  select coalesce(jsonb_agg(to_jsonb(flat_rows) order by time asc, device_index asc), '[]'::jsonb)
  from flat_rows
  );
end;
$$;

create or replace function public.cfm_gpu_records_paged(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_page integer default 1,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    flat_rows as (
      select
        s.id,
        s.client,
        s.time,
        coalesce((device->>'device_index')::integer, 0) as device_index,
        coalesce(device->>'device_name', '') as device_name,
        coalesce((device->>'mem_total')::double precision, 0) as mem_total,
        coalesce((device->>'mem_used')::double precision, 0) as mem_used,
        coalesce((device->>'utilization')::double precision, 0) as utilization,
        coalesce((device->>'temperature')::double precision, 0) as temperature
      from gpu_snapshots s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
      where s.client = input_client
        and (input_start is null or s.time >= input_start::timestamptz)
        and (input_end is null or s.time <= input_end::timestamptz)
      order by s.time desc, device_index asc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select flat_rows.*, row_number() over (order by time asc, device_index asc) as rn
      from flat_rows
    ),
    data_rows as (
      select id, client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
      from numbered, params
      where not ((select count(*) from flat_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc, device_index asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from flat_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from flat_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_gpu_records_cursor(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_cursor text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    flat_rows as (
      select
        s.id,
        s.client,
        s.time,
        coalesce((device->>'device_index')::integer, 0) as device_index,
        coalesce(device->>'device_name', '') as device_name,
        coalesce((device->>'mem_total')::double precision, 0) as mem_total,
        coalesce((device->>'mem_used')::double precision, 0) as mem_used,
        coalesce((device->>'utilization')::double precision, 0) as utilization,
        coalesce((device->>'temperature')::double precision, 0) as temperature
      from gpu_snapshots s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
      where s.client = input_client
        and (input_start is null or s.time >= input_start::timestamptz)
        and (input_end is null or s.time <= input_end::timestamptz)
        and (input_cursor is null or s.time < input_cursor::timestamptz)
      order by s.time desc, device_index asc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select flat_rows.*, row_number() over (order by time asc, device_index asc) as rn
      from flat_rows
    ),
    data_rows as (
      select id, client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
      from numbered, params
      where not ((select count(*) from flat_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc, device_index asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows) + case when (select count(*) from flat_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from flat_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from flat_rows) > params.limit_value then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records(input_client text, input_task_id integer, input_limit integer default 120)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select
      id,
      client,
      input_task_id as task_id,
      time,
      (values_json ->> input_task_id::text)::integer as value
    from ping_snapshots
    where client = input_client
      and values_json ? input_task_id::text
    order by time desc
    limit least(greatest(coalesce(input_limit, 120), 1), 1000)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_ping_records_paged(
  input_client text,
  input_task_id integer,
  input_page integer default 1,
  input_limit integer default 120
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select
        id,
        client,
        input_task_id as task_id,
        time,
        (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client
        and values_json ? input_task_id::text
      order by time desc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records_cursor(
  input_client text,
  input_task_id integer,
  input_cursor text default null,
  input_limit integer default 120
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select
        id,
        client,
        input_task_id as task_id,
        time,
        (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client
        and values_json ? input_task_id::text
        and (input_cursor is null or time < input_cursor::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records_for_tasks(
  input_client text,
  input_task_ids jsonb,
  input_limit integer default 120,
  input_cursor text default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
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
          select
            id,
            client,
            task_id as task_id,
            time,
            (values_json ->> task_id::text)::integer as value
          from ping_snapshots
          where client = input_client
            and values_json ? task_id::text
            and (input_cursor is null or time < input_cursor::timestamptz)
          order by time desc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;

  return result;
end;
$$;

-- 历史表的真实磁盘占用（含索引与 TOAST）。
-- 熔断必须按字节量：Supabase 卡的是磁盘字节，而同样行数可能对应 72MB 也可能 189MB，
-- 数行数还完全不含索引开销，熔断点落不到真正快满的地方。
create or replace function public.cfm_history_storage_bytes()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'records', pg_total_relation_size('public.records'),
    'gpu_records', pg_total_relation_size('public.gpu_records'),
    'gpu_snapshots', pg_total_relation_size('public.gpu_snapshots'),
    'ping_records', pg_total_relation_size('public.ping_records'),
    'ping_snapshots', pg_total_relation_size('public.ping_snapshots'),
    'total', pg_total_relation_size('public.records')
      + pg_total_relation_size('public.gpu_records')
      + pg_total_relation_size('public.gpu_snapshots')
      + pg_total_relation_size('public.ping_records')
      + pg_total_relation_size('public.ping_snapshots')
  );
$$;

-- Live tuple size is measured; index/page overhead is a planning allowance, not
-- a claim of exact physical usage or reusable space. DELETE immediately removes
-- visible rows while PostgreSQL can keep the allocated files for later reuse.
create or replace function public.cfm_history_storage_usage()
returns jsonb
language sql
stable
set search_path = public
as $$
  with table_usage as (
    select 'records' as table_name, count(*)::bigint as live_rows,
      coalesce(sum(pg_column_size(row_data)), 0)::bigint as live_row_bytes,
      pg_total_relation_size('public.records') as allocated_bytes from records row_data
    union all
    select 'gpu_records', count(*)::bigint, coalesce(sum(pg_column_size(row_data)), 0)::bigint,
      pg_total_relation_size('public.gpu_records') from gpu_records row_data
    union all
    select 'gpu_snapshots', count(*)::bigint, coalesce(sum(pg_column_size(row_data)), 0)::bigint,
      pg_total_relation_size('public.gpu_snapshots') from gpu_snapshots row_data
    union all
    select 'ping_records', count(*)::bigint, coalesce(sum(pg_column_size(row_data)), 0)::bigint,
      pg_total_relation_size('public.ping_records') from ping_records row_data
    union all
    select 'ping_snapshots', count(*)::bigint, coalesce(sum(pg_column_size(row_data)), 0)::bigint,
      pg_total_relation_size('public.ping_snapshots') from ping_snapshots row_data
  )
  select jsonb_build_object(
    'live_rows', sum(live_rows),
    'live_row_bytes', sum(live_row_bytes),
    'estimated_live_storage_bytes', sum(live_row_bytes + live_rows * 192),
    'allocated_bytes', sum(allocated_bytes),
    'reusable_bytes', null,
    'measurement', 'live-row-bytes-plus-index-estimate',
    'index_page_allowance_bytes_per_row', 192,
    'tables', jsonb_object_agg(table_name, jsonb_build_object(
      'live_rows', live_rows, 'live_row_bytes', live_row_bytes,
      'estimated_live_storage_bytes', live_row_bytes + live_rows * 192,
      'allocated_bytes', allocated_bytes
    ))
  ) from table_usage;
$$;

create or replace function public.cfm_bounded_storage_row_counts(input_limit integer default 100000)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    args as (
      select greatest(coalesce(input_limit, 100000), 1)::integer as safe_limit
    ),
    raw_counts as (
      select
        (select count(*) from (select 1 from records limit (select safe_limit + 1 from args)) s)::integer as records,
        (select count(*) from (select 1 from gpu_records limit (select safe_limit + 1 from args)) s)::integer as gpu_records,
        (select count(*) from (select 1 from gpu_snapshots limit (select safe_limit + 1 from args)) s)::integer as gpu_snapshots,
        (select count(*) from (select 1 from ping_records limit (select safe_limit + 1 from args)) s)::integer as ping_records,
        (select count(*) from (select 1 from ping_snapshots limit (select safe_limit + 1 from args)) s)::integer as ping_snapshots,
        (select count(*) from (select 1 from audit_logs limit (select safe_limit + 1 from args)) s)::integer as audit_logs
    )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'records', least(raw_counts.records, args.safe_limit),
      'gpu_records', least(raw_counts.gpu_records, args.safe_limit),
      'gpu_snapshots', least(raw_counts.gpu_snapshots, args.safe_limit),
      'ping_records', least(raw_counts.ping_records, args.safe_limit),
      'ping_snapshots', least(raw_counts.ping_snapshots, args.safe_limit),
      'audit_logs', least(raw_counts.audit_logs, args.safe_limit)
    ),
    'capped', jsonb_strip_nulls(jsonb_build_object(
      'records', case when raw_counts.records > args.safe_limit then true end,
      'gpu_records', case when raw_counts.gpu_records > args.safe_limit then true end,
      'gpu_snapshots', case when raw_counts.gpu_snapshots > args.safe_limit then true end,
      'ping_records', case when raw_counts.ping_records > args.safe_limit then true end,
      'ping_snapshots', case when raw_counts.ping_snapshots > args.safe_limit then true end,
      'audit_logs', case when raw_counts.audit_logs > args.safe_limit then true end
    )),
    'limit', args.safe_limit
  )
  from args, raw_counts
  );
end;
$$;

create or replace function public.cfm_expired_row_counts(
  input_records_before text,
  input_ping_records_before text,
  input_audit_logs_before text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'records', (select count(*) from records where time < input_records_before::timestamptz),
    'gpu_records', (select count(*) from gpu_records where time < input_records_before::timestamptz),
    'gpu_snapshots', (select count(*) from gpu_snapshots where time < input_records_before::timestamptz),
    'ping_records', (select count(*) from ping_records where time < input_ping_records_before::timestamptz),
    'ping_snapshots', (select count(*) from ping_snapshots where time < input_ping_records_before::timestamptz),
    'audit_logs', (select count(*) from audit_logs where time < input_audit_logs_before::timestamptz)
  );
$$;

create or replace function public.cfm_public_ping_tasks()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, type, target, interval_sec, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$$;

create or replace function public.cfm_users_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
  from users;
$$;

create or replace function public.cfm_update_user_password(input_uuid text, input_passwd text)
returns void
language plpgsql
set search_path = public
as $$
begin
  update users
  set passwd = input_passwd,
      updated_at = now()
  where uuid = input_uuid;
end;
$$;

create or replace function public.cfm_update_user_password_rotate_session(input_uuid text, input_passwd text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set passwd = input_passwd,
      session_version = session_version + 1,
      password_changed_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

create or replace function public.cfm_validate_admin_session(user_uuid text, expected_session_version int)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, session_version
    from users
    where uuid = user_uuid
      and session_version = expected_session_version
    limit 1
  ) row_data;
$$;

-- Initial creation is deliberately separate from password recovery. A stale
-- HTTP count=0 cannot authorize replacing a user created by another request.
create or replace function public.cfm_create_initial_admin(p_uuid text, p_username text, p_password_hash text)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_login_rate_limits(input_buckets jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with buckets as (
    select distinct value as bucket
    from jsonb_array_elements_text(case when jsonb_typeof(input_buckets) = 'array' then input_buckets else '[]'::jsonb end)
    where trim(value) <> ''
  )
  select coalesce(jsonb_agg(to_jsonb(l) order by l.bucket), '[]'::jsonb)
  from login_rate_limits l
  join buckets b on b.bucket = l.bucket;
$$;

-- Derive increments from the current row inside a single RPC transaction. Sorted
-- buckets give overlapping multi-bucket requests a consistent row-lock order.
create or replace function public.cfm_record_login_failures(input_buckets jsonb, input_failed_at text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
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
$$;

create or replace function public.cfm_clear_observed_login_failures(input_states jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  delete from public.login_rate_limits as limits
  using jsonb_array_elements(case when jsonb_typeof(input_states) = 'array' then input_states else '[]'::jsonb end) as observed(value)
  where limits.bucket = observed.value->>'bucket'
    and limits.failure_revision = (observed.value->>'failure_revision')::uuid;
$$;

create or replace function public.cfm_delete_login_rate_limits_before(input_before_time text)
returns void
language sql
set search_path = public
as $$
  delete from login_rate_limits
  where last_failed_at < input_before_time::timestamptz
    and (locked_until is null or locked_until < now());
$$;

create or replace function public.cfm_clear_all_records()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  deleted_records integer := 0;
  deleted_gpu_records integer := 0;
  deleted_gpu_snapshots integer := 0;
  deleted_ping_records integer := 0;
  deleted_ping_snapshots integer := 0;
begin
  with deleted as (delete from records returning 1)
  select count(*)::integer into deleted_records from deleted;

  with deleted as (delete from gpu_records returning 1)
  select count(*)::integer into deleted_gpu_records from deleted;

  with deleted as (delete from gpu_snapshots returning 1)
  select count(*)::integer into deleted_gpu_snapshots from deleted;

  with deleted as (delete from ping_records returning 1)
  select count(*)::integer into deleted_ping_records from deleted;

  with deleted as (delete from ping_snapshots returning 1)
  select count(*)::integer into deleted_ping_snapshots from deleted;

  return jsonb_build_object(
    'deleted', jsonb_build_object(
      'records', deleted_records,
      'gpu_records', deleted_gpu_records,
      'gpu_snapshots', deleted_gpu_snapshots,
      'ping_records', deleted_ping_records,
      'ping_snapshots', deleted_ping_snapshots
    ),
    'remaining', jsonb_build_object(
      'records', 0,
      'gpu_records', 0,
      'gpu_snapshots', 0,
      'ping_records', 0,
      'ping_snapshots', 0
    ),
    'has_more', false
  );
end;
$$;

create or replace function public.cfm_clear_client_records(input_client text)
returns void
language sql
set search_path = public
as $$
  delete from records where client = input_client;
  delete from gpu_records where client = input_client;
  delete from gpu_snapshots where client = input_client;
  delete from ping_records where client = input_client;
  delete from ping_snapshots where client = input_client;
$$;

create or replace function public.cfm_restore_backup_data(input_backup jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  client_ids text[];
  task_ids bigint[];
begin
  if input_backup is null or jsonb_typeof(input_backup) <> 'object' then
    raise exception 'backup must be a JSON object';
  end if;

  if input_backup ? 'settings' and jsonb_typeof(input_backup->'settings') = 'object' then
    insert into settings (key, value)
    select key, value
    from jsonb_each_text(input_backup->'settings')
    where trim(key) <> ''
    on conflict (key) do update set value = excluded.value;
  end if;

  if input_backup ? 'clients' and jsonb_typeof(input_backup->'clients') = 'array' then
    select coalesce(array_agg(uuid), array[]::text[]) into client_ids
    from (
      select nullif(trim(value->>'uuid'), '') as uuid
      from jsonb_array_elements(input_backup->'clients')
    ) rows
    where uuid is not null;

    delete from records where not (client = any(client_ids));
    delete from gpu_records where not (client = any(client_ids));
    delete from gpu_snapshots where not (client = any(client_ids));
    delete from ping_records where not (client = any(client_ids));
    delete from ping_snapshots where not (client = any(client_ids));
    delete from offline_notifications where not (client = any(client_ids));
    delete from expiry_notifications where not (client = any(client_ids));
    delete from clients where not (uuid = any(client_ids));

    for item in select value from jsonb_array_elements(input_backup->'clients')
    loop
      if nullif(trim(item->>'uuid'), '') is null then
        continue;
      end if;

      insert into clients (
        uuid, token, token_hash, token_last_used_at, token_last_used_ip, token_rotated_at,
        name, cpu_name, virtualization, arch, cpu_cores, os, kernel_version, gpu_name,
        ipv4, ipv6, region, remark, public_remark, mem_total, swap_total, disk_total,
        version, price, billing_cycle, auto_renewal, currency, expired_at, "group", tags,
        hidden, traffic_limit, traffic_limit_type, traffic_reset_day, sort_order, created_at, updated_at
      )
      values (
        item->>'uuid',
        nullif(item->>'token', ''),
        nullif(item->>'token_hash', ''),
        nullif(item->>'token_last_used_at', '')::timestamptz,
        coalesce(item->>'token_last_used_ip', ''),
        nullif(item->>'token_rotated_at', '')::timestamptz,
        coalesce(item->>'name', ''),
        coalesce(item->>'cpu_name', ''),
        coalesce(item->>'virtualization', ''),
        coalesce(item->>'arch', ''),
        coalesce((item->>'cpu_cores')::integer, 0),
        coalesce(item->>'os', ''),
        coalesce(item->>'kernel_version', ''),
        coalesce(item->>'gpu_name', ''),
        coalesce(item->>'ipv4', ''),
        coalesce(item->>'ipv6', ''),
        coalesce(item->>'region', ''),
        coalesce(item->>'remark', ''),
        coalesce(item->>'public_remark', ''),
        coalesce((item->>'mem_total')::bigint, 0),
        coalesce((item->>'swap_total')::bigint, 0),
        coalesce((item->>'disk_total')::bigint, 0),
        coalesce(item->>'version', ''),
        coalesce((item->>'price')::double precision, 0),
        coalesce((item->>'billing_cycle')::smallint, 0),
        case when coalesce((item->>'auto_renewal')::boolean, false) then 1 else 0 end,
        coalesce(item->>'currency', '$'),
        nullif(item->>'expired_at', '')::timestamptz,
        coalesce(item->>'group', ''),
        coalesce(item->>'tags', ''),
        case when coalesce((item->>'hidden')::boolean, false) then 1 else 0 end,
        coalesce((item->>'traffic_limit')::bigint, 0),
        -- 兜底值与 cfm_create_client / cfm_update_client 保持一致（'sum'）；
        -- 还原路径漏改会让从旧备份恢复的节点静默回到 'max' 口径。
        coalesce(nullif(item->>'traffic_limit_type', ''), 'sum'),
        -- 缺省补 1 并钳到 1~31：列上有 check 约束，直接写 0 会让整个还原事务失败。
        least(greatest(coalesce((item->>'traffic_reset_day')::smallint, 1), 1), 31),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (uuid) do update set
        token = excluded.token,
        token_hash = excluded.token_hash,
        token_last_used_at = excluded.token_last_used_at,
        token_last_used_ip = excluded.token_last_used_ip,
        token_rotated_at = excluded.token_rotated_at,
        name = excluded.name,
        cpu_name = excluded.cpu_name,
        virtualization = excluded.virtualization,
        arch = excluded.arch,
        cpu_cores = excluded.cpu_cores,
        os = excluded.os,
        kernel_version = excluded.kernel_version,
        gpu_name = excluded.gpu_name,
        ipv4 = excluded.ipv4,
        ipv6 = excluded.ipv6,
        region = excluded.region,
        remark = excluded.remark,
        public_remark = excluded.public_remark,
        mem_total = excluded.mem_total,
        swap_total = excluded.swap_total,
        disk_total = excluded.disk_total,
        version = excluded.version,
        price = excluded.price,
        billing_cycle = excluded.billing_cycle,
        auto_renewal = excluded.auto_renewal,
        currency = excluded.currency,
        expired_at = excluded.expired_at,
        "group" = excluded."group",
        tags = excluded.tags,
        hidden = excluded.hidden,
        traffic_limit = excluded.traffic_limit,
        traffic_limit_type = excluded.traffic_limit_type,
        traffic_reset_day = excluded.traffic_reset_day,
        sort_order = excluded.sort_order,
        updated_at = now();
      perform cfm_internal.retire_client_notification_deliveries(item->>'uuid');
    end loop;
  end if;

  if input_backup ? 'ping_tasks' and jsonb_typeof(input_backup->'ping_tasks') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into task_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'ping_tasks')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    lock table ping_tasks in share row exclusive mode;
    perform setval(pg_get_serial_sequence('ping_tasks', 'id'),
      greatest(
        coalesce((select max(id) from ping_tasks), 0) + 1,
        coalesce((select max(id) from unnest(task_ids) as restored(id)), 0) + 1,
        nextval(pg_get_serial_sequence('ping_tasks', 'id'))
      ), false);
    if coalesce(array_length(task_ids, 1), 0) > 0 then
      delete from ping_tasks where not (id = any(task_ids));
    else
      delete from ping_tasks where true;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'ping_tasks')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, (item->>'id')::integer)
        )
        on conflict (id) do update set
          name = excluded.name,
          clients = excluded.clients,
          all_clients = excluded.all_clients,
          type = excluded.type,
          target = excluded.target,
          interval_sec = excluded.interval_sec,
          sort_order = excluded.sort_order;
      else
        insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, 0)
        );
      end if;
    end loop;
  end if;

  if input_backup ? 'offline_notifications' and jsonb_typeof(input_backup->'offline_notifications') = 'array' then
    delete from offline_notifications where true;
    insert into offline_notifications (client, enable, grace_period, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'grace_period')::integer, 180),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'offline_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'expiry_notifications' and jsonb_typeof(input_backup->'expiry_notifications') = 'array' then
    delete from expiry_notifications where true;
    insert into expiry_notifications (client, enable, advance_days, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'advance_days')::integer, 7),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'expiry_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'load_notifications' and jsonb_typeof(input_backup->'load_notifications') = 'array' then
    lock table load_notifications in share row exclusive mode;
    perform setval(pg_get_serial_sequence('load_notifications', 'id'),
      greatest(
        coalesce((select max(id) from load_notifications), 0) + 1,
        coalesce((select max(case when coalesce(value->>'id', '') ~ '^[0-9]+$'
          then (value->>'id')::bigint else 0 end)
          from jsonb_array_elements(input_backup->'load_notifications')), 0) + 1,
        nextval(pg_get_serial_sequence('load_notifications', 'id'))
      ), false);
    delete from load_notifications where true;
    for item in select value from jsonb_array_elements(input_backup->'load_notifications')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into load_notifications (id, name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      else
        insert into load_notifications (name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      end if;
    end loop;
  end if;
end;
$$;

create or replace function public.cfm_insert_audit_log(
  input_user text,
  input_action text,
  input_detail text,
  input_level text default 'info'
)
returns void
language sql
set search_path = public
as $$
  insert into audit_logs ("user", action, detail, level)
  values (
    coalesce(input_user, ''),
    coalesce(input_action, ''),
    coalesce(input_detail, ''),
    coalesce(nullif(input_level, ''), 'info')
  );
$$;

-- 审计节流：把「读上次时间 → 判断是否过期 → 写新时间」压成一条语句。
-- 拆成读写两步时，两个并发请求会读到同一个旧时间戳、同时判定可写，同一条错误
-- 于是落两行审计日志——节流形同虚设。这里靠 settings 主键冲突串行化：抢到的
-- 那一方 do update 生效并被 returning 命中，没抢到的一方 where 为假、返回零行。
-- 时间戳用调用方传入的 input_now 而不是服务端 now()：健康事件的其它时间戳全部
-- 由 Worker 自己的时钟生成，这里混入服务端时钟会让同一事件的两个时间戳分属两套
-- 钟，之后的比较不可解释。
-- 值一律写成定宽 UTC ISO-8601（与 Worker 的 Date#toISOString 同格式），因此过期
-- 判断直接按字符串比大小即可：各字段等宽零填充且标点位置一致，字典序等于时间序。
-- 不 cast 成 timestamptz 是有意为之——cast 遇到脏值会抛异常，而这条路径本来就只
-- 在系统已经出错时才走，不该再引入一个新的失败点。格式不匹配的脏值一律当作已
-- 过期放行，与 JS 版 Date.parse 解析失败即放行的行为一致。
create or replace function public.cfm_try_claim_audit_throttle(
  input_key text,
  input_now timestamptz,
  input_throttle_ms bigint
)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

-- -----------------------------------------------------------------------------
create or replace function public.cfm_rotate_user_session(input_uuid text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

create or replace function public.cfm_update_user_username_rotate_session(input_uuid text, input_username text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set username = input_username,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

-- -----------------------------------------------------------------------------
create or replace function public.cfm_login_user(input_username text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where username = input_username
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_user_by_uuid(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_enable_user_totp(
  input_uuid text,
  input_secret_enc text,
  input_recovery_code_hashes jsonb,
  input_used_step bigint
)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_disable_user_totp(input_uuid text)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_replace_user_recovery_codes(
  input_uuid text,
  input_recovery_code_hashes jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_consume_totp_step(input_uuid text, input_step bigint)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_consume_recovery_code(input_uuid text, input_code_hash text)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_recover_single_admin(input_uuid text, input_username text, input_passwd text)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_set_offline_notifications(input_items jsonb)
returns integer
language sql
set search_path = public
as $$
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
      end
    where offline_notifications.enable is distinct from excluded.enable
       or offline_notifications.grace_period is distinct from excluded.grace_period
       or (excluded.enable = 0 and offline_notifications.last_notified is not null)
    returning client
  )
  select count(*)::integer from upserted;
$$;

create or replace function public.cfm_mark_offline_notification_sent(input_client text, input_time text, input_token text default null)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

-- Unknown key formats have no inferred owner. Known formats retain the complete
-- client ID after their structural prefix, including any additional colons.
create or replace function cfm_internal.notification_delivery_entity_exists(input_key text, input_lock boolean default false)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function cfm_internal.retire_notification_deliveries(input_keys text[])
returns void
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function cfm_internal.retire_client_notification_deliveries(input_client text)
returns void
language sql
set search_path = public
as $$
  select cfm_internal.retire_notification_deliveries(coalesce(array_agg(key order by key), array[]::text[]))
  from cfm_internal.notification_delivery_state
  where key in ('offline:' || input_client, 'expiry:' || input_client)
    or (key ~ '^load:[0-9]+:.+$' and substring(key from '^load:[0-9]+:(.+)$') = input_client);
$$;

create or replace function public.cfm_claim_notification_delivery(
  input_key text, input_event_id text, input_now timestamptz, input_repeat_ms bigint default 0
)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_complete_notification_delivery(
  input_key text, input_event_id text, input_token text, input_success boolean,
  input_now timestamptz, input_repeat_ms bigint default 0
)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

-- All configuration modules are read in the calling query's shared snapshot.
-- Keep this STABLE and one SELECT; separate RPCs cannot provide that guarantee.
create or replace function public.cfm_backup_configuration_snapshot()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'settings', public.cfm_public_settings(),
    'clients', public.cfm_admin_clients(),
    'ping_tasks', public.cfm_public_ping_tasks(),
    'offline_notifications', public.cfm_offline_notifications(),
    'expiry_notifications', public.cfm_expiry_notifications(),
    'load_notifications', public.cfm_load_notifications()
  );
$$;

create or replace function cfm_internal.retire_entity_notification_deliveries()
returns trigger
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_cleanup_notification_delivery_state(
  input_now timestamptz, input_batch_size integer default 1000, input_max_batches integer default 1
)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function cfm_internal.notification_delivery_token_matches(input_key text, input_token text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  perform 1 from cfm_internal.notification_delivery_state
  where key = input_key and claim_token = input_token and status = 'sent' and retired_at is null
  for update;
  return found;
end;
$$;

create or replace function public.cfm_mark_load_notification_sent(
  input_id integer, input_client text, input_time text, input_token text
)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;

create or replace function public.cfm_ping_records_for_tasks_range(input_client text, input_task_ids jsonb, input_start text default null, input_end text default null, input_limit integer default 1000)
returns jsonb language plpgsql stable set search_path = public as $$
declare task_id integer; safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 1000); result jsonb := '{}'::jsonb;
begin
  for task_id in select distinct value::integer from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end) as item(value) where value ~ '^[0-9]+$' and value::integer > 0 loop
    result := result || jsonb_build_object(task_id::text, coalesce((select jsonb_agg(to_jsonb(row_data) order by time asc) from (select id, client, task_id, time, (values_json ->> task_id::text)::integer as value from ping_snapshots where client = input_client and values_json ? task_id::text and (input_start is null or time >= input_start::timestamptz) and (input_end is null or time <= input_end::timestamptz) order by time desc limit safe_limit) row_data), '[]'::jsonb));
  end loop;
  return result;
end;
$$;

-- Build closed hourly buckets. This is intentionally an incremental operation:
-- callers pass the last processed time and never rank the whole history table.
create or replace function public.cfm_build_history_rollup(input_before text default null)
returns jsonb language plpgsql set search_path = public as $$
declare before_ts timestamptz := coalesce(nullif(input_before, '')::timestamptz, now() - interval '24 hours');
begin
  insert into gpu_rollup (client, device_index, bucket_start, sample_count, avg_values, min_values, max_values, first_time, last_time)
  select s.client, coalesce((d->>'device_index')::integer,0), date_trunc('hour',s.time), count(*)::integer,
    jsonb_build_object('utilization',avg((d->>'utilization')::double precision),'mem_used',avg((d->>'mem_used')::double precision),'temperature',avg((d->>'temperature')::double precision)),
    jsonb_build_object('utilization',min((d->>'utilization')::double precision),'mem_used',min((d->>'mem_used')::double precision),'temperature',min((d->>'temperature')::double precision)),
    jsonb_build_object('utilization',max((d->>'utilization')::double precision),'mem_used',max((d->>'mem_used')::double precision),'temperature',max((d->>'temperature')::double precision)), min(s.time), max(s.time)
  from gpu_snapshots s cross join lateral jsonb_array_elements(s.devices_json) d
  where s.time < before_ts and s.time >= before_ts - interval '2 hours'
  group by s.client, coalesce((d->>'device_index')::integer,0), date_trunc('hour',s.time)
  on conflict (client,device_index,bucket_start) do update set sample_count=excluded.sample_count, avg_values=excluded.avg_values, min_values=excluded.min_values, max_values=excluded.max_values, first_time=excluded.first_time, last_time=excluded.last_time;

  return jsonb_build_object('before', before_ts);
end;
$$;

create or replace function public.cfm_gpu_rollup_range(input_client text, input_start text, input_end text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(avg_values || jsonb_build_object('client',client,'device_index',device_index,'time',bucket_start,'_min',min_values,'_max',max_values) order by bucket_start,device_index),'[]'::jsonb)
  from gpu_rollup where client=input_client and bucket_start >= input_start::timestamptz and bucket_start <= input_end::timestamptz;
$$;

create or replace function public.cfm_ping_records_for_tasks_range_bucketed(
  input_client text,
  input_task_ids jsonb,
  input_start text default null,
  input_end text default null,
  input_bucket_sec integer default 900,
  input_limit integer default 1000
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  tid integer;
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 900), 60), 3600);
  safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 1000);
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
          select
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
          order by time asc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;
  return result;
end;
$$;

-- 整个时间窗口的 Ping 统计（任务卡片用）：一次扫描、对原始样本直接计算，
-- 不依赖前端拿到的分桶/截断后的点，所以任何时间档下数字都一致。
-- jitter 是成功样本延迟的样本标准差（ms）；不足 2 个成功样本时为 null。
create or replace function public.cfm_ping_stats_for_tasks_range(
  input_client text,
  input_task_ids jsonb,
  input_start text default null,
  input_end text default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with ids as (
    select distinct value::integer as tid
    from jsonb_array_elements_text(
      case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end
    ) as item(value)
    where value ~ '^[0-9]{1,9}$' and value::integer > 0
    limit 50
  ),
  raw as (
    select i.tid, (s.values_json ->> i.tid::text)::integer as v
    from ids i
    join ping_snapshots s
      on s.client = input_client
     and s.values_json ? i.tid::text
     and (input_start is null or s.time >= input_start::timestamptz)
     and (input_end is null or s.time <= input_end::timestamptz)
  ),
  agg as (
    select
      tid,
      count(*)::integer as samples,
      count(*) filter (where v >= 0)::integer as success_count,
      count(*) filter (where v < 0)::integer as loss_count,
      avg(v) filter (where v >= 0) as avg_latency,
      min(v) filter (where v >= 0) as min_latency,
      max(v) filter (where v >= 0) as max_latency,
      percentile_cont(0.5) within group (order by v) filter (where v >= 0) as p50_latency,
      percentile_cont(0.75) within group (order by v) filter (where v >= 0) as p75_latency,
      stddev_samp(v) filter (where v >= 0) as jitter
    from raw
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
        'avg_latency', avg_latency,
        'min_latency', min_latency,
        'max_latency', max_latency,
        'p50_latency', p50_latency,
        'p75_latency', p75_latency,
        'jitter', jitter
      )
    ),
    '{}'::jsonb
  )
  from agg;
$$;

-- 节点 -> 任务 id。任务已不再作用于该节点（被移出 clients 列表）时不返回，
-- 避免后台下拉框里出现一个已经无效的选中项。
create or replace function public.cfm_home_ping_assignments()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(h.client, h.task_id), '{}'::jsonb)
  from client_home_ping h
  join ping_tasks p on p.id = h.task_id
  where p.all_clients <> 0 or p.clients ? h.client;
$$;

-- input_task_id 为 null 表示取消首页探测点。
create or replace function public.cfm_set_home_ping_task(input_client text, input_task_id bigint)
returns jsonb
language plpgsql
set search_path = public
as $$
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
$$;

-- 一次性取出所有已设置首页探测点的节点在 [input_start, input_end] 内最新 N 行原始快照。
-- ping_snapshots 按落库间隔全量保存，不做「值没变不落库」压缩，
-- 所以直接倒序取 limit 行再由 Worker 按时间升序排列即可，无需种子与分桶。
create or replace function public.cfm_home_ping_rows(
  input_start text,
  input_end text,
  input_row_limit integer default 400
)
returns jsonb
language sql
stable
set search_path = public
as $$
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
$$;

-- cfm_insert_monitor_record：load5/load15 与 load 同一兼容语义——
-- 显式 null（容器内 loadavg 透传宿主机）落库为 null；老探针不带该字段仍按 0。
-- 若照抄其它字段的 coalesce(..., 0)，null 会在写入时被悄悄补成 0，
-- 可空列、告警 RPC 的 is not null 过滤、前端解析就全都读不到「不可用」。
create or replace function public.cfm_insert_monitor_record(input_record jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_record is null or jsonb_typeof(input_record) <> 'object' then
    return;
  end if;

  insert into records (
    client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
    disk, disk_total, net_in, net_out, net_total_up, net_total_down,
    process_count, connections, connections_udp, uptime
  ) values (
    input_record->>'client',
    (input_record->>'time')::timestamptz,
    coalesce((input_record->>'cpu')::double precision, 0),
    coalesce((input_record->>'gpu')::double precision, 0),
    coalesce((input_record->>'ram')::double precision, 0),
    coalesce((input_record->>'ram_total')::double precision, 0),
    coalesce((input_record->>'swap')::double precision, 0),
    coalesce((input_record->>'swap_total')::double precision, 0),
    case
      when jsonb_typeof(input_record->'load') = 'null' then null
      else coalesce((input_record->>'load')::double precision, 0)
    end,
    case
      when jsonb_typeof(input_record->'load5') = 'null' then null
      else coalesce((input_record->>'load5')::double precision, 0)
    end,
    case
      when jsonb_typeof(input_record->'load15') = 'null' then null
      else coalesce((input_record->>'load15')::double precision, 0)
    end,
    (input_record->>'temp')::double precision,
    coalesce((input_record->>'disk')::double precision, 0),
    coalesce((input_record->>'disk_total')::double precision, 0),
    coalesce((input_record->>'net_in')::double precision, 0),
    coalesce((input_record->>'net_out')::double precision, 0),
    coalesce((input_record->>'net_total_up')::double precision, 0),
    coalesce((input_record->>'net_total_down')::double precision, 0),
    coalesce((input_record->>'process_count')::integer, 0),
    coalesce((input_record->>'connections')::integer, 0),
    coalesce((input_record->>'connections_udp')::integer, 0),
    coalesce((input_record->>'uptime')::double precision, 0)
  );
end;
$$;

-- 读侧 RPC 里显式列清单的需要补新列；走 select * 的（如 cfm_records_range_limited）
-- 自动带上新列，不用动。
create or replace function public.cfm_records_range_paged(
  input_client text,
  input_start text,
  input_end text,
  input_page integer default 1,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
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
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_records_range_cursor(
  input_client text,
  input_start text,
  input_end text,
  input_cursor text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
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
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  -- jsonb_strip_nulls 只能作用在标量字段上：它是**递归**的，套在整个响应外面会连
  -- data 数组里 load 为 null 的键一起删掉，而前端把「键不存在」当作 0，
  -- 「负载不可用」就被读成「空闲」。先剥标量字段的 null，再合并未经剥离的 data。
  -- （gpu / ping 的同款游标 RPC 没有可空列，那两处保持原样。）
  select jsonb_strip_nulls(jsonb_build_object(
    'total', (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value then (select min(time) from data_rows) else null end
  )) || jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb)
  )
  from params
  );
end;
$$;

create or replace function public.cfm_records_range_bucketed(
  input_client text,
  input_start text,
  input_end text,
  input_bucket_sec integer default 900,
  input_limit integer default 1000
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  safe_bucket integer := least(greatest(coalesce(input_bucket_sec, 900), 60), 3600);
  safe_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 2000);
begin
  return (
    with ranked as (
      select r.*,
        row_number() over (
          partition by floor(extract(epoch from r.time) / safe_bucket)
          order by r.time desc, r.id desc
        ) as rn
      from records r
      where r.client = input_client
        and r.time >= input_start::timestamptz
        and r.time <= input_end::timestamptz
    )
    select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
    from (
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, load5, load15, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from ranked
      where rn = 1
      order by time asc
      limit safe_limit
    ) row_data
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 函数权限：public 级一律收回，只授权给服务端使用的角色。
-- ---------------------------------------------------------------------------
revoke all on function public.cfm_public_settings() from public, anon, authenticated;
grant execute on function public.cfm_public_settings() to service_role;
revoke all on function public.cfm_settings_by_keys(text[]) from public, anon, authenticated;
grant execute on function public.cfm_settings_by_keys(text[]) to service_role;
revoke all on function public.cfm_set_settings(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_set_settings(jsonb) to service_role;
revoke all on function public.cfm_public_clients() from public, anon, authenticated;
grant execute on function public.cfm_public_clients() to service_role;
revoke all on function public.cfm_admin_clients() from public, anon, authenticated;
grant execute on function public.cfm_admin_clients() to service_role;
revoke all on function public.cfm_scheduled_clients() from public, anon, authenticated;
grant execute on function public.cfm_scheduled_clients() to service_role;
revoke all on function public.cfm_scheduled_clients_by_ids(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_scheduled_clients_by_ids(jsonb) to service_role;
revoke all on function public.cfm_client(text) from public, anon, authenticated;
grant execute on function public.cfm_client(text) to service_role;
revoke all on function public.cfm_client_token_meta(text) from public, anon, authenticated;
grant execute on function public.cfm_client_token_meta(text) to service_role;
revoke all on function public.cfm_clients_by_ids(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_clients_by_ids(jsonb) to service_role;
revoke all on function public.cfm_client_ids() from public, anon, authenticated;
grant execute on function public.cfm_client_ids() to service_role;
revoke all on function public.cfm_agent_client_by_token(text, text) from public, anon, authenticated;
grant execute on function public.cfm_agent_client_by_token(text, text) to service_role;
revoke all on function public.cfm_client_token_exists(text, text) from public, anon, authenticated;
grant execute on function public.cfm_client_token_exists(text, text) to service_role;
revoke all on function public.cfm_client_create_conflict(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_client_create_conflict(text, text, text) to service_role;
revoke all on function public.cfm_create_client(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_create_client(jsonb) to service_role;
revoke all on function public.cfm_agent_client_identity_by_token(text, text) from public, anon, authenticated;
grant execute on function public.cfm_agent_client_identity_by_token(text, text) to service_role;
revoke all on function public.cfm_mark_client_token_used(text, text) from public, anon, authenticated;
grant execute on function public.cfm_mark_client_token_used(text, text) to service_role;
revoke all on function public.cfm_rotate_client_token(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_rotate_client_token(text, text, text) to service_role;
revoke all on function public.cfm_update_client_returning(text, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_update_client_returning(text, jsonb) to service_role;
revoke all on function public.cfm_update_client(text, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_update_client(text, jsonb) to service_role;
revoke all on function public.cfm_delete_clients(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_delete_clients(jsonb) to service_role;
revoke all on function public.cfm_prune_client_references(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_prune_client_references(jsonb) to service_role;
revoke all on function public.cfm_cleanup_orphan_client_data() from public, anon, authenticated;
grant execute on function public.cfm_cleanup_orphan_client_data() to service_role;
revoke all on function public.cfm_update_clients_hidden(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.cfm_update_clients_hidden(jsonb, boolean) to service_role;
revoke all on function public.cfm_reorder_clients(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_reorder_clients(jsonb) to service_role;
revoke all on function public.cfm_client_capacity_counts() from public, anon, authenticated;
grant execute on function public.cfm_client_capacity_counts() to service_role;
revoke all on function public.cfm_ping_task_estimate_rows() from public, anon, authenticated;
grant execute on function public.cfm_ping_task_estimate_rows() to service_role;
revoke all on function public.cfm_create_ping_task(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_create_ping_task(jsonb) to service_role;
revoke all on function public.cfm_update_ping_task(integer, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_update_ping_task(integer, jsonb) to service_role;
revoke all on function public.cfm_reorder_ping_tasks(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_reorder_ping_tasks(jsonb) to service_role;
revoke all on function public.cfm_delete_ping_task(integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_ping_task(integer) to service_role;
revoke all on function public.cfm_delete_old_records(text, integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_records(text, integer) to service_role;
revoke all on function public.cfm_delete_old_ping_records(text, integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_ping_records(text, integer) to service_role;
revoke all on function public.cfm_delete_old_audit_logs(text, integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_audit_logs(text, integer) to service_role;
revoke all on function public.cfm_offline_notifications() from public, anon, authenticated;
grant execute on function public.cfm_offline_notifications() to service_role;
revoke all on function public.cfm_expiry_notifications() from public, anon, authenticated;
grant execute on function public.cfm_expiry_notifications() to service_role;
revoke all on function public.cfm_set_expiry_notifications(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_set_expiry_notifications(jsonb) to service_role;
revoke all on function public.cfm_mark_expiry_notification_sent(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_mark_expiry_notification_sent(text, text, text) to service_role;
revoke all on function public.cfm_audit_logs_paged(integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_audit_logs_paged(integer, integer) to service_role;
revoke all on function public.cfm_themes() from public, anon, authenticated;
grant execute on function public.cfm_themes() to service_role;
revoke all on function public.cfm_theme(text) from public, anon, authenticated;
grant execute on function public.cfm_theme(text) to service_role;
revoke all on function public.cfm_upsert_theme(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_upsert_theme(jsonb, jsonb) to service_role;
revoke all on function public.cfm_update_theme_settings(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_update_theme_settings(text, text, text) to service_role;
revoke all on function public.cfm_delete_theme(text) from public, anon, authenticated;
grant execute on function public.cfm_delete_theme(text) to service_role;
revoke all on function public.cfm_theme_asset(text, text) from public, anon, authenticated;
grant execute on function public.cfm_theme_asset(text, text) to service_role;
revoke all on function public.cfm_load_notifications() from public, anon, authenticated;
grant execute on function public.cfm_load_notifications() to service_role;
revoke all on function public.cfm_load_notification(integer) from public, anon, authenticated;
grant execute on function public.cfm_load_notification(integer) to service_role;
revoke all on function public.cfm_create_load_notification(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_create_load_notification(jsonb) to service_role;
revoke all on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) from public, anon, authenticated;
grant execute on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) to service_role;
revoke all on function public.cfm_update_load_notification(integer, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_update_load_notification(integer, jsonb) to service_role;
revoke all on function public.cfm_delete_load_notification(integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_load_notification(integer) to service_role;
revoke all on function public.cfm_insert_gpu_snapshot(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_insert_gpu_snapshot(text, text, jsonb) to service_role;
revoke all on function public.cfm_insert_ping_snapshot(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_insert_ping_snapshot(text, text, jsonb) to service_role;
revoke all on function public.cfm_recent_records(text, integer) from public, anon, authenticated;
grant execute on function public.cfm_recent_records(text, integer) to service_role;
revoke all on function public.cfm_records_range_limited(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_records_range_limited(text, text, text, integer) to service_role;
revoke all on function public.cfm_latest_record_times_for_clients(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_latest_record_times_for_clients(jsonb) to service_role;
revoke all on function public.cfm_gpu_records(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_gpu_records(text, text, text, integer) to service_role;
revoke all on function public.cfm_gpu_records_paged(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_gpu_records_paged(text, text, text, integer, integer) to service_role;
revoke all on function public.cfm_gpu_records_cursor(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_gpu_records_cursor(text, text, text, text, integer) to service_role;
revoke all on function public.cfm_ping_records(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_records(text, integer, integer) to service_role;
revoke all on function public.cfm_ping_records_paged(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_records_paged(text, integer, integer, integer) to service_role;
revoke all on function public.cfm_ping_records_cursor(text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_records_cursor(text, integer, text, integer) to service_role;
revoke all on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) from public, anon, authenticated;
grant execute on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) to service_role;
revoke all on function public.cfm_history_storage_bytes() from public, anon, authenticated;
grant execute on function public.cfm_history_storage_bytes() to service_role;
revoke all on function public.cfm_history_storage_usage() from public, anon, authenticated;
grant execute on function public.cfm_history_storage_usage() to service_role;
revoke all on function public.cfm_bounded_storage_row_counts(integer) from public, anon, authenticated;
grant execute on function public.cfm_bounded_storage_row_counts(integer) to service_role;
revoke all on function public.cfm_expired_row_counts(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_expired_row_counts(text, text, text) to service_role;
revoke all on function public.cfm_public_ping_tasks() from public, anon, authenticated;
grant execute on function public.cfm_public_ping_tasks() to service_role;
revoke all on function public.cfm_users_count() from public, anon, authenticated;
grant execute on function public.cfm_users_count() to service_role;
revoke all on function public.cfm_update_user_password(text, text) from public, anon, authenticated;
grant execute on function public.cfm_update_user_password(text, text) to service_role;
revoke all on function public.cfm_update_user_password_rotate_session(text, text) from public, anon, authenticated;
grant execute on function public.cfm_update_user_password_rotate_session(text, text) to service_role;
revoke all on function public.cfm_validate_admin_session(text, integer) from public, anon, authenticated;
grant execute on function public.cfm_validate_admin_session(text, integer) to service_role;
revoke all on function public.cfm_create_initial_admin(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_create_initial_admin(text, text, text) to service_role;
revoke all on function public.cfm_login_rate_limits(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_login_rate_limits(jsonb) to service_role;
revoke all on function public.cfm_record_login_failures(jsonb, text) from public, anon, authenticated;
grant execute on function public.cfm_record_login_failures(jsonb, text) to service_role;
revoke all on function public.cfm_clear_observed_login_failures(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_clear_observed_login_failures(jsonb) to service_role;
revoke all on function public.cfm_delete_login_rate_limits_before(text) from public, anon, authenticated;
grant execute on function public.cfm_delete_login_rate_limits_before(text) to service_role;
revoke all on function public.cfm_clear_all_records() from public, anon, authenticated;
grant execute on function public.cfm_clear_all_records() to service_role;
revoke all on function public.cfm_clear_client_records(text) from public, anon, authenticated;
grant execute on function public.cfm_clear_client_records(text) to service_role;
revoke all on function public.cfm_restore_backup_data(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_restore_backup_data(jsonb) to service_role;
revoke all on function public.cfm_insert_audit_log(text, text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_insert_audit_log(text, text, text, text) to service_role;
revoke all on function public.cfm_try_claim_audit_throttle(text, timestamp with time zone, bigint) from public, anon, authenticated;
grant execute on function public.cfm_try_claim_audit_throttle(text, timestamp with time zone, bigint) to service_role;
revoke all on function public.cfm_rotate_user_session(text) from public, anon, authenticated;
grant execute on function public.cfm_rotate_user_session(text) to service_role;
revoke all on function public.cfm_update_user_username_rotate_session(text, text) from public, anon, authenticated;
grant execute on function public.cfm_update_user_username_rotate_session(text, text) to service_role;
revoke all on function public.cfm_login_user(text) from public, anon, authenticated;
grant execute on function public.cfm_login_user(text) to service_role;
revoke all on function public.cfm_user_by_uuid(text) from public, anon, authenticated;
grant execute on function public.cfm_user_by_uuid(text) to service_role;
revoke all on function public.cfm_enable_user_totp(text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.cfm_enable_user_totp(text, text, jsonb, bigint) to service_role;
revoke all on function public.cfm_disable_user_totp(text) from public, anon, authenticated;
grant execute on function public.cfm_disable_user_totp(text) to service_role;
revoke all on function public.cfm_replace_user_recovery_codes(text, jsonb) from public, anon, authenticated;
grant execute on function public.cfm_replace_user_recovery_codes(text, jsonb) to service_role;
revoke all on function public.cfm_consume_totp_step(text, bigint) from public, anon, authenticated;
grant execute on function public.cfm_consume_totp_step(text, bigint) to service_role;
revoke all on function public.cfm_consume_recovery_code(text, text) from public, anon, authenticated;
grant execute on function public.cfm_consume_recovery_code(text, text) to service_role;
revoke all on function public.cfm_recover_single_admin(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_recover_single_admin(text, text, text) to service_role;
revoke all on function public.cfm_set_offline_notifications(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_set_offline_notifications(jsonb) to service_role;
revoke all on function public.cfm_mark_offline_notification_sent(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_mark_offline_notification_sent(text, text, text) to service_role;
revoke all on function cfm_internal.notification_delivery_entity_exists(text, boolean) from public, anon, authenticated;
grant execute on function cfm_internal.notification_delivery_entity_exists(text, boolean) to service_role;
revoke all on function cfm_internal.retire_notification_deliveries(text[]) from public, anon, authenticated;
grant execute on function cfm_internal.retire_notification_deliveries(text[]) to service_role;
revoke all on function cfm_internal.retire_client_notification_deliveries(text) from public, anon, authenticated;
grant execute on function cfm_internal.retire_client_notification_deliveries(text) to service_role;
revoke all on function public.cfm_claim_notification_delivery(text, text, timestamp with time zone, bigint) from public, anon, authenticated;
grant execute on function public.cfm_claim_notification_delivery(text, text, timestamp with time zone, bigint) to service_role;
revoke all on function public.cfm_complete_notification_delivery(text, text, text, boolean, timestamp with time zone, bigint) from public, anon, authenticated;
grant execute on function public.cfm_complete_notification_delivery(text, text, text, boolean, timestamp with time zone, bigint) to service_role;
revoke all on function public.cfm_backup_configuration_snapshot() from public, anon, authenticated;
grant execute on function public.cfm_backup_configuration_snapshot() to service_role;
revoke all on function cfm_internal.retire_entity_notification_deliveries() from public, anon, authenticated;
revoke all on function public.cfm_cleanup_notification_delivery_state(timestamp with time zone, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_cleanup_notification_delivery_state(timestamp with time zone, integer, integer) to service_role;
revoke all on function cfm_internal.notification_delivery_token_matches(text, text) from public, anon, authenticated;
grant execute on function cfm_internal.notification_delivery_token_matches(text, text) to service_role;
revoke all on function public.cfm_mark_load_notification_sent(integer, text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_mark_load_notification_sent(integer, text, text, text) to service_role;
revoke all on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) to service_role;
revoke all on function public.cfm_build_history_rollup(text) from public, anon, authenticated;
grant execute on function public.cfm_build_history_rollup(text) to service_role;
grant execute on function public.cfm_build_history_rollup(text) to cf_monitor_app;
revoke all on function public.cfm_gpu_rollup_range(text, text, text) from public, anon, authenticated;
grant execute on function public.cfm_gpu_rollup_range(text, text, text) to service_role;
grant execute on function public.cfm_gpu_rollup_range(text, text, text) to cf_monitor_app;
revoke all on function public.cfm_ping_records_for_tasks_range_bucketed(text, jsonb, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_records_for_tasks_range_bucketed(text, jsonb, text, text, integer, integer) to service_role;
revoke all on function public.cfm_ping_stats_for_tasks_range(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.cfm_ping_stats_for_tasks_range(text, jsonb, text, text) to service_role;
revoke all on function public.cfm_home_ping_assignments() from public, anon, authenticated;
grant execute on function public.cfm_home_ping_assignments() to service_role;
grant execute on function public.cfm_home_ping_assignments() to cf_monitor_app;
revoke all on function public.cfm_set_home_ping_task(text, bigint) from public, anon, authenticated;
grant execute on function public.cfm_set_home_ping_task(text, bigint) to service_role;
grant execute on function public.cfm_set_home_ping_task(text, bigint) to cf_monitor_app;
revoke all on function public.cfm_home_ping_rows(text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_home_ping_rows(text, text, integer) to service_role;
grant execute on function public.cfm_home_ping_rows(text, text, integer) to cf_monitor_app;
revoke all on function public.cfm_insert_monitor_record(jsonb) from public, anon, authenticated;
grant execute on function public.cfm_insert_monitor_record(jsonb) to service_role;
revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_records_range_paged(text, text, text, integer, integer) to service_role;
revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_records_range_cursor(text, text, text, text, integer) to service_role;
revoke all on function public.cfm_records_range_bucketed(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.cfm_records_range_bucketed(text, text, text, integer, integer) to service_role;

drop trigger if exists cfm_client_delivery_retirement on public.clients;

create trigger cfm_client_delivery_retirement after delete or update of expired_at on public.clients
for each row execute function cfm_internal.retire_entity_notification_deliveries();

drop trigger if exists cfm_offline_delivery_retirement on public.offline_notifications;

create trigger cfm_offline_delivery_retirement after delete or update on public.offline_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

drop trigger if exists cfm_expiry_delivery_retirement on public.expiry_notifications;

create trigger cfm_expiry_delivery_retirement after delete or update on public.expiry_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

drop trigger if exists cfm_load_delivery_retirement on public.load_notifications;

create trigger cfm_load_delivery_retirement after delete or update on public.load_notifications
for each row execute function cfm_internal.retire_entity_notification_deliveries();

notify pgrst, 'reload schema';
