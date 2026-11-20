-- 30-minute Ping rollups. Raw snapshots remain authoritative; rollups accelerate
-- long-range chart reads and can be rebuilt idempotently from retained samples.
set local search_path = public;

create table if not exists public.ping_rollup (
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
);

create index if not exists idx_ping_rollup_client_bucket
  on public.ping_rollup(client, bucket_start);

alter table public.ping_rollup enable row level security;
alter table public.ping_rollup force row level security;
revoke all on public.ping_rollup from public, anon, authenticated;
grant select, insert, update, delete on public.ping_rollup to cf_monitor_app, service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ping_rollup' and policyname='cf_monitor_app_all') then
    create policy cf_monitor_app_all on public.ping_rollup for all to cf_monitor_app using (true) with check (true);
  end if;
end $$;

create table if not exists public.ping_rollup_state (
  id smallint primary key check (id = 1),
  watermark timestamptz not null
);
alter table public.ping_rollup_state enable row level security;
alter table public.ping_rollup_state force row level security;
revoke all on public.ping_rollup_state from public, anon, authenticated;
grant select, insert, update, delete on public.ping_rollup_state to cf_monitor_app, service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ping_rollup_state' and policyname='cf_monitor_app_all') then
    create policy cf_monitor_app_all on public.ping_rollup_state for all to cf_monitor_app using (true) with check (true);
  end if;
end $$;

-- Advance at most 48 closed half-hour buckets per call. A watermark makes
-- catch-up resumable after downtime; the last two minutes stay raw for late data.
create or replace function public.cfm_build_ping_rollup(input_before text default null, input_max_buckets integer default 48)
returns jsonb language plpgsql set search_path = public as $$
declare
  before_ts timestamptz := coalesce(nullif(input_before, '')::timestamptz, now() - interval '2 minutes');
  from_ts timestamptz;
  work_from timestamptz;
  to_ts timestamptz;
  max_buckets integer := least(greatest(coalesce(input_max_buckets, 48), 1), 96);
  buckets integer := 0;
begin
  select watermark into from_ts from ping_rollup_state where id = 1 for update;
  if from_ts is null then
    select date_bin(interval '30 minutes', min(time), timestamptz '1970-01-01')
      into from_ts from ping_snapshots;
    if from_ts is null then
      return jsonb_build_object('watermark', null, 'buckets', 0, 'has_more', false);
    end if;
    insert into ping_rollup_state(id, watermark) values (1, from_ts)
      on conflict (id) do nothing;
    select watermark into from_ts from ping_rollup_state where id = 1;
  end if;

  to_ts := least(date_bin(interval '30 minutes', before_ts, timestamptz '1970-01-01'),
    from_ts + max_buckets * interval '30 minutes');
  if to_ts > from_ts then
    -- Revisit the last three buckets on every pass so delayed Agent retries
    -- replace their previous aggregate instead of being lost behind the cursor.
    work_from := greatest(from_ts - interval '90 minutes',
      coalesce((select date_bin(interval '30 minutes', min(time), timestamptz '1970-01-01') from ping_snapshots), from_ts));
    insert into ping_rollup(client, task_id, bucket_start, sample_count, success_count, loss_count,
      sum_latency, sumsq_latency, min_latency, max_latency, p50_latency, p75_latency)
    select s.client, item.key::integer,
      date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01'),
      count(*)::integer,
      count(*) filter (where item.value::integer >= 0)::integer,
      count(*) filter (where item.value::integer < 0)::integer,
      coalesce(sum(item.value::integer) filter (where item.value::integer >= 0), 0),
      coalesce(sum((item.value::integer)::double precision * (item.value::integer)::double precision)
        filter (where item.value::integer >= 0), 0),
      min(item.value::integer) filter (where item.value::integer >= 0),
      max(item.value::integer) filter (where item.value::integer >= 0),
      percentile_cont(0.5) within group (order by item.value::integer) filter (where item.value::integer >= 0),
      percentile_cont(0.75) within group (order by item.value::integer) filter (where item.value::integer >= 0)
    from ping_snapshots s
    cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
    where s.time >= work_from and s.time < to_ts
      and item.key ~ '^[0-9]{1,9}$'
    group by s.client, item.key::integer, date_bin(interval '30 minutes', s.time, timestamptz '1970-01-01')
    on conflict (client, task_id, bucket_start) do update set
      sample_count=excluded.sample_count, success_count=excluded.success_count, loss_count=excluded.loss_count,
      sum_latency=excluded.sum_latency, sumsq_latency=excluded.sumsq_latency,
      min_latency=excluded.min_latency, max_latency=excluded.max_latency,
      p50_latency=excluded.p50_latency, p75_latency=excluded.p75_latency;

    buckets := floor(extract(epoch from (to_ts - work_from)) / 1800)::integer;
    update ping_rollup_state set watermark = to_ts where id = 1;
  end if;
  return jsonb_build_object('watermark', to_ts, 'buckets', buckets,
    'has_more', to_ts < date_bin(interval '30 minutes', before_ts, timestamptz '1970-01-01'));
end $$;

-- Never delete source snapshots beyond the completed rollup watermark. If the
-- builder is behind, report pending work so the existing cleanup loop retries.
create or replace function public.cfm_delete_old_ping_records(input_before_time text, input_max_batches integer default 200)
returns jsonb language plpgsql set search_path = public as $$
declare
  requested_before timestamptz := input_before_time::timestamptz;
  safe_before timestamptz;
  delete_limit integer := least(greatest(coalesce(input_max_batches,200),1),1000)*100;
  ping_records_deleted integer;
  ping_snapshots_deleted integer;
begin
  select least(requested_before, coalesce((select watermark from ping_rollup_state where id=1), '-infinity'::timestamptz))
    into safe_before;
  if safe_before = '-infinity'::timestamptz then
    return jsonb_build_object('ping_records',0,'ping_snapshots',0,'has_more',
      exists(select 1 from ping_records where time<requested_before)
      or exists(select 1 from ping_snapshots where time<requested_before));
  end if;
  with doomed as (select id from ping_records where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_records where id in (select id from doomed) returning 1)
    select count(*)::integer into ping_records_deleted from deleted;
  with doomed as (select id from ping_snapshots where time<safe_before order by time,id limit delete_limit),
  deleted as (delete from ping_snapshots where id in (select id from doomed) returning 1)
    select count(*)::integer into ping_snapshots_deleted from deleted;
  return jsonb_build_object('ping_records',ping_records_deleted,'ping_snapshots',ping_snapshots_deleted,
    'has_more',exists(select 1 from ping_records where time<requested_before)
      or exists(select 1 from ping_snapshots where time<requested_before));
end $$;

-- Read rollups and raw tail into the same row shape. Rollup quantiles are
-- weighted approximations; counts, loss, average, min and max remain mergeable.
create or replace function public.cfm_ping_rollup_range(
  input_client text, input_task_ids jsonb, input_start text, input_end text,
  input_step_sec integer default 1800, input_limit integer default 1500
) returns jsonb language sql stable set search_path = public as $$
  with args as (
    select input_client client, input_start::timestamptz start_at, input_end::timestamptz end_at,
      greatest(coalesce(input_step_sec,1800),1800) step_sec,
      least(greatest(coalesce(input_limit,1500),1),2000) lim,
      coalesce((select watermark from ping_rollup_state where id=1), '-infinity'::timestamptz) watermark
  ), ids as (
    select distinct value::integer task_id
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids)='array' then input_task_ids else '[]'::jsonb end) x(value)
    where value ~ '^[0-9]{1,9}$' and value::integer > 0
  ), base as (
    select r.task_id, r.bucket_start time, r.sample_count, r.success_count, r.loss_count,
      r.sum_latency, r.sumsq_latency, r.min_latency, r.max_latency, r.p50_latency, r.p75_latency
    from ping_rollup r cross join args a
    join ids i on i.task_id=r.task_id
    where r.client=a.client and r.bucket_start >= a.start_at
      and r.bucket_start + interval '30 minutes' <= a.end_at
      and r.bucket_start + interval '30 minutes' <= a.watermark
    union all
    select i.task_id, s.time, 1,
      case when v.value::integer >= 0 then 1 else 0 end,
      case when v.value::integer < 0 then 1 else 0 end,
      case when v.value::integer >= 0 then v.value::integer else 0 end,
      case when v.value::integer >= 0 then v.value::integer::double precision * v.value::integer::double precision else 0 end,
      case when v.value::integer >= 0 then v.value::integer end,
      case when v.value::integer >= 0 then v.value::integer end,
      case when v.value::integer >= 0 then v.value::integer::double precision end,
      case when v.value::integer >= 0 then v.value::integer::double precision end
    from ping_snapshots s cross join args a
    join ids i on true
    cross join lateral (select s.values_json ->> i.task_id::text value) v
    where s.client=a.client and v.value is not null
      and s.time >= greatest(a.start_at, a.watermark) and s.time <= a.end_at
  ), grouped as (
    select task_id,
      date_bin(make_interval(secs => a.step_sec), time, timestamptz '1970-01-01') bucket_start,
      sum(sample_count)::integer sample_count, sum(success_count)::integer success_count,
      sum(loss_count)::integer loss_count, sum(sum_latency) sum_latency, sum(sumsq_latency) sumsq_latency,
      min(min_latency) min_latency, max(max_latency) max_latency,
      case when sum(success_count)>0 then sum(p50_latency * success_count) filter (where p50_latency is not null) / nullif(sum(success_count) filter (where p50_latency is not null),0) end p50_latency,
      case when sum(success_count)>0 then sum(p75_latency * success_count) filter (where p75_latency is not null) / nullif(sum(success_count) filter (where p75_latency is not null),0) end p75_latency
    from base cross join args a group by task_id, date_bin(make_interval(secs => a.step_sec), time, timestamptz '1970-01-01')
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
$$;

create or replace function public.cfm_delete_old_ping_rollup(input_before text, input_max_batches integer default 200)
returns jsonb language plpgsql set search_path = public as $$
declare deleted_rows integer;
begin
  with doomed as (select ctid from ping_rollup where bucket_start < input_before::timestamptz order by bucket_start limit least(greatest(coalesce(input_max_batches,200),1),1000)*100),
  deleted as (delete from ping_rollup where ctid in (select ctid from doomed) returning 1)
  select count(*)::integer into deleted_rows from deleted;
  return jsonb_build_object('ping_rollup',deleted_rows,'has_more',exists(select 1 from ping_rollup where bucket_start < input_before::timestamptz));
end $$;

-- Explicit record wipes must not leave stale rollup rows visible.
create or replace function public.cfm_clear_client_records(input_client text)
returns void language sql set search_path = public as $$
  delete from records where client=input_client;
  delete from gpu_records where client=input_client;
  delete from gpu_snapshots where client=input_client;
  delete from ping_records where client=input_client;
  delete from ping_snapshots where client=input_client;
  delete from ping_rollup where client=input_client;
$$;

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
  with d as (delete from ping_snapshots returning 1) select count(*)::integer into deleted_ping_snapshots from d;
  with d as (delete from ping_rollup returning 1) select count(*)::integer into deleted_ping_rollup from d;
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

-- Include rollups in the existing database-capacity fuse and maintenance preview.
create or replace function public.cfm_history_storage_bytes()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'records',pg_total_relation_size('public.records'),
    'gpu_records',pg_total_relation_size('public.gpu_records'),
    'gpu_snapshots',pg_total_relation_size('public.gpu_snapshots'),
    'ping_records',pg_total_relation_size('public.ping_records'),
    'ping_snapshots',pg_total_relation_size('public.ping_snapshots'),
    'ping_rollup',pg_total_relation_size('public.ping_rollup'),
    'total',pg_total_relation_size('public.records')+pg_total_relation_size('public.gpu_records')
      +pg_total_relation_size('public.gpu_snapshots')+pg_total_relation_size('public.ping_records')
      +pg_total_relation_size('public.ping_snapshots')+pg_total_relation_size('public.ping_rollup')
  );
$$;

create or replace function public.cfm_history_storage_usage()
returns jsonb language sql stable set search_path = public as $$
  with table_usage as (
    select 'records' table_name,count(*)::bigint live_rows,coalesce(sum(pg_column_size(r)),0)::bigint live_row_bytes,pg_total_relation_size('public.records') allocated_bytes from records r
    union all select 'gpu_records',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.gpu_records') from gpu_records r
    union all select 'gpu_snapshots',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.gpu_snapshots') from gpu_snapshots r
    union all select 'ping_records',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.ping_records') from ping_records r
    union all select 'ping_snapshots',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.ping_snapshots') from ping_snapshots r
    union all select 'ping_rollup',count(*)::bigint,coalesce(sum(pg_column_size(r)),0)::bigint,pg_total_relation_size('public.ping_rollup') from ping_rollup r
  )
  select jsonb_build_object(
    'live_rows',sum(live_rows),'live_row_bytes',sum(live_row_bytes),
    'estimated_live_storage_bytes',sum(live_row_bytes+live_rows*192),'allocated_bytes',sum(allocated_bytes),
    'reusable_bytes',null,'measurement','live-row-bytes-plus-index-estimate','index_page_allowance_bytes_per_row',192,
    'tables',jsonb_object_agg(table_name,jsonb_build_object('live_rows',live_rows,'live_row_bytes',live_row_bytes,
      'estimated_live_storage_bytes',live_row_bytes+live_rows*192,'allocated_bytes',allocated_bytes))
  ) from table_usage;
$$;

create or replace function public.cfm_bounded_storage_row_counts(input_limit integer default 100000)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  return (with args as (select greatest(coalesce(input_limit,100000),1)::integer safe_limit),
  raw_counts as (
    select (select count(*) from (select 1 from records limit (select safe_limit+1 from args)) s)::integer records,
      (select count(*) from (select 1 from gpu_records limit (select safe_limit+1 from args)) s)::integer gpu_records,
      (select count(*) from (select 1 from gpu_snapshots limit (select safe_limit+1 from args)) s)::integer gpu_snapshots,
      (select count(*) from (select 1 from ping_records limit (select safe_limit+1 from args)) s)::integer ping_records,
      (select count(*) from (select 1 from ping_snapshots limit (select safe_limit+1 from args)) s)::integer ping_snapshots,
      (select count(*) from (select 1 from ping_rollup limit (select safe_limit+1 from args)) s)::integer ping_rollup,
      (select count(*) from (select 1 from audit_logs limit (select safe_limit+1 from args)) s)::integer audit_logs
  ) select jsonb_build_object('counts',jsonb_build_object(
    'records',least(raw_counts.records,args.safe_limit),'gpu_records',least(raw_counts.gpu_records,args.safe_limit),
    'gpu_snapshots',least(raw_counts.gpu_snapshots,args.safe_limit),'ping_records',least(raw_counts.ping_records,args.safe_limit),
    'ping_snapshots',least(raw_counts.ping_snapshots,args.safe_limit),'ping_rollup',least(raw_counts.ping_rollup,args.safe_limit),
    'audit_logs',least(raw_counts.audit_logs,args.safe_limit)),
    'capped',jsonb_strip_nulls(jsonb_build_object(
      'records',case when raw_counts.records>args.safe_limit then true end,
      'gpu_records',case when raw_counts.gpu_records>args.safe_limit then true end,
      'gpu_snapshots',case when raw_counts.gpu_snapshots>args.safe_limit then true end,
      'ping_records',case when raw_counts.ping_records>args.safe_limit then true end,
      'ping_snapshots',case when raw_counts.ping_snapshots>args.safe_limit then true end,
      'ping_rollup',case when raw_counts.ping_rollup>args.safe_limit then true end,
      'audit_logs',case when raw_counts.audit_logs>args.safe_limit then true end)), 'limit',args.safe_limit)
    from args,raw_counts);
end $$;

create or replace function public.cfm_expired_row_counts(input_records_before text,input_ping_records_before text,input_audit_logs_before text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('records',(select count(*) from records where time<input_records_before::timestamptz),
    'gpu_records',(select count(*) from gpu_records where time<input_records_before::timestamptz),
    'gpu_snapshots',(select count(*) from gpu_snapshots where time<input_records_before::timestamptz),
    'ping_records',(select count(*) from ping_records where time<input_ping_records_before::timestamptz),
    'ping_snapshots',(select count(*) from ping_snapshots where time<input_ping_records_before::timestamptz),
    'ping_rollup',(select count(*) from ping_rollup where bucket_start<input_ping_records_before::timestamptz),
    'audit_logs',(select count(*) from audit_logs where time<input_audit_logs_before::timestamptz));
$$;

revoke all on function public.cfm_build_ping_rollup(text,integer) from public, anon, authenticated;
grant execute on function public.cfm_build_ping_rollup(text,integer) to cf_monitor_app, service_role;
revoke all on function public.cfm_ping_rollup_range(text,jsonb,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.cfm_ping_rollup_range(text,jsonb,text,text,integer,integer) to cf_monitor_app, service_role;
revoke all on function public.cfm_delete_old_ping_rollup(text,integer) from public, anon, authenticated;
grant execute on function public.cfm_delete_old_ping_rollup(text,integer) to cf_monitor_app, service_role;

notify pgrst, 'reload schema';
