-- Switch high-volume Ping time series to daily RANGE partitions. Existing heaps
-- are attached as temporary legacy partitions (no table rewrite or row copy);
-- after their upper bound expires, normal cleanup drops them as a unit.
-- The metadata swap is atomic but takes table locks and validates the legacy
-- time bound; apply /db-init during a low-traffic window on large installations.
set local search_path = public;

do $$
declare
  snapshot_max_day date;
  snapshot_max_id bigint;
  snapshot_upper date;
  rollup_max_day date;
  rollup_upper date;
begin
  if (select relkind = 'p' from pg_class where oid = 'public.ping_snapshots'::regclass) is distinct from true then
    select coalesce(max((time at time zone 'UTC')::date), (now() at time zone 'UTC')::date)
      into snapshot_max_day from public.ping_snapshots;
    snapshot_upper := greatest(snapshot_max_day + 1, (now() at time zone 'UTC')::date + 1);
    select max(id) into snapshot_max_id from public.ping_snapshots;

    create sequence if not exists public.ping_snapshots_partitioned_id_seq as bigint;
    alter table public.ping_snapshots rename to ping_snapshots_legacy_heap;
    alter table public.ping_snapshots_legacy_heap alter column id drop identity if exists;
    alter table public.ping_snapshots_legacy_heap drop constraint if exists ping_snapshots_pkey;
    execute format('alter table public.ping_snapshots_legacy_heap add constraint ping_snapshots_legacy_range_check check (time < %L::timestamptz) not valid',
      snapshot_upper::text || ' 00:00:00+00');
    alter table public.ping_snapshots_legacy_heap validate constraint ping_snapshots_legacy_range_check;

    alter index public.idx_ping_snapshots_client_time rename to idx_ping_snapshots_client_time_legacy;
    alter index public.idx_ping_snapshots_time rename to idx_ping_snapshots_time_legacy;
    alter index public.idx_ping_snapshots_delivery rename to idx_ping_snapshots_delivery_legacy;
    drop index if exists public.idx_ping_snapshots_values_json;

    create table public.ping_snapshots (
      id bigint not null default nextval('public.ping_snapshots_partitioned_id_seq'::regclass),
      client text not null,
      time timestamptz not null,
      values_json jsonb not null default '{}'::jsonb,
      batch_hash text,
      constraint ping_snapshots_pkey primary key (time, id),
      constraint ping_snapshots_client_fkey foreign key (client) references public.clients(uuid) deferrable initially deferred
    ) partition by range (time);
    alter sequence public.ping_snapshots_partitioned_id_seq owned by public.ping_snapshots.id;
    perform setval('public.ping_snapshots_partitioned_id_seq'::regclass, greatest(coalesce(snapshot_max_id,0), 1), snapshot_max_id is not null);
    execute format('alter table public.ping_snapshots attach partition public.ping_snapshots_legacy_heap for values from (minvalue) to (%L)',
      snapshot_upper::text || ' 00:00:00+00');
    alter table public.ping_snapshots_legacy_heap rename to ping_snapshots_legacy;
    alter table public.ping_snapshots enable row level security;
    alter table public.ping_snapshots force row level security;
    revoke all on public.ping_snapshots from public, anon, authenticated;
    grant select, insert, update, delete on public.ping_snapshots to cf_monitor_app, service_role;
    grant usage, select on sequence public.ping_snapshots_partitioned_id_seq to cf_monitor_app, service_role;
    create policy cf_monitor_app_all on public.ping_snapshots for all to cf_monitor_app using (true) with check (true);
    create index idx_ping_snapshots_client_time on only public.ping_snapshots(client,time);
    alter index public.idx_ping_snapshots_client_time attach partition public.idx_ping_snapshots_client_time_legacy;
    create index idx_ping_snapshots_time_brin on public.ping_snapshots using brin(time) with (pages_per_range=64);
    create unique index idx_ping_snapshots_delivery on only public.ping_snapshots(client,time,batch_hash) where batch_hash is not null;
    alter index public.idx_ping_snapshots_delivery attach partition public.idx_ping_snapshots_delivery_legacy;
    execute format('alter table public.ping_snapshots_legacy rename to ping_snapshots_legacy_%s', to_char(snapshot_upper, 'YYYYMMDD'));
  end if;

  if (select relkind = 'p' from pg_class where oid = 'public.ping_rollup'::regclass) is distinct from true then
    select coalesce(max((bucket_start at time zone 'UTC')::date), (now() at time zone 'UTC')::date)
      into rollup_max_day from public.ping_rollup;
    rollup_upper := greatest(rollup_max_day + 1, (now() at time zone 'UTC')::date + 1);
    alter table public.ping_rollup rename to ping_rollup_legacy_heap;
    alter index public.idx_ping_rollup_bucket_start rename to idx_ping_rollup_bucket_start_legacy;
    create table public.ping_rollup (
      client text not null references public.clients(uuid) on delete cascade,
      task_id integer not null references public.ping_tasks(id) on delete cascade,
      bucket_start timestamptz not null,
      sample_count integer not null,
      success_count integer not null,
      loss_count integer not null,
      sum_latency double precision not null,
      sumsq_latency double precision not null,
      min_latency integer,
      max_latency integer,
      p50_latency double precision,
      p75_latency double precision,
      primary key (client, task_id, bucket_start)
    ) partition by range (bucket_start);
    execute format('alter table public.ping_rollup attach partition public.ping_rollup_legacy_heap for values from (minvalue) to (%L)',
      rollup_upper::text || ' 00:00:00+00');
    alter table public.ping_rollup_legacy_heap rename to ping_rollup_legacy;
    alter table public.ping_rollup enable row level security;
    alter table public.ping_rollup force row level security;
    revoke all on public.ping_rollup from public, anon, authenticated;
    grant select, insert, update, delete on public.ping_rollup to cf_monitor_app, service_role;
    create policy cf_monitor_app_all on public.ping_rollup for all to cf_monitor_app using (true) with check (true);
    create index idx_ping_rollup_bucket_start on only public.ping_rollup(bucket_start);
    alter index public.idx_ping_rollup_bucket_start attach partition public.idx_ping_rollup_bucket_start_legacy;
    execute format('alter table public.ping_rollup_legacy rename to ping_rollup_legacy_%s', to_char(rollup_upper, 'YYYYMMDD'));
  end if;
end $$;

-- Keep a rolling runway of daily partitions ahead of UTC today. The bounded
-- DDL runs in a privileged helper so the Worker role never receives CREATE.
create or replace function public.cfm_ensure_ping_time_partitions(input_days_ahead integer default 45)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target_day date := (now() at time zone 'UTC')::date + least(greatest(coalesce(input_days_ahead,45),1),366);
  today_utc date := (now() at time zone 'UTC')::date;
  next_snapshot_day date;
  next_rollup_day date;
  legacy_day date;
  partition_day date;
  made integer := 0;
begin
  perform pg_advisory_xact_lock(86421026);
  select max(to_date(substr(c.relname, length('ping_snapshots_p') + 1, 8), 'YYYYMMDD'))
    into next_snapshot_day
  from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_class p on p.oid=i.inhparent
  where p.oid='public.ping_snapshots'::regclass and c.relname ~ '^ping_snapshots_p[0-9]{8}$';
  select max(to_date(substr(c.relname, length('ping_snapshots_legacy_') + 1, 8), 'YYYYMMDD'))
    into legacy_day
  from pg_inherits i join pg_class c on c.oid=i.inhrelid
  where i.inhparent='public.ping_snapshots'::regclass and c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$';
  partition_day := coalesce(next_snapshot_day + 1, legacy_day, today_utc + 1);
  while partition_day <= target_day loop
    execute format(
      'create table if not exists public.%I partition of public.ping_snapshots for values from (%L) to (%L)',
      'ping_snapshots_p' || to_char(partition_day,'YYYYMMDD'),
      partition_day::text || ' 00:00:00+00', (partition_day + 1)::text || ' 00:00:00+00'
    );
    partition_day := partition_day + 1;
    made := made + 1;
  end loop;

  select max(to_date(substr(c.relname, length('ping_rollup_p') + 1, 8), 'YYYYMMDD'))
    into next_rollup_day
  from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_class p on p.oid=i.inhparent
  where p.oid='public.ping_rollup'::regclass and c.relname ~ '^ping_rollup_p[0-9]{8}$';
  select max(to_date(substr(c.relname, length('ping_rollup_legacy_') + 1, 8), 'YYYYMMDD'))
    into legacy_day
  from pg_inherits i join pg_class c on c.oid=i.inhrelid
  where i.inhparent='public.ping_rollup'::regclass and c.relname ~ '^ping_rollup_legacy_[0-9]{8}$';
  partition_day := coalesce(next_rollup_day + 1, legacy_day, today_utc + 1);
  while partition_day <= target_day loop
    execute format(
      'create table if not exists public.%I partition of public.ping_rollup for values from (%L) to (%L)',
      'ping_rollup_p' || to_char(partition_day,'YYYYMMDD'),
      partition_day::text || ' 00:00:00+00', (partition_day + 1)::text || ' 00:00:00+00'
    );
    partition_day := partition_day + 1;
    made := made + 1;
  end loop;
  return jsonb_build_object('partitions_created',made,'through',target_day);
end $$;

create or replace function public.cfm_prune_ping_time_partitions(input_snapshots_before timestamptz, input_rollups_before timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  child record;
  partition_end timestamptz;
  snapshots_dropped integer := 0;
  rollups_dropped integer := 0;
begin
  perform pg_advisory_xact_lock(86421026);
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
      execute format('drop table public.%I', child.relname);
      if child.kind='snapshot' then snapshots_dropped := snapshots_dropped + 1;
      else rollups_dropped := rollups_dropped + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('ping_snapshot_partitions',snapshots_dropped,'ping_rollup_partitions',rollups_dropped);
end $$;

-- Replace bulk history deletes with partition drops plus a bounded trim of the
-- single edge partition. The two-hour watermark buffer remains authoritative.
create or replace function public.cfm_delete_old_ping_records(input_before_time text, input_max_batches integer default 200)
returns jsonb language plpgsql set search_path = public as $$
declare
  requested_before timestamptz := input_before_time::timestamptz;
  safe_before timestamptz;
  delete_limit integer := least(greatest(coalesce(input_max_batches,200),1),1000)*100;
  ping_records_deleted integer := 0;
  ping_snapshots_deleted integer := 0;
  partition_result jsonb;
begin
  select least(requested_before, coalesce((select watermark from ping_rollup_state where id=1), '-infinity'::timestamptz) - interval '2 hours')
    into safe_before;
  if safe_before = '-infinity'::timestamptz then
    return jsonb_build_object('ping_records',0,'ping_snapshots',0,'ping_snapshot_partitions',0,'has_more',
      exists(select 1 from ping_records where time<requested_before)
      or exists(select 1 from ping_snapshots where time<requested_before));
  end if;

  partition_result := cfm_prune_ping_time_partitions(safe_before,null);
  with doomed as (select id from ping_records where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_records where id in (select id from doomed) returning 1)
    select count(*)::integer into ping_records_deleted from deleted;
  with doomed as (select id,time from ping_snapshots where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_snapshots s using doomed d where s.id=d.id and s.time=d.time returning 1)
    select count(*)::integer into ping_snapshots_deleted from deleted;
  return jsonb_build_object('ping_records',ping_records_deleted,'ping_snapshots',ping_snapshots_deleted,
    'ping_snapshot_partitions',coalesce((partition_result->>'ping_snapshot_partitions')::integer,0),
    'has_more',exists(select 1 from ping_records where time<requested_before)
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
  with doomed as (
    select client,task_id,bucket_start from ping_rollup
    where bucket_start < requested_before order by bucket_start limit delete_limit
  ), deleted as (
    delete from ping_rollup r using doomed d
    where r.client=d.client and r.task_id=d.task_id and r.bucket_start=d.bucket_start returning 1
  ) select count(*)::integer into deleted_rows from deleted;
  return jsonb_build_object('ping_rollup',deleted_rows,
    'ping_rollup_partitions',coalesce((partition_result->>'ping_rollup_partitions')::integer,0),
    'has_more',exists(select 1 from ping_rollup where bucket_start < requested_before));
end $$;

-- A full history wipe should release partition storage immediately instead of
-- creating a large dead-tuple backlog with row-by-row DELETE.
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
  truncate table ping_snapshots, ping_rollup restart identity;
  delete from ping_rollup_state;
  return jsonb_build_object(
    'deleted', jsonb_build_object('records',deleted_records,'gpu_records',deleted_gpu_records,
      'gpu_snapshots',deleted_gpu_snapshots,'ping_records',deleted_ping_records,
      'ping_snapshots',deleted_ping_snapshots,'ping_rollup',deleted_ping_rollup),
    'remaining', jsonb_build_object('records',0,'gpu_records',0,'gpu_snapshots',0,
      'ping_records',0,'ping_snapshots',0,'ping_rollup',0),
    'has_more',false
  );
end $$;

create or replace function public.cfm_build_ping_rollup(input_before text default null, input_max_buckets integer default 48)
returns jsonb language plpgsql set search_path = public as $$
declare
  before_ts timestamptz := coalesce(nullif(input_before, '')::timestamptz, now() - interval '2 minutes');
  from_ts timestamptz;
  work_from timestamptz;
  work_to timestamptz;
  to_ts timestamptz;
  max_buckets integer := least(greatest(coalesce(input_max_buckets, 48), 1), 96);
  buckets integer := 0;
begin
  perform cfm_ensure_ping_time_partitions(45);
  select watermark into from_ts from ping_rollup_state where id = 1 for update;
  if from_ts is null then
    select date_bin(interval '30 minutes', min(time), timestamptz '1970-01-01')
      into from_ts from ping_snapshots;
    if from_ts is null then
      return jsonb_build_object('watermark', null, 'buckets', 0, 'has_more', false);
    end if;
    insert into ping_rollup_state(id, watermark) values (1, from_ts) on conflict (id) do nothing;
    select watermark into from_ts from ping_rollup_state where id = 1;
  end if;
  to_ts := least(date_bin(interval '30 minutes', before_ts, timestamptz '1970-01-01'), from_ts + max_buckets * interval '30 minutes');
  work_to := greatest(from_ts, to_ts);
  if to_ts > from_ts then work_from := from_ts - interval '2 hours'; else work_from := from_ts; end if;
  if work_to > work_from then
    with expanded as (
      select s.client,s.time,t.id task_id,item.value raw_value
      from ping_snapshots s
      cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
      join ping_tasks t on t.id=case when item.key ~ '^[0-9]{1,9}$' then item.key::integer end
      join clients c on c.uuid=s.client
      where s.time>=work_from and s.time<work_to
    ), typed as (
      select client,time,task_id,
        case when raw_value ~ '^-?[0-9]{1,10}$'
          then case when raw_value::numeric between -2147483648 and 2147483647 then raw_value::integer end end value
      from expanded
    )
    insert into ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,
      sum_latency,sumsq_latency,min_latency,max_latency,p50_latency,p75_latency)
    select client,task_id,date_bin(interval '30 minutes',time,timestamptz '1970-01-01'),count(*)::integer,
      count(*) filter(where value>=0)::integer,count(*) filter(where value<0)::integer,
      coalesce(sum(value) filter(where value>=0),0),
      coalesce(sum(value::double precision*value::double precision) filter(where value>=0),0),
      min(value) filter(where value>=0),max(value) filter(where value>=0),
      percentile_cont(0.5) within group(order by value) filter(where value>=0),
      percentile_cont(0.75) within group(order by value) filter(where value>=0)
    from typed where value is not null
    group by client,task_id,date_bin(interval '30 minutes',time,timestamptz '1970-01-01')
    on conflict(client,task_id,bucket_start) do update set
      sample_count=excluded.sample_count,success_count=excluded.success_count,loss_count=excluded.loss_count,
      sum_latency=excluded.sum_latency,sumsq_latency=excluded.sumsq_latency,min_latency=excluded.min_latency,
      max_latency=excluded.max_latency,p50_latency=excluded.p50_latency,p75_latency=excluded.p75_latency;
    buckets := floor(extract(epoch from (work_to-from_ts))/1800)::integer;
    if work_to>from_ts then update ping_rollup_state set watermark=work_to where id=1; end if;
  end if;
  return jsonb_build_object('watermark',work_to,'buckets',buckets,
    'lag_seconds',greatest(0,floor(extract(epoch from (now()-work_to))))::integer,
    'has_more',work_to<date_bin(interval '30 minutes',before_ts,timestamptz '1970-01-01'));
end $$;

-- A partitioned table has no heap at the parent relid; sum child relations so
-- storage/capacity metrics continue to report physical usage accurately.
create or replace function public.cfm_partition_tree_total_bytes(input_table regclass)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  with recursive tree(relid) as (
    select input_table::oid
    union all
    select i.inhrelid from pg_inherits i join tree t on t.relid=i.inhparent
  ) select coalesce(sum(pg_total_relation_size(relid)),0)::bigint from tree;
$$;

create or replace function public.cfm_history_storage_bytes()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'records',pg_total_relation_size('public.records'),
    'gpu_records',pg_total_relation_size('public.gpu_records'),
    'gpu_snapshots',pg_total_relation_size('public.gpu_snapshots'),
    'ping_records',pg_total_relation_size('public.ping_records'),
    'ping_snapshots',cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass),
    'ping_rollup',cfm_partition_tree_total_bytes('public.ping_rollup'::regclass),
    'total',pg_total_relation_size('public.records')+pg_total_relation_size('public.gpu_records')
      +pg_total_relation_size('public.gpu_snapshots')+pg_total_relation_size('public.ping_records')
      +cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass)+cfm_partition_tree_total_bytes('public.ping_rollup'::regclass)
  );
$$;

create or replace function public.cfm_history_storage_usage()
returns jsonb language sql stable set search_path = public as $$
  with table_usage as (
    select 'records' table_name,count(*)::bigint live_rows,coalesce(sum(pg_column_size(r)),0)::bigint live_row_bytes,pg_total_relation_size('public.records') allocated_bytes from records r
    union all select 'gpu_records',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.gpu_records') from gpu_records r
    union all select 'gpu_snapshots',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.gpu_snapshots') from gpu_snapshots r
    union all select 'ping_records',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.ping_records') from ping_records r
    union all select 'ping_snapshots',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass) from ping_snapshots r
    union all select 'ping_rollup',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,cfm_partition_tree_total_bytes('public.ping_rollup'::regclass) from ping_rollup r
  )
  select jsonb_build_object(
    'live_rows',sum(live_rows),'live_row_bytes',sum(live_row_bytes),
    'estimated_live_storage_bytes',sum(live_row_bytes+live_rows*192),'allocated_bytes',sum(allocated_bytes),
    'reusable_bytes',null,'measurement','live-row-bytes-plus-index-estimate','index_page_allowance_bytes_per_row',192,
    'tables',jsonb_object_agg(table_name,jsonb_build_object('live_rows',live_rows,'live_row_bytes',live_row_bytes,
      'estimated_live_storage_bytes',live_row_bytes+live_rows*192,'allocated_bytes',allocated_bytes))
  ) from table_usage;
$$;

revoke all on function public.cfm_ensure_ping_time_partitions(integer) from public, anon, authenticated;
grant execute on function public.cfm_ensure_ping_time_partitions(integer) to cf_monitor_app, service_role;
revoke all on function public.cfm_prune_ping_time_partitions(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.cfm_prune_ping_time_partitions(timestamptz,timestamptz) to cf_monitor_app, service_role;
revoke all on function public.cfm_partition_tree_total_bytes(regclass) from public, anon, authenticated;
grant execute on function public.cfm_partition_tree_total_bytes(regclass) to cf_monitor_app, service_role;
revoke all on function public.cfm_build_ping_rollup(text,integer) from public, anon, authenticated;
grant execute on function public.cfm_build_ping_rollup(text,integer) to cf_monitor_app, service_role;
revoke all on function public.cfm_delete_old_ping_records(text,integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_ping_records(text,integer) to cf_monitor_app, service_role;
revoke all on function public.cfm_delete_old_ping_rollup(text,integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_ping_rollup(text,integer) to cf_monitor_app, service_role;

select public.cfm_ensure_ping_time_partitions(45);
notify pgrst, 'reload schema';
