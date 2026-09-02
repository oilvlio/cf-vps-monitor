-- Independent rollup storage. Raw history remains untouched for the latest day;
-- older buckets can be queried without window-ranking the raw tables.
create table if not exists public.records_rollup (
  client text not null references public.clients(uuid) on delete cascade,
  bucket_start timestamptz not null,
  sample_count integer not null default 0,
  avg_values jsonb not null default '{}'::jsonb,
  min_values jsonb not null default '{}'::jsonb,
  max_values jsonb not null default '{}'::jsonb,
  first_values jsonb not null default '{}'::jsonb,
  last_values jsonb not null default '{}'::jsonb,
  first_time timestamptz,
  last_time timestamptz,
  primary key (client, bucket_start)
);
create index if not exists idx_records_rollup_client_time on public.records_rollup(client, bucket_start);

create table if not exists public.gpu_rollup (
  client text not null references public.clients(uuid) on delete cascade,
  device_index integer not null default 0,
  bucket_start timestamptz not null,
  sample_count integer not null default 0,
  avg_values jsonb not null default '{}'::jsonb,
  min_values jsonb not null default '{}'::jsonb,
  max_values jsonb not null default '{}'::jsonb,
  first_time timestamptz,
  last_time timestamptz,
  primary key (client, device_index, bucket_start)
);
create index if not exists idx_gpu_rollup_client_time on public.gpu_rollup(client, bucket_start);

create table if not exists public.ping_rollup (
  client text not null references public.clients(uuid) on delete cascade,
  task_id bigint not null,
  bucket_start timestamptz not null,
  sample_count integer not null default 0,
  success_count integer not null default 0,
  loss_count integer not null default 0,
  avg_latency double precision,
  min_latency double precision,
  max_latency double precision,
  p75_latency double precision,
  first_time timestamptz,
  last_time timestamptz,
  primary key (client, task_id, bucket_start)
);
create index if not exists idx_ping_rollup_client_task_time on public.ping_rollup(client, task_id, bucket_start);

alter table public.records_rollup enable row level security;
alter table public.gpu_rollup enable row level security;
alter table public.ping_rollup enable row level security;
alter table public.records_rollup force row level security;
alter table public.gpu_rollup force row level security;
alter table public.ping_rollup force row level security;
revoke all on public.records_rollup, public.gpu_rollup, public.ping_rollup from public, anon, authenticated;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-history-rollup-tables')
on conflict (key) do update set value = excluded.value;

-- Build closed hourly buckets. This is intentionally an incremental operation:
-- callers pass the last processed time and never rank the whole history table.
create or replace function public.cfm_build_history_rollup(input_before text default null)
returns jsonb language plpgsql set search_path = public as $$
declare before_ts timestamptz := coalesce(nullif(input_before, '')::timestamptz, now() - interval '24 hours');
begin
  insert into records_rollup (client, bucket_start, sample_count, avg_values, min_values, max_values, first_values, last_values, first_time, last_time)
  select client, date_trunc('hour', time), count(*)::integer,
    jsonb_build_object('cpu',avg(cpu),'ram',avg(ram),'load',avg(load),'disk',avg(disk),'temp',avg(temp),'net_in',avg(net_in),'net_out',avg(net_out),'process_count',avg(process_count),'connections',avg(connections),'connections_udp',avg(connections_udp)),
    jsonb_build_object('cpu',min(cpu),'ram',min(ram),'load',min(load),'disk',min(disk),'temp',min(temp),'net_in',min(net_in),'net_out',min(net_out),'process_count',min(process_count),'connections',min(connections),'connections_udp',min(connections_udp)),
    jsonb_build_object('cpu',max(cpu),'ram',max(ram),'load',max(load),'disk',max(disk),'temp',max(temp),'net_in',max(net_in),'net_out',max(net_out),'process_count',max(process_count),'connections',max(connections),'connections_udp',max(connections_udp)),
    (array_agg(to_jsonb(records) order by time asc))[1], (array_agg(to_jsonb(records) order by time desc))[1], min(time), max(time)
  from records where time < before_ts and time >= before_ts - interval '2 hours'
  group by client, date_trunc('hour', time)
  on conflict (client,bucket_start) do update set sample_count=excluded.sample_count, avg_values=excluded.avg_values, min_values=excluded.min_values, max_values=excluded.max_values, first_values=excluded.first_values, last_values=excluded.last_values, first_time=excluded.first_time, last_time=excluded.last_time;

  insert into ping_rollup (client, task_id, bucket_start, sample_count, success_count, loss_count, avg_latency, min_latency, max_latency, first_time, last_time)
  select p.client, (item.key)::bigint, date_trunc('hour', p.time), count(*)::integer,
    count(*) filter (where (item.value)::integer >= 0)::integer,
    count(*) filter (where (item.value)::integer < 0)::integer,
    avg(nullif((item.value)::integer, -1)) filter (where (item.value)::integer >= 0),
    min(nullif((item.value)::integer, -1)) filter (where (item.value)::integer >= 0),
    max(nullif((item.value)::integer, -1)) filter (where (item.value)::integer >= 0), min(p.time), max(p.time)
  from ping_snapshots p cross join lateral jsonb_each(p.values_json) item
  where p.time < before_ts and p.time >= before_ts - interval '2 hours'
  group by p.client, item.key, date_trunc('hour',p.time)
  on conflict (client,task_id,bucket_start) do update set sample_count=excluded.sample_count, success_count=excluded.success_count, loss_count=excluded.loss_count, avg_latency=excluded.avg_latency, min_latency=excluded.min_latency, max_latency=excluded.max_latency, first_time=excluded.first_time, last_time=excluded.last_time;

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
revoke all on function public.cfm_build_history_rollup(text) from public, anon, authenticated;
grant execute on function public.cfm_build_history_rollup(text) to service_role;

create or replace function public.cfm_records_rollup_range(input_client text, input_start text, input_end text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(last_values || avg_values || jsonb_build_object('client', client, 'time', bucket_start, '_min', min_values, '_max', max_values) order by bucket_start), '[]'::jsonb)
  from records_rollup
  where client = input_client and bucket_start >= input_start::timestamptz and bucket_start <= input_end::timestamptz;
$$;
revoke all on function public.cfm_records_rollup_range(text,text,text) from public, anon, authenticated;
grant execute on function public.cfm_records_rollup_range(text,text,text) to service_role;

create or replace function public.cfm_ping_rollup_range(input_client text, input_task_id bigint, input_start text, input_end text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('client',client,'task_id',task_id,'time',bucket_start,'value',coalesce(avg_latency,-1),'loss_count',loss_count,'sample_count',sample_count) order by bucket_start),'[]'::jsonb)
  from ping_rollup where client=input_client and task_id=input_task_id and bucket_start >= input_start::timestamptz and bucket_start <= input_end::timestamptz;
$$;
revoke all on function public.cfm_ping_rollup_range(text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.cfm_ping_rollup_range(text,bigint,text,text) to service_role;

create or replace function public.cfm_gpu_rollup_range(input_client text, input_start text, input_end text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(avg_values || jsonb_build_object('client',client,'device_index',device_index,'time',bucket_start,'_min',min_values,'_max',max_values) order by bucket_start,device_index),'[]'::jsonb)
  from gpu_rollup where client=input_client and bucket_start >= input_start::timestamptz and bucket_start <= input_end::timestamptz;
$$;
revoke all on function public.cfm_gpu_rollup_range(text,text,text) from public, anon, authenticated;
grant execute on function public.cfm_gpu_rollup_range(text,text,text) to service_role;
