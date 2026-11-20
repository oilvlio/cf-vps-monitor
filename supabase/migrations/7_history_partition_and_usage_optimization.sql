-- Switch the high-volume host/GPU history heaps to daily RANGE partitions.
-- Existing rows are attached in place as one legacy partition (no rewrite).
set local search_path=public;

do $$
declare
  t text; old_name text; seq_name text; upper_day date; max_id bigint; idx text;
begin
  foreach t in array array['records','gpu_records','gpu_snapshots'] loop
    if (select relkind from pg_class where oid=format('public.%I',t)::regclass)='p' then continue; end if;
    old_name:=t||'_legacy_heap';
    execute format('select greatest(coalesce(max((time at time zone ''UTC'')::date)+1,(now() at time zone ''UTC'')::date+1),(now() at time zone ''UTC'')::date+1),max(id) from public.%I',t)
      into upper_day,max_id;
    execute format('alter table public.%I rename to %I',t,old_name);
    execute format('alter table public.%I alter column id drop identity if exists',old_name);
    execute format('alter table public.%I alter column id drop default',old_name);
    execute format('alter table public.%I drop constraint if exists %I_pkey',old_name,t);
    execute format('alter table public.%I add constraint %I_legacy_range_check check(time<%L::timestamptz) not valid',old_name,t,upper_day::text||' 00:00:00+00');
    execute format('alter table public.%I validate constraint %I_legacy_range_check',old_name,t);
    foreach idx in array array['idx_'||t||'_client_time','idx_'||t||'_time'] loop
      if to_regclass('public.'||idx) is not null then execute format('alter index public.%I rename to %I',idx,idx||'_legacy'); end if;
    end loop;
    seq_name:=t||'_partitioned_id_seq';
    execute format('create sequence if not exists public.%I as bigint',seq_name);
    execute format('create table public.%I(like public.%I including defaults including storage including comments) partition by range(time)',t,old_name);
    execute format('alter table public.%I alter column id set default nextval(%L::regclass)',t,'public.'||seq_name);
    execute format('alter sequence public.%I owned by public.%I.id',seq_name,t);
    execute format('alter table public.%I add constraint %I_pkey primary key(time,id)',t,t);
    execute format('alter table public.%I add constraint %I_client_fkey foreign key(client) references public.clients(uuid) deferrable initially deferred',t,t);
    execute format('alter table public.%I attach partition public.%I for values from(minvalue) to(%L)',t,old_name,upper_day::text||' 00:00:00+00');
    execute format('alter table public.%I rename to %I',old_name,t||'_legacy_'||to_char(upper_day,'YYYYMMDD'));
    execute format('select pg_catalog.setval(%L::regclass,greatest(coalesce($1,0),1),$1 is not null)', 'public.'||seq_name) using max_id;
    idx:='idx_'||t||'_client_time';
    execute format('create index %I on only public.%I(client,time)',idx,t);
    if to_regclass('public.'||idx||'_legacy') is not null then execute format('alter index public.%I attach partition public.%I',idx,idx||'_legacy'); end if;
    idx:='idx_'||t||'_time';
    execute format('create index %I on only public.%I(time)',idx,t);
    if to_regclass('public.'||idx||'_legacy') is not null then execute format('alter index public.%I attach partition public.%I',idx,idx||'_legacy'); end if;
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to cf_monitor_app,service_role',t);
    execute format('grant usage,select on sequence public.%I to cf_monitor_app,service_role',seq_name);
    execute format('create policy cf_monitor_app_all on public.%I for all to cf_monitor_app using(true) with check(true)',t);
  end loop;
end $$;

create or replace function public.cfm_history_storage_bytes()
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'records',public.cfm_partition_tree_total_bytes('public.records'::regclass),
    'gpu_records',public.cfm_partition_tree_total_bytes('public.gpu_records'::regclass),
    'gpu_snapshots',public.cfm_partition_tree_total_bytes('public.gpu_snapshots'::regclass),
    'ping_records',pg_total_relation_size('public.ping_records'),
    'ping_snapshots',public.cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass),
    'ping_rollup',public.cfm_partition_tree_total_bytes('public.ping_rollup'::regclass),
    'total',public.cfm_partition_tree_total_bytes('public.records'::regclass)
      +public.cfm_partition_tree_total_bytes('public.gpu_records'::regclass)
      +public.cfm_partition_tree_total_bytes('public.gpu_snapshots'::regclass)
      +pg_total_relation_size('public.ping_records')
      +public.cfm_partition_tree_total_bytes('public.ping_snapshots'::regclass)
      +public.cfm_partition_tree_total_bytes('public.ping_rollup'::regclass));
$$;

create table if not exists public.history_storage_usage_cache(
  id boolean primary key default true check(id), usage jsonb not null, measured_at timestamptz not null default now()
);
revoke all on public.history_storage_usage_cache from public,anon,authenticated,cf_monitor_app,service_role;

create or replace function public.cfm_estimate_history_relation(input_root regclass)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare leaf record; sample_rows bigint; sample_bytes bigint; row_estimate bigint; width_estimate bigint;
  exact_rows bigint; exact_bytes bigint; scaled_rows bigint; live_rows bigint:=0; live_bytes bigint:=0; allocated bigint:=0;
begin
  for leaf in with recursive tree(oid) as(
      select input_root::oid union all select i.inhrelid from pg_inherits i join tree t on t.oid=i.inhparent)
    select c.oid,c.relname,greatest(c.reltuples::bigint,0) row_count from tree join pg_class c on c.oid=tree.oid
    where not exists(select 1 from pg_inherits i where i.inhparent=c.oid)
  loop
    row_estimate:=leaf.row_count;
    if pg_relation_size(leaf.oid)<=33554432 then
      -- Small leaves can be counted exactly; this keeps a mass DELETE visible
      -- to the capacity fuse even before autovacuum refreshes reltuples.
      execute format('select count(*)::bigint,coalesce(sum(pg_catalog.pg_column_size(s)),0)::bigint from %s as s',leaf.oid::regclass)
        into exact_rows,exact_bytes;
      live_rows:=live_rows+exact_rows;
      live_bytes:=live_bytes+exact_bytes;
    else
      execute format('select count(*)::bigint,coalesce(sum(pg_catalog.pg_column_size(s)),0)::bigint from %s as s tablesample system (10)',leaf.oid::regclass)
        into sample_rows,sample_bytes;
      if sample_rows>0 then
        -- SYSTEM sampling returns a fraction of blocks, so scale the measured
        -- live tuples/bytes back to the whole leaf. Dead tuples are not counted.
        scaled_rows:=greatest(round(sample_rows*10.0)::bigint,1);
        live_rows:=live_rows+scaled_rows;
        live_bytes:=live_bytes+round(sample_bytes::numeric/sample_rows*scaled_rows)::bigint;
      else
        select coalesce(sum(avg_width),0)::bigint into width_estimate from pg_stats where schemaname='public' and tablename=leaf.relname;
        live_rows:=live_rows+row_estimate;
        if width_estimate>0 then live_bytes:=live_bytes+width_estimate*row_estimate;
        elsif row_estimate>0 then live_bytes:=live_bytes+greatest(pg_relation_size(leaf.oid)/row_estimate,1)*row_estimate;
        end if;
      end if;
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
  perform pg_advisory_xact_lock(86421027);
  select usage into cached from public.history_storage_usage_cache where id=true and measured_at>now()-interval '10 minutes';
  if cached is not null then return cached; end if;
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
    'measurement','cached-system-sample-estimate','sample_percent',10,'cache_ttl_seconds',600,
    'measured_at',now(),'index_page_allowance_bytes_per_row',192,'tables',tables_json);
  insert into public.history_storage_usage_cache(id,usage,measured_at) values(true,result,now())
    on conflict(id) do update set usage=excluded.usage,measured_at=excluded.measured_at;
  return result;
end $$;

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
  end if;
  delete from public.history_storage_usage_cache;
  return jsonb_build_object('records',n_records,'gpu_records',n_gpu,'gpu_snapshots',n_snapshots,
    'partitions_dropped',n_parts,'has_more',exists(select 1 from public.records where time<cutoff)
      or exists(select 1 from public.gpu_records where time<cutoff) or exists(select 1 from public.gpu_snapshots where time<cutoff));
end $$;

-- Raw Ping stays daily. Sparse rollups use weekly partitions after the small
-- daily bridge and only keep a fourteen-day creation runway.
create or replace function public.cfm_ensure_ping_time_partitions(input_days_ahead integer default 45)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
  today date:=(now() at time zone 'UTC')::date;
  raw_target date:=today+least(greatest(coalesce(input_days_ahead,45),1),90);
  rollup_target date:=today+14;
  last_end date; d date; part record; has_data boolean; made integer:=0;
begin
  perform pg_advisory_xact_lock(86421026);
  select max(case when c.relname ~ '^ping_snapshots_p[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD')+1
    when c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD') end)
    into last_end from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.ping_snapshots'::regclass;
  d:=coalesce(last_end,today);
  while d<=raw_target loop
    execute format('create table if not exists public.%I partition of public.ping_snapshots for values from(%L) to(%L)',
      'ping_snapshots_p'||to_char(d,'YYYYMMDD'),d::text||' 00:00:00+00',(d+1)::text||' 00:00:00+00');
    d:=d+1; made:=made+1;
  end loop;

  -- Remove only empty daily partitions beyond tomorrow; never discard future-dated data.
  for part in select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid
    where i.inhparent='public.ping_rollup'::regclass and c.relname ~ '^ping_rollup_p[0-9]{8}$'
      and to_date(right(c.relname,8),'YYYYMMDD')>today+1 loop
    execute format('select exists(select 1 from public.%I)',part.relname) into has_data;
    if not has_data then execute format('drop table public.%I',part.relname); end if;
  end loop;
  select max(case when c.relname ~ '^ping_rollup_p[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD')+1
    when c.relname ~ '^ping_rollup_w[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD')+7
    when c.relname ~ '^ping_rollup_legacy_[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD') end)
    into last_end from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.ping_rollup'::regclass;
  d:=coalesce(last_end,today);
  -- Existing daily children end at last_end; all newly created children are
  -- seven-day ranges, anchored to that boundary (not necessarily Monday).
  while d<=rollup_target loop
    if to_regclass('public.ping_rollup_p'||to_char(d,'YYYYMMDD')) is not null then
      execute format('select exists(select 1 from public.%I)','ping_rollup_p'||to_char(d,'YYYYMMDD')) into has_data;
      if not has_data then execute format('drop table public.%I','ping_rollup_p'||to_char(d,'YYYYMMDD')); end if;
    end if;
    execute format('create table if not exists public.%I partition of public.ping_rollup for values from(%L) to(%L)',
      'ping_rollup_w'||to_char(d,'YYYYMMDD'),d::text||' 00:00:00+00',(d+7)::text||' 00:00:00+00');
    d:=d+7; made:=made+1;
  end loop;
  return jsonb_build_object('partitions_created',made,'raw_through',raw_target,'rollup_through',rollup_target);
end $$;

create or replace function public.cfm_prune_ping_time_partitions(input_snapshots_before timestamptz,input_rollups_before timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare part record; ends_at timestamptz; n_raw integer:=0; n_rollup integer:=0; lock_timeouts integer:=0;
  previous_lock_timeout text:=current_setting('lock_timeout');
begin
  if not pg_try_advisory_xact_lock(86421026) then
    return jsonb_build_object('ping_snapshot_partitions',0,'ping_rollup_partitions',0,'partitions_pending',true,'has_more',true);
  end if;
  perform public.cfm_ensure_ping_time_partitions(45);
  perform set_config('lock_timeout','2s',true);
  for part in select c.relname,'raw' kind from pg_inherits i join pg_class c on c.oid=i.inhrelid
      where i.inhparent='public.ping_snapshots'::regclass and (c.relname ~ '^ping_snapshots_p[0-9]{8}$' or c.relname ~ '^ping_snapshots_legacy_[0-9]{8}$')
    union all
    select c.relname,'rollup' kind from pg_inherits i join pg_class c on c.oid=i.inhrelid
      where i.inhparent='public.ping_rollup'::regclass and (c.relname ~ '^ping_rollup_p[0-9]{8}$' or c.relname ~ '^ping_rollup_w[0-9]{8}$' or c.relname ~ '^ping_rollup_legacy_[0-9]{8}$')
  loop
    if part.kind='raw' then
      if part.relname ~ '_p[0-9]{8}$' then ends_at:=(to_date(right(part.relname,8),'YYYYMMDD')+1)::timestamp at time zone 'UTC';
      else ends_at:=to_date(right(part.relname,8),'YYYYMMDD')::timestamp at time zone 'UTC'; end if;
      if input_snapshots_before is not null and ends_at<=input_snapshots_before then
        begin execute format('drop table public.%I',part.relname); n_raw:=n_raw+1;
        exception when lock_not_available then lock_timeouts:=lock_timeouts+1; exit; end;
      end if;
    else
      if part.relname ~ '_p[0-9]{8}$' then ends_at:=(to_date(right(part.relname,8),'YYYYMMDD')+1)::timestamp at time zone 'UTC';
      elsif part.relname ~ '_w[0-9]{8}$' then ends_at:=(to_date(right(part.relname,8),'YYYYMMDD')+7)::timestamp at time zone 'UTC';
      else ends_at:=to_date(right(part.relname,8),'YYYYMMDD')::timestamp at time zone 'UTC'; end if;
      if input_rollups_before is not null and ends_at<=input_rollups_before then
        begin execute format('drop table public.%I',part.relname); n_rollup:=n_rollup+1;
        exception when lock_not_available then lock_timeouts:=lock_timeouts+1; exit; end;
      end if;
    end if;
  end loop;
  perform set_config('lock_timeout',previous_lock_timeout,true);
  return jsonb_build_object('ping_snapshot_partitions',n_raw,'ping_rollup_partitions',n_rollup,
    'partitions_pending',lock_timeouts>0,'has_more',lock_timeouts>0);
end $$;

create or replace function public.cfm_ensure_history_time_partitions(input_days_ahead integer default 45)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare t text; last_end date; d date; target date:=(now() at time zone 'UTC')::date+least(greatest(coalesce(input_days_ahead,45),1),90); made integer:=0;
begin
  if not pg_try_advisory_xact_lock(86421028) then return jsonb_build_object('partitions_created',0,'skipped',true,'through',target); end if;
  foreach t in array array['records','gpu_records','gpu_snapshots'] loop
    execute format($q$select max(case when c.relname ~ '^%s_p[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD')+1
      when c.relname ~ '^%s_legacy_[0-9]{8}$' then to_date(right(c.relname,8),'YYYYMMDD') end)
      from pg_inherits i join pg_class c on c.oid=i.inhrelid where i.inhparent='public.%s'::regclass$q$,t,t,t) into last_end;
    d:=coalesce(last_end,(now() at time zone 'UTC')::date);
    while d<=target loop
      execute format('create table if not exists public.%I partition of public.%I for values from(%L) to(%L)',t||'_p'||to_char(d,'YYYYMMDD'),t,d::text||' 00:00:00+00',(d+1)::text||' 00:00:00+00');
      d:=d+1; made:=made+1;
    end loop;
  end loop;
  return jsonb_build_object('partitions_created',made,'through',target);
end $$;

create or replace function public.cfm_prune_history_time_partitions(input_before timestamptz)
returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare child record; ends_at timestamptz; dropped integer:=0; previous_lock_timeout text:=current_setting('lock_timeout');
begin
  if not pg_try_advisory_xact_lock(86421028) then return 0; end if;
  perform set_config('lock_timeout','2s',true);
  for child in select c.relname from pg_inherits i join pg_class c on c.oid=i.inhrelid
    where i.inhparent in('public.records'::regclass,'public.gpu_records'::regclass,'public.gpu_snapshots'::regclass)
      and c.relname ~ '^(records|gpu_records|gpu_snapshots)_(p|legacy_)[0-9]{8}$'
  loop
    if child.relname ~ '_p[0-9]{8}$' then ends_at:=(to_date(right(child.relname,8),'YYYYMMDD')+1)::timestamp at time zone 'UTC';
    else ends_at:=to_date(right(child.relname,8),'YYYYMMDD')::timestamp at time zone 'UTC'; end if;
    if ends_at<=input_before then
      begin execute format('drop table public.%I',child.relname); dropped:=dropped+1;
      exception when lock_not_available or undefined_table then exit; end;
    end if;
  end loop;
  perform set_config('lock_timeout',previous_lock_timeout,true);
  return dropped;
end $$;

-- Include newly partitioned tables when clearing storage and reset their owned
-- sequences through pg_get_serial_sequence (no sequence names are assumed).
create or replace function public.cfm_clear_all_records()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare d_records integer; d_gpu integer; d_gpu_snapshots integer; d_ping_records integer;
  d_ping_snapshots integer; d_rollup integer; t text; seq_name text;
begin
  select count(*)::integer into d_records from public.records;
  select count(*)::integer into d_gpu from public.gpu_records;
  select count(*)::integer into d_gpu_snapshots from public.gpu_snapshots;
  select count(*)::integer into d_ping_records from public.ping_records;
  select count(*)::integer into d_ping_snapshots from public.ping_snapshots;
  select count(*)::integer into d_rollup from public.ping_rollup;
  truncate table public.records,public.gpu_records,public.gpu_snapshots,public.ping_records,public.ping_snapshots,public.ping_rollup;
  foreach t in array array['records','gpu_records','gpu_snapshots','ping_snapshots'] loop
    seq_name:=pg_get_serial_sequence('public.'||t,'id');
    if seq_name is not null then execute format('select pg_catalog.setval(%L::regclass,1,false)',seq_name); end if;
  end loop;
  analyze public.records;
  analyze public.gpu_records;
  analyze public.gpu_snapshots;
  analyze public.ping_records;
  analyze public.ping_snapshots;
  analyze public.ping_rollup;
  delete from public.ping_rollup_state;
  delete from public.history_storage_usage_cache;
  return jsonb_build_object('deleted',jsonb_build_object('records',d_records,'gpu_records',d_gpu,
      'gpu_snapshots',d_gpu_snapshots,'ping_records',d_ping_records,'ping_snapshots',d_ping_snapshots,'ping_rollup',d_rollup),
    'remaining',jsonb_build_object('records',0,'gpu_records',0,'gpu_snapshots',0,'ping_records',0,
      'ping_snapshots',0,'ping_rollup',0),'has_more',false);
end $$;
revoke all on function public.cfm_clear_all_records() from public,anon,authenticated;
grant execute on function public.cfm_clear_all_records() to service_role;

-- Build rollups on the hot path without running partition DDL every time.
-- The daily cleanup calls ensure; here we only create children when the
-- existing runway is about to run out.
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
    with expanded as(
      select s.client,s.time,t.id task_id,item.value raw_value
      from public.ping_snapshots s
      cross join lateral jsonb_each_text(case when jsonb_typeof(s.values_json)='object' then s.values_json else '{}'::jsonb end) item
      join public.ping_tasks t on t.id=case when item.key ~ '^[0-9]{1,9}$' then item.key::integer end
      join public.clients c on c.uuid=s.client
      where s.time>=work_from and s.time<work_to
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

-- ping_records is a read-only legacy heap: application reads use
-- ping_snapshots (cfm_ping_records*) and no migration or Worker path writes it.
comment on table public.ping_records is
  'Legacy Ping rows kept for upgrade compatibility; read-only, no writer. Reads use ping_snapshots.';

revoke all on function public.cfm_ensure_history_time_partitions(integer) from public,anon,authenticated;
grant execute on function public.cfm_ensure_history_time_partitions(integer) to service_role,cf_monitor_app;
revoke all on function public.cfm_prune_history_time_partitions(timestamptz) from public,anon,authenticated;
grant execute on function public.cfm_prune_history_time_partitions(timestamptz) to service_role;
revoke all on function public.cfm_delete_old_records(text,integer) from public,anon,authenticated;
grant execute on function public.cfm_delete_old_records(text,integer) to service_role;
revoke all on function public.cfm_estimate_history_relation(regclass) from public,anon,authenticated;
grant execute on function public.cfm_estimate_history_relation(regclass) to service_role;
revoke all on function public.cfm_history_storage_usage() from public,anon,authenticated;
grant execute on function public.cfm_history_storage_usage() to service_role;

select public.cfm_ensure_history_time_partitions(45);
select public.cfm_ensure_ping_time_partitions(45);
notify pgrst,'reload schema';
