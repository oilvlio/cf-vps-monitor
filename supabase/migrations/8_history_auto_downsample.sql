-- Write: 24h raw; 24h~3d keep 15m; 3d~7d keep 30m; older delete.
-- Read: bucketed newest-per-bucket for chart ranges.

create or replace function public.cfm_compact_history(input_now text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  now_ts timestamptz := coalesce(nullif(input_now, '')::timestamptz, now());
  table_name text;
  n integer;
  total jsonb := '{}'::jsonb;
begin
  foreach table_name in array array['records', 'gpu_snapshots', 'ping_snapshots'] loop
    execute format($fmt$
      with ranked as (
        select id,
          row_number() over (
            partition by client,
              case
                when time >= $1 - interval '3 days' then floor(extract(epoch from time) / 900)
                else floor(extract(epoch from time) / 1800)
              end
            order by time desc, id desc
          ) as rn
        from %I
        where time < $1 - interval '24 hours'
          and time >= $1 - interval '7 days'
      ),
      doomed as (
        select id from ranked where rn > 1
        union
        select id from %I where time < $1 - interval '7 days'
      ),
      deleted as (
        delete from %I where id in (select id from doomed) returning 1
      )
      select count(*) from deleted
    $fmt$, table_name, table_name, table_name)
    into n
    using now_ts;
    total := total || jsonb_build_object(table_name, n);
  end loop;

  execute $fmt$
    with ranked as (
      select id,
        row_number() over (
          partition by client, task_id,
            case
              when time >= $1 - interval '3 days' then floor(extract(epoch from time) / 900)
              else floor(extract(epoch from time) / 1800)
            end
          order by time desc, id desc
        ) as rn
      from ping_records
      where time < $1 - interval '24 hours'
        and time >= $1 - interval '7 days'
    ),
    doomed as (
      select id from ranked where rn > 1
      union
      select id from ping_records where time < $1 - interval '7 days'
    ),
    deleted as (
      delete from ping_records where id in (select id from doomed) returning 1
    )
    select count(*) from deleted
  $fmt$
  into n
  using now_ts;

  return total || jsonb_build_object('ping_records', n);
end;
$$;

revoke all on function public.cfm_compact_history(text) from public, anon, authenticated;
grant execute on function public.cfm_compact_history(text) to service_role;

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
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
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
          select id, client, task_id, time, value
          from (
            select
              id,
              client,
              tid as task_id,
              time,
              (values_json ->> tid::text)::integer as value,
              row_number() over (
                partition by floor(extract(epoch from time) / safe_bucket)
                order by time desc, id desc
              ) as rn
            from ping_snapshots
            where client = input_client
              and values_json ? tid::text
              and (input_start is null or time >= input_start::timestamptz)
              and (input_end is null or time <= input_end::timestamptz)
          ) ranked
          where rn = 1
          order by time asc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;
  return result;
end;
$$;

revoke all on function public.cfm_ping_records_for_tasks_range_bucketed(text, jsonb, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.cfm_ping_records_for_tasks_range_bucketed(text, jsonb, text, text, integer, integer)
  to service_role;

update settings set value = '168'
where key in ('record_preserve_time', 'ping_record_preserve_time')
  and value in ('72', '720');

notify pgrst, 'reload schema';
