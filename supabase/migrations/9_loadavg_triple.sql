-- CPU 负载三元组：records.load（Load1）之外新增 load5/load15。
--
-- 背景：探针原来只报 Load1（agent main.go 经 loadAverageReportable() 可信度门控，
-- 不可信则序列化成 null，老探针缺字段服务端按 0）。1/5/15 分钟三条线要全链路贯通，
-- 落库与读侧必须先有列。
--
-- 幂等：add column if not exists；函数 create or replace；grant 可重复执行。
-- 本文件内建列 DDL 必须排在引用它的函数之前（见
-- worker/src/utils/migration-column-order.test.mjs，存量库 language sql 函数在
-- CREATE 时就做语义校验，列不存在直接 42703 中止整批迁移）。

alter table public.records
  add column if not exists load5 double precision,
  add column if not exists load15 double precision;

comment on column public.records.load5 is 'CPU 1/5/15 分钟负载中的 5 分钟值；null = 探针报告本机负载不可取信，不是 0。';
comment on column public.records.load15 is 'CPU 1/5/15 分钟负载中的 15 分钟值；null = 探针报告本机负载不可取信，不是 0。';

-- 表级 grant 已在 2_security_access.sql 按整表授予，新列自动覆盖；
-- 这里幂等重申，保证刷新后的 PostgREST schema 缓存与 app 角色一致。
-- policy 是 for all 整表的，不用动。
grant select, insert, update, delete on table public.records to cf_monitor_app, service_role;

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

revoke all on function public.cfm_insert_monitor_record(jsonb) from public;
revoke all on function public.cfm_insert_monitor_record(jsonb) from anon;
revoke all on function public.cfm_insert_monitor_record(jsonb) from authenticated;
grant execute on function public.cfm_insert_monitor_record(jsonb) to service_role;

-- 读侧 RPC 里显式列清单的三处（cfm_recent_records、cfm_latest_records、
-- cfm_records_range、cfm_records_range_limited 走 select *，自动带上新列，不用动；
-- records rollup 目前只写 gpu_rollup，records_rollup 的 avg_values 构造不存在，
-- 按约定不动，只补读侧）。

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

revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from public;
revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from anon;
revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from authenticated;
grant execute on function public.cfm_records_range_paged(text, text, text, integer, integer) to service_role;

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

revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from public;
revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from anon;
revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from authenticated;
grant execute on function public.cfm_records_range_cursor(text, text, text, text, integer) to service_role;

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

revoke all on function public.cfm_records_range_bucketed(text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.cfm_records_range_bucketed(text, text, text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
