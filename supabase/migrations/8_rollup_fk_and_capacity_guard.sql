-- Two follow-ups from production:
-- 1) Rollup builds raced a concurrent Ping-task DELETE between the join and the
--    foreign-key check. Lock the referenced task keys before inserting.
-- 2) Capacity checks serialized every caller on an advisory lock while scanning
--    history heaps. Keep them catalog-based, exact only for tiny leaves, and
--    never block on another measurement.
set local search_path = public;

create or replace function public.cfm_build_ping_rollup(input_before text default null,input_max_buckets integer default 48)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
  before_ts timestamptz:=coalesce(nullif(input_before,'')::timestamptz,now()-interval '2 minutes');
  from_ts timestamptz; work_from timestamptz; work_to timestamptz; to_ts timestamptz;
  max_buckets integer:=least(greatest(coalesce(input_max_buckets,48),1),96);
  buckets integer:=0; raw_runway date; rollup_runway date; today date:=(now() at time zone 'UTC')::date;
begin
  select max(case when c.relname ~ '^ping_snapshots_p[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD')+1 end)
    into raw_runway from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.ping_snapshots'::regclass;
  select max(case when c.relname ~ '^ping_rollup_[pw][0-9]{8}$'
      then to_date(right(c.relname,8),'YYYYMMDD')+case when c.relname ~ '_w[0-9]{8}$' then 7 else 1 end end)
    into rollup_runway from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.ping_rollup'::regclass;
  if coalesce(raw_runway,today)<today+2 or coalesce(rollup_runway,today)<today+7 then
    perform public.cfm_ensure_ping_time_partitions(45);
  end if;
  select watermark into from_ts from public.ping_rollup_state where id=1 for update;
  if from_ts is null then
    select date_bin(interval '30 minutes',min(time),timestamptz '1970-01-01') into from_ts from public.ping_snapshots;
    if from_ts is null then return jsonb_build_object('watermark',null,'buckets',0,'has_more',false); end if;
    insert into public.ping_rollup_state(id,watermark) values(1,from_ts) on conflict(id) do nothing;
    select watermark into from_ts from public.ping_rollup_state where id=1;
  end if;
  to_ts:=least(date_bin(interval '30 minutes',before_ts,timestamptz '1970-01-01'),from_ts+max_buckets*interval '30 minutes');
  work_to:=greatest(from_ts,to_ts);
  if to_ts>from_ts then work_from:=from_ts-interval '2 hours'; else work_from:=from_ts; end if;
  if work_to>work_from then
    -- FOR KEY SHARE makes a concurrent task DELETE wait for this statement; the
    -- recheck then removes the row instead of failing the rollup's FK check.
    with expanded as(
      select s.client,s.time,t.id task_id,item.value raw_value
      from public.ping_snapshots s
      cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
      join public.ping_tasks t on t.id=case when item.key ~ '^[0-9]{1,9}$' then item.key::integer end
      join public.clients c on c.uuid=s.client
      where s.time>=work_from and s.time<work_to
      for key share of t,c
    ), typed as(
      select client,time,task_id,case when raw_value ~ '^-?[0-9]{1,10}$'
        then case when raw_value::numeric between -2147483648 and 2147483647 then raw_value::integer end end value
      from expanded
    )
    insert into public.ping_rollup(client,task_id,bucket_start,sample_count,success_count,loss_count,
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
    buckets:=floor(extract(epoch from(work_to-from_ts))/1800)::integer;
    if work_to>from_ts then update public.ping_rollup_state set watermark=work_to where id=1; end if;
  end if;
  return jsonb_build_object('watermark',work_to,'buckets',buckets,
    'lag_seconds',greatest(0,floor(extract(epoch from(now()-work_to))))::integer,
    'has_more',work_to<date_bin(interval '30 minutes',before_ts,timestamptz '1970-01-01'));
end $$;
revoke all on function public.cfm_build_ping_rollup(text,integer) from public,anon,authenticated;
grant execute on function public.cfm_build_ping_rollup(text,integer) to cf_monitor_app,service_role;

-- Catalog estimates plus an exact count for tiny leaves. reltuples is refreshed
-- by the ANALYZE that follows partition drops, so this no longer needs to read
-- every tuple on each capacity check.
create or replace function public.cfm_estimate_history_relation(input_root regclass)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare leaf record; live_rows bigint:=0; live_bytes bigint:=0; allocated bigint:=0;
  row_estimate bigint; exact_rows bigint; width_estimate bigint; heap_bytes bigint;
begin
  for leaf in with recursive tree(oid) as(
      select input_root::oid union all select i.inhrelid from pg_inherits i join tree t on t.oid=i.inhparent)
    select c.oid,c.relname,c.reltuples::bigint row_count from tree join pg_class c on c.oid=tree.oid
    where not exists(select 1 from pg_inherits i where i.inhparent=c.oid)
  loop
    heap_bytes:=pg_relation_size(leaf.oid);
    row_estimate:=leaf.row_count;
    -- reltuples is -1 until the first ANALYZE; count small new leaves directly
    -- and estimate very large unanalyzed ones rather than scanning them.
    if heap_bytes=0 then
      row_estimate:=0;
    elsif row_estimate<0 or heap_bytes<=8388608 then
      if heap_bytes<=268435456 then
        execute format('select count(*)::bigint from %s',leaf.oid::regclass) into exact_rows;
        row_estimate:=exact_rows;
      else
        row_estimate:=greatest(round(heap_bytes/128.0)::bigint,1);
      end if;
    end if;
    select coalesce(sum(avg_width),0)::bigint into width_estimate
      from pg_stats where schemaname='public' and tablename=leaf.relname;
    live_rows:=live_rows+greatest(row_estimate,0);
    if width_estimate>0 and row_estimate>0 then
      live_bytes:=live_bytes+width_estimate*row_estimate;
    elsif row_estimate>0 then
      -- Never-analyzed relation: its heap size is the best available bound.
      live_bytes:=live_bytes+heap_bytes;
    end if;
    allocated:=allocated+pg_total_relation_size(leaf.oid);
  end loop;
  return jsonb_build_object('live_rows',live_rows,'live_row_bytes',live_bytes,'allocated_bytes',allocated);
end $$;

create or replace function public.cfm_history_storage_usage()
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $$
declare cached jsonb; t text; estimate jsonb; tables_json jsonb:='{}'::jsonb;
  rows_total bigint:=0; bytes_total bigint:=0; allocated_total bigint:=0; result jsonb;
begin
  select usage into cached from public.history_storage_usage_cache where id=true and measured_at>now()-interval '10 minutes';
  if cached is not null then return cached; end if;
  -- No advisory lock: catalog reads are cheap, concurrent measurements are safe,
  -- and a slow caller must not queue every other RPC behind it.
  foreach t in array array['records','gpu_records','gpu_snapshots','ping_records','ping_snapshots','ping_rollup'] loop
    estimate:=public.cfm_estimate_history_relation(format('public.%I',t)::regclass);
    rows_total:=rows_total+(estimate->>'live_rows')::bigint;
    bytes_total:=bytes_total+(estimate->>'live_row_bytes')::bigint;
    allocated_total:=allocated_total+(estimate->>'allocated_bytes')::bigint;
    tables_json:=tables_json||jsonb_build_object(t,jsonb_build_object(
      'live_rows',(estimate->>'live_rows')::bigint,'live_row_bytes',(estimate->>'live_row_bytes')::bigint,
      'estimated_live_storage_bytes',(estimate->>'live_row_bytes')::bigint+(estimate->>'live_rows')::bigint*192,
      'allocated_bytes',(estimate->>'allocated_bytes')::bigint));
  end loop;
  result:=jsonb_build_object('live_rows',rows_total,'live_row_bytes',bytes_total,
    'estimated_live_storage_bytes',bytes_total+rows_total*192,'allocated_bytes',allocated_total,'reusable_bytes',null,
    'measurement','cached-live-row-estimate','cache_ttl_seconds',600,
    'measured_at',now(),'index_page_allowance_bytes_per_row',192,'tables',tables_json);
  insert into public.history_storage_usage_cache(id,usage,measured_at) values(true,result,now())
    on conflict(id) do update set usage=excluded.usage,measured_at=excluded.measured_at;
  return result;
end $$;

-- Keep the ten-minute cache across ordinary row deletes; only partition drops
-- change the shape enough to justify an immediate re-measure (and ANALYZE).
create or replace function public.cfm_delete_old_records(input_before_time text,input_max_batches integer default 200)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
  cutoff timestamptz:=input_before_time::timestamptz;
  lim integer:=least(greatest(coalesce(input_max_batches,200),1),1000)*100;
  n_records integer:=0; n_gpu integer:=0; n_snapshots integer:=0; n_parts integer:=0;
begin
  perform public.cfm_ensure_history_time_partitions(45);
  n_parts:=public.cfm_prune_history_time_partitions(cutoff);
  with doomed as(select time,id from public.records where time<cutoff order by time,id limit lim),
  d as(delete from public.records r using doomed x where r.time=x.time and r.id=x.id returning 1) select count(*)::integer into n_records from d;
  with doomed as(select time,id from public.gpu_records where time<cutoff order by time,id limit lim),
  d as(delete from public.gpu_records r using doomed x where r.time=x.time and r.id=x.id returning 1) select count(*)::integer into n_gpu from d;
  with doomed as(select time,id from public.gpu_snapshots where time<cutoff order by time,id limit lim),
  d as(delete from public.gpu_snapshots r using doomed x where r.time=x.time and r.id=x.id returning 1) select count(*)::integer into n_snapshots from d;
  if n_parts>0 then
    analyze public.records;
    analyze public.gpu_records;
    analyze public.gpu_snapshots;
    delete from public.history_storage_usage_cache;
  end if;
  return jsonb_build_object('records',n_records,'gpu_records',n_gpu,'gpu_snapshots',n_snapshots,
    'partitions_dropped',n_parts,'has_more',exists(select 1 from public.records where time<cutoff)
      or exists(select 1 from public.gpu_records where time<cutoff) or exists(select 1 from public.gpu_snapshots where time<cutoff));
end $$;
revoke all on function public.cfm_delete_old_records(text,integer) from public,anon,authenticated;
grant execute on function public.cfm_delete_old_records(text,integer) to service_role;

revoke all on function public.cfm_estimate_history_relation(regclass) from public,anon,authenticated;
grant execute on function public.cfm_estimate_history_relation(regclass) to service_role;
revoke all on function public.cfm_history_storage_usage() from public,anon,authenticated;
grant execute on function public.cfm_history_storage_usage() to service_role;

notify pgrst,'reload schema';
