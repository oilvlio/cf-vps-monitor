-- Reject old Ping observations before partition routing can raise
-- "no partition found". The legacy MINVALUE partition intentionally accepts
-- old timestamps until it expires; afterwards only dated partitions remain.
create or replace function public.cfm_insert_ping_snapshot(input_client text, input_time text, input_results jsonb)
returns void language plpgsql set search_path = public as $$
declare
  values_json jsonb;
  observed_at timestamptz;
  oldest_partition_start timestamptz;
  has_legacy_partition boolean;
begin
  if input_results is null or jsonb_typeof(input_results) <> 'array' then
    return;
  end if;

  observed_at := input_time::timestamptz;
  select exists (
    select 1 from pg_inherits i join pg_class c on c.oid=i.inhrelid
    where i.inhparent='public.ping_snapshots'::regclass
      and c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$'
  ), min(to_date(right(c.relname,8),'YYYYMMDD'))::timestamp at time zone 'UTC'
    into has_legacy_partition, oldest_partition_start
  from pg_inherits i join pg_class c on c.oid=i.inhrelid
  where i.inhparent='public.ping_snapshots'::regclass
    and c.relname ~ '^ping_snapshots_p[0-9]{8}$';

  if not has_legacy_partition and (oldest_partition_start is null or observed_at < oldest_partition_start) then
    return;
  end if;

  select coalesce(jsonb_object_agg(item->>'taskId', round((item->>'value')::double precision)::integer), '{}'::jsonb)
    into values_json
  from jsonb_array_elements(input_results) item
  where (item->>'taskId') ~ '^[0-9]+$' and (item->>'value') is not null;
  if values_json = '{}'::jsonb then return; end if;

  insert into ping_snapshots(client,time,values_json,batch_hash)
  values(input_client,observed_at,values_json,encode(sha256(convert_to(values_json::text,'UTF8')),'hex'))
  on conflict(client,time,batch_hash) where batch_hash is not null do nothing;
end $$;

revoke all on function public.cfm_insert_ping_snapshot(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.cfm_insert_ping_snapshot(text,text,jsonb) to service_role;

-- DROP TABLE on a partition needs an ACCESS EXCLUSIVE lock on its parent.
-- Never let a maintenance call wait behind a long history query and block the
-- later readers/writers in the lock queue; a timed-out partition is retried on
-- the next cleanup run.
create or replace function public.cfm_prune_ping_time_partitions(input_snapshots_before timestamptz, input_rollups_before timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  child record;
  snapshots_dropped integer := 0;
  rollups_dropped integer := 0;
  lock_timeouts integer := 0;
begin
  perform set_config('lock_timeout','2s',true);
  if not pg_try_advisory_xact_lock(86421026) then
    return jsonb_build_object('ping_snapshot_partitions',0,'ping_rollup_partitions',0,'partitions_pending',true,'has_more',true);
  end if;

  for child in
    select c.relname, 'snapshot' kind,
      case when c.relname like 'ping_snapshots_legacy_%'
        then to_date(right(c.relname,8),'YYYYMMDD')::timestamp at time zone 'UTC'
        else (to_date(right(c.relname,8),'YYYYMMDD') + 1)::timestamp at time zone 'UTC'
      end range_end
    from pg_inherits i join pg_class c on c.oid=i.inhrelid
    where i.inhparent='public.ping_snapshots'::regclass
      and (c.relname ~ '^ping_snapshots_p[0-9]{8}$' or c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$')
    union all
    select c.relname, 'rollup' kind,
      case when c.relname like 'ping_rollup_legacy_%'
        then to_date(right(c.relname,8),'YYYYMMDD')::timestamp at time zone 'UTC'
        else (to_date(right(c.relname,8),'YYYYMMDD') + 1)::timestamp at time zone 'UTC'
      end range_end
    from pg_inherits i join pg_class c on c.oid=i.inhrelid
    where i.inhparent='public.ping_rollup'::regclass
      and (c.relname ~ '^ping_rollup_p[0-9]{8}$' or c.relname ~ '^ping_rollup_legacy_[0-9]{8}$')
  loop
    if (child.kind='snapshot' and input_snapshots_before is not null and child.range_end <= input_snapshots_before)
      or (child.kind='rollup' and input_rollups_before is not null and child.range_end <= input_rollups_before) then
      begin
        execute format('drop table public.%I', child.relname);
        if child.kind='snapshot' then snapshots_dropped := snapshots_dropped + 1;
        else rollups_dropped := rollups_dropped + 1;
        end if;
      exception when lock_not_available then
        lock_timeouts := lock_timeouts + 1;
        exit;
      end;
    end if;
  end loop;
  return jsonb_build_object('ping_snapshot_partitions',snapshots_dropped,'ping_rollup_partitions',rollups_dropped,
    'partitions_pending',lock_timeouts>0,'has_more',lock_timeouts>0);
end $$;

create or replace function public.cfm_delete_old_ping_records(input_before_time text, input_max_batches integer default 200)
returns jsonb language plpgsql set search_path = public as $$
declare
  requested_before timestamptz := input_before_time::timestamptz;
  safe_before timestamptz;
  delete_limit integer := least(greatest(coalesce(input_max_batches,200),1),1000)*100;
  deleted_records integer := 0;
  deleted_snapshots integer := 0;
  partition_result jsonb;
begin
  select least(requested_before,coalesce((select watermark from ping_rollup_state where id=1),'-infinity'::timestamptz)-interval '2 hours')
    into safe_before;
  if safe_before='-infinity'::timestamptz then
    return jsonb_build_object('ping_records',0,'ping_snapshots',0,'ping_snapshot_partitions',0,
      'has_more',exists(select 1 from ping_records where time<requested_before)
        or exists(select 1 from ping_snapshots where time<requested_before));
  end if;
  partition_result := cfm_prune_ping_time_partitions(safe_before,null);
  with doomed as (select id from ping_records where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_records where id in(select id from doomed) returning 1)
    select count(*)::integer into deleted_records from deleted;
  with doomed as (select id,time from ping_snapshots where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_snapshots s using doomed d where s.id=d.id and s.time=d.time returning 1)
    select count(*)::integer into deleted_snapshots from deleted;
  return jsonb_build_object('ping_records',deleted_records,'ping_snapshots',deleted_snapshots,
    'ping_snapshot_partitions',coalesce((partition_result->>'ping_snapshot_partitions')::integer,0),
    'has_more',coalesce((partition_result->>'has_more')::boolean,false)
      or exists(select 1 from ping_records where time<requested_before)
      or exists(select 1 from ping_snapshots where time<requested_before));
end $$;

create or replace function public.cfm_delete_old_ping_rollup(input_before text, input_max_batches integer default 200)
returns jsonb language plpgsql set search_path = public as $$
declare
  requested_before timestamptz := input_before::timestamptz;
  delete_limit integer := least(greatest(coalesce(input_max_batches,200),1),1000)*100;
  deleted_rows integer := 0;
  partition_result jsonb;
begin
  partition_result := cfm_prune_ping_time_partitions(null,requested_before);
  with doomed as (select client,task_id,bucket_start from ping_rollup where bucket_start<requested_before order by bucket_start limit delete_limit),
  deleted as (delete from ping_rollup r using doomed d where r.client=d.client and r.task_id=d.task_id and r.bucket_start=d.bucket_start returning 1)
    select count(*)::integer into deleted_rows from deleted;
  return jsonb_build_object('ping_rollup',deleted_rows,
    'ping_rollup_partitions',coalesce((partition_result->>'ping_rollup_partitions')::integer,0),
    'has_more',coalesce((partition_result->>'has_more')::boolean,false)
      or exists(select 1 from ping_rollup where bucket_start<requested_before));
end $$;

-- cfm_clear_all_records runs as the explicitly authorized service_role (not as
-- the function owner), so its partitioned TRUNCATE must be granted directly.
grant truncate on table public.ping_snapshots, public.ping_rollup to service_role;
grant update on sequence public.ping_snapshots_partitioned_id_seq to service_role;

-- RESET IDENTITY would require sequence ownership, not just a TRUNCATE grant.
-- Reset explicitly using UPDATE privilege while keeping this RPC invoker-rights.
create or replace function public.cfm_clear_all_records()
returns jsonb language plpgsql set search_path = public as $$
declare
  deleted_records integer; deleted_gpu_records integer; deleted_gpu_snapshots integer;
  deleted_ping_records integer; deleted_ping_snapshots integer; deleted_ping_rollup integer;
begin
  with d as (delete from records returning 1) select count(*)::integer into deleted_records from d;
  with d as (delete from gpu_records returning 1) select count(*)::integer into deleted_gpu_records from d;
  with d as (delete from gpu_snapshots returning 1) select count(*)::integer into deleted_gpu_snapshots from d;
  with d as (delete from ping_records returning 1) select count(*)::integer into deleted_ping_records from d;
  select count(*)::integer into deleted_ping_snapshots from ping_snapshots;
  select count(*)::integer into deleted_ping_rollup from ping_rollup;
  truncate table ping_snapshots, ping_rollup;
  perform setval('public.ping_snapshots_partitioned_id_seq'::regclass,1,false);
  delete from ping_rollup_state;
  return jsonb_build_object(
    'deleted',jsonb_build_object('records',deleted_records,'gpu_records',deleted_gpu_records,
      'gpu_snapshots',deleted_gpu_snapshots,'ping_records',deleted_ping_records,
      'ping_snapshots',deleted_ping_snapshots,'ping_rollup',deleted_ping_rollup),
    'remaining',jsonb_build_object('records',0,'gpu_records',0,'gpu_snapshots',0,
      'ping_records',0,'ping_snapshots',0,'ping_rollup',0),
    'has_more',false
  );
end $$;
revoke all on function public.cfm_clear_all_records() from public, anon, authenticated;
grant execute on function public.cfm_clear_all_records() to service_role;
notify pgrst, 'reload schema';
