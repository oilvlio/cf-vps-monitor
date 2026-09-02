-- Final history policy: keep 24h raw, then one newest row per hour, retain 7d.
create or replace function public.cfm_compact_history(input_now text default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  now_ts timestamptz := coalesce(nullif(input_now, '')::timestamptz, now());
  table_name text; n integer; total jsonb := '{}'::jsonb;
begin
  foreach table_name in array array['records', 'gpu_snapshots', 'ping_snapshots'] loop
    execute format('with ranked as (select id, row_number() over (partition by client, floor(extract(epoch from time)/3600) order by time desc, id desc) rn from %I where time < $1 - interval ''24 hours''), doomed as (select id from ranked where rn > 1 union select id from %I where time < $1 - interval ''7 days''), deleted as (delete from %I where id in (select id from doomed) returning 1) select count(*) from deleted', table_name, table_name, table_name) into n using now_ts;
    total := total || jsonb_build_object(table_name, n);
  end loop;
  execute 'with ranked as (select id, row_number() over (partition by client, task_id, floor(extract(epoch from time)/3600) order by time desc, id desc) rn from ping_records where time < $1 - interval ''24 hours''), doomed as (select id from ranked where rn > 1 union select id from ping_records where time < $1 - interval ''7 days''), deleted as (delete from ping_records where id in (select id from doomed) returning 1) select count(*) from deleted' into n using now_ts;
  return total || jsonb_build_object('ping_records', n);
end;
$$;
revoke all on function public.cfm_compact_history(text) from public;
revoke all on function public.cfm_compact_history(text) from anon;
revoke all on function public.cfm_compact_history(text) from authenticated;
grant execute on function public.cfm_compact_history(text) to service_role;

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
revoke all on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) from public;
revoke all on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) from anon;
revoke all on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) from authenticated;
grant execute on function public.cfm_ping_records_for_tasks_range(text, jsonb, text, text, integer) to service_role;

update settings set value = '168' where key in ('record_preserve_time', 'ping_record_preserve_time') and value = '720';
