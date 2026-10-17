-- 首页节点卡片的「首页探测点」：每个节点最多选一个 ping 任务，
-- 卡片上的延迟 / 丢包色块只读这个任务的数据。
-- 单独建表而不是给 clients 加列：clients 的读写 RPC 都是显式列清单，
-- 加列需要整体重写它们，风险远大于收益。
create table if not exists public.client_home_ping (
  client text primary key references public.clients(uuid) on delete cascade,
  task_id bigint not null references public.ping_tasks(id) on delete cascade,
  updated_at timestamptz not null default now()
);

alter table public.client_home_ping enable row level security;
alter table public.client_home_ping force row level security;
revoke all on public.client_home_ping from public, anon, authenticated;

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

revoke all on function public.cfm_home_ping_assignments() from public, anon, authenticated;
grant execute on function public.cfm_home_ping_assignments() to service_role;

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

revoke all on function public.cfm_set_home_ping_task(text, bigint) from public, anon, authenticated;
grant execute on function public.cfm_set_home_ping_task(text, bigint) to service_role;

-- 一次性取出所有已设置首页探测点的节点在 [input_start, input_end] 内的原始快照。
-- ping_snapshots 只在「状态跳变 / 满 30 分钟心跳」时才落库，是稀疏的变化日志，
-- 所以 Worker 需要窗口起点之前的最近一条做种子，按时间向前填充后再分桶。
-- 调用方应把 input_start 提前到窗口起点之前（Worker 提前 1 小时）。
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

revoke all on function public.cfm_home_ping_rows(text, text, integer) from public, anon, authenticated;
grant execute on function public.cfm_home_ping_rows(text, text, integer) to service_role;

notify pgrst, 'reload schema';
