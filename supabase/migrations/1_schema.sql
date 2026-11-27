-- 表结构终态、约束、索引、RLS、角色授权与默认数据。
-- 本文件按「全新安装终态」编写：全新库直接得到 v2 历史布局；旧库通过下面的
-- 一次性检测丢弃历史表（v2 不保留历史）后重建。全部语句幂等。
-- 函数（RPC）在 2_functions.sql。
set local search_path = public;

-- ---------------------------------------------------------------------------
-- One-time legacy layout guard.
--
-- v2 does not preserve history. An install that still has the pre-v2 layout
-- drops only its history tables (plus the dead tables/caches from that layout)
-- here, and the rest of this file rebuilds the final structure. On a v2
-- database every condition is false, so a replay is a no-op and history
-- survives.
-- ---------------------------------------------------------------------------
do $$
declare
  legacy_layout boolean;
begin
  select
    exists (
      select 1 from pg_attribute
      where attrelid = to_regclass('public.records')
        and attname = 'id' and not attisdropped
    )
    or exists (
      select 1 from pg_attribute
      where attrelid = to_regclass('public.ping_snapshots')
        and attname = 'batch_hash' and not attisdropped
    )
    or to_regclass('public.gpu_records') is not null
    or to_regclass('public.ping_records') is not null
    or (
      to_regclass('public.ping_rollup') is not null
      and (select relkind from pg_class where oid = to_regclass('public.ping_rollup')) <> 'p'
    )
    or (
      to_regclass('public.records') is not null
      and (select relkind from pg_class where oid = to_regclass('public.records')) <> 'p'
    )
  into legacy_layout;

  if legacy_layout then
    -- Raw history first, then rollups. Dropping a partitioned parent removes
    -- all of its children, indexes and triggers in one statement.
    drop table if exists public.records cascade;
    drop table if exists public.ping_snapshots cascade;
    drop table if exists public.gpu_snapshots cascade;
    drop table if exists public.ping_rollup cascade;
    drop table if exists public.gpu_rollup cascade;
    drop table if exists public.host_rollup cascade;
    -- Dead tables / caches from the pre-v2 layout.
    drop table if exists public.gpu_records cascade;
    drop table if exists public.ping_records cascade;
    drop table if exists public.history_storage_usage_cache cascade;
    drop function if exists public.cfm_estimate_history_relation(regclass);

    -- cfm_internal tables may not exist on a very old install.
    if to_regclass('cfm_internal.partition_bounds') is not null then
      delete from cfm_internal.partition_bounds;
    end if;
    if to_regclass('cfm_internal.rollup_state') is not null then
      delete from cfm_internal.rollup_state;
    end if;
    if to_regclass('cfm_internal.rollup_dirty') is not null then
      delete from cfm_internal.rollup_dirty;
    end if;
  end if;
end $$;

-- GPU history is retired. Drop it unconditionally so an existing v2 install
-- converges too; the legacy branch above already covers older layouts.
drop table if exists public.gpu_snapshots cascade;
drop table if exists public.gpu_rollup cascade;

-- Existing v2 rollup bookkeeping may still contain rows from the retired GPU
-- family; the new check constraints are not retroactively applied to old tables.
do $$
begin
  if to_regclass('cfm_internal.rollup_state') is not null then
    delete from cfm_internal.rollup_state where family = 'gpu';
  end if;
  if to_regclass('cfm_internal.rollup_dirty') is not null then
    delete from cfm_internal.rollup_dirty where family = 'gpu';
  end if;
end $$;


create table if not exists clients (
  uuid text primary key,
  token text unique,
  token_hash text unique,
  token_last_used_at timestamptz,
  token_last_used_ip text,
  token_rotated_at timestamptz,
  name text not null default '',
  cpu_name text not null default '',
  virtualization text not null default '',
  arch text not null default '',
  cpu_cores integer not null default 0,
  os text not null default '',
  kernel_version text not null default '',
  gpu_name text not null default '',
  ipv4 text not null default '',
  ipv6 text not null default '',
  region text not null default '',
  remark text not null default '',
  public_remark text not null default '',
  mem_total bigint not null default 0,
  swap_total bigint not null default 0,
  disk_total bigint not null default 0,
  version text not null default '',
  price double precision not null default 0,
  billing_cycle smallint not null default 0,
  auto_renewal smallint not null default 0,
  currency text not null default '$',
  expired_at timestamptz,
  "group" text not null default '',
  tags text not null default '',
  hidden smallint not null default 0,
  -- 历史兼容字段；当前价格可见性由主题决定，不再据此改写公开响应。
  traffic_limit bigint not null default 0,
  -- 默认口径为「总计」（上行+下行），与后台新建节点的默认值一致。
  traffic_limit_type text not null default 'sum',
  -- 每月流量重置日（1~31）。探针按它切分统计周期，改这个值会清零当期累计。
  traffic_reset_day smallint not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clients_sort_order on clients(sort_order, name);

create table if not exists records (
  client text not null,
  time timestamptz not null,
  cpu double precision not null default 0,
  gpu double precision not null default 0,
  ram bigint not null default 0,
  ram_total bigint not null default 0,
  swap bigint not null default 0,
  swap_total bigint not null default 0,
  -- load 允许 null：容器内 /proc/loadavg 透传宿主机时探针显式上报「不可用」，
  -- 用 null 而不是 0（0 会被读成空闲，比错值更误导）。
  load double precision,
  load5 double precision,
  load15 double precision,
  temp double precision,
  disk bigint,
  disk_total bigint,
  net_in bigint not null default 0,
  net_out bigint not null default 0,
  net_total_up bigint not null default 0,
  net_total_down bigint not null default 0,
  process_count integer not null default 0,
  connections integer not null default 0,
  connections_udp integer not null default 0,
  uptime bigint,
  primary key (client, time)
) partition by range (time);

-- Preserve unknown measurements on upgrades as well as fresh installs.
alter table public.records alter column disk drop not null, alter column disk drop default;
alter table public.records alter column disk_total drop not null, alter column disk_total drop default;
alter table public.records alter column uptime drop not null, alter column uptime drop default;

create table if not exists users (
  uuid text primary key,
  username text not null unique,
  passwd text not null,
  session_version integer not null default 1,
  password_changed_at timestamptz,
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  totp_last_used_step bigint not null default -1,
  recovery_code_hashes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists login_rate_limits (
  bucket text primary key,
  failures integer not null default 0,
  first_failed_at timestamptz not null,
  last_failed_at timestamptz not null,
  locked_until timestamptz,
  -- Each observed authentication state has an identity, including after delete/recreate.
  failure_revision uuid not null default gen_random_uuid()
);

create index if not exists idx_login_rate_limits_last_failed on login_rate_limits(last_failed_at);

create table if not exists settings (
  key text primary key,
  value text not null default ''
);

create table if not exists themes (
  short text primary key,
  name text not null,
  description text not null default '',
  version text not null default '',
  author text not null default '',
  url text not null default '',
  preview_path text not null default '',
  style_path text not null,
  manifest_json text not null,
  config_json text not null default '{}',
  custom_css text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint themes_short_check check (short ~ '^[A-Za-z0-9_-]+$' and short <> 'default')
);

create table if not exists theme_assets (
  theme_short text not null,
  path text not null,
  content_type text not null,
  content_base64 text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  constraint theme_assets_theme_short_fkey foreign key (theme_short) references themes(short) on delete cascade,
  primary key (theme_short, path)
);

create table if not exists ping_tasks (
  id bigint generated by default as identity primary key,
  name text not null,
  clients jsonb not null default '[]'::jsonb,
  all_clients smallint not null default 0,
  type text not null default 'icmp',
  target text not null,
  interval_sec integer not null default 60,
  sort_order integer not null default 0
);

-- 每个 Ping 任务的默认探测硬期限（毫秒）。超过即按丢包记录，与 Zeno-Agent 的
-- timeout_ms 语义一致。老任务升级后使用 3000ms，保留原先 TCP 3s 的最大等待体验。
alter table public.ping_tasks
  add column if not exists timeout_ms integer not null default 3000
  constraint ping_tasks_timeout_ms_check check (timeout_ms between 100 and 5000);

-- 节点级覆盖：同一任务在不同服务器上可以有不同的超时。
-- 没有记录时回退到 ping_tasks.timeout_ms。全局任务（all_clients）同样可以覆盖。
create table if not exists ping_task_client_timeouts (
  task_id bigint not null references public.ping_tasks(id) on delete cascade,
  client text not null references public.clients(uuid) on delete cascade,
  timeout_ms integer not null check (timeout_ms between 100 and 5000),
  primary key (task_id, client)
);

create index if not exists idx_ping_tasks_sort_order on ping_tasks(sort_order, id);

create table if not exists ping_snapshots (
  client text not null,
  time timestamptz not null,
  values_json jsonb not null default '{}'::jsonb,
  primary key (client, time)
) partition by range (time);

-- Existing installs kept the old '[]' default; writes have always been objects.
alter table public.ping_snapshots alter column values_json set default '{}'::jsonb;

create table if not exists offline_notifications (
  client text primary key references clients(uuid) on delete cascade,
  enable smallint not null default 0,
  grace_period integer not null default 360,
  last_notified timestamptz,
  -- 本次离线起点；恢复上线后清空。用于计算「离线 N 分钟后恢复」。
  offline_since timestamptz,
  -- 本月累计离线所属月份（北京时间 YYYY-MM）与已完成离线毫秒数。
  month_key text,
  month_offline_ms bigint not null default 0
);

-- 存量库补列。必须排在 2_functions.sql 引用这些列之前。
alter table public.offline_notifications add column if not exists offline_since timestamptz;
alter table public.offline_notifications add column if not exists month_key text;
alter table public.offline_notifications add column if not exists month_offline_ms bigint not null default 0;

create table if not exists expiry_notifications (
  client text primary key references clients(uuid) on delete cascade,
  enable smallint not null default 0,
  advance_days integer not null default 7,
  last_notified timestamptz
);

create table if not exists load_notifications (
  id bigint generated by default as identity primary key,
  name text not null default '',
  clients jsonb not null default '[]'::jsonb,
  metric text not null default 'cpu',
  threshold double precision not null default 80,
  ratio double precision not null default 0.8,
  interval_min integer not null default 15,
  last_notified timestamptz
);

create table if not exists audit_logs (
  id bigint generated by default as identity primary key,
  time timestamptz not null default now(),
  "user" text not null default '',
  action text not null default '',
  detail text not null default '',
  level text not null default 'info'
);

create index if not exists idx_audit_logs_time on audit_logs(time);

-- The per-family Ping rollup retention is replaced by one shared key. Copy the
-- stored value before the seed below can install the new default, otherwise an
-- operator-chosen Ping retention would be overwritten by 2160 on upgrade.
insert into settings(key, value)
select 'rollup_preserve_time', value
from settings
where key = 'ping_rollup_preserve_time'
on conflict (key) do nothing;

-- Retired capacity estimator input; the runtime uses allocated partition bytes.
delete from settings where key = 'capacity_daily_view_minutes';

insert into settings (key, value) values
  ('site_title', 'CF VPS Monitor'),
  ('site_description', '服务器监控探针'),
  ('language', 'zh-CN'),
  ('record_enabled', 'true'),
  ('record_preserve_time', '168'),
  ('ping_record_preserve_time', '168'),
  ('rollup_preserve_time', '2160'),
  ('record_persist_interval_sec', '120'),
  ('ping_record_persist_interval_sec', '120'),
  ('record_high_watermark_bytes', '419430400'),
  ('audit_log_preserve_time', '2160'),
  ('live_poll_active_interval_sec', '3'),
  ('live_poll_idle_interval_sec', '120'),
  ('live_poll_active_max_duration_sec', '120'),
  ('notification_method', 'telegram'),
  ('telegram_bot_token', ''),
  ('telegram_chat_id', ''),
  ('enable_ip_change_notification', 'false'),
  ('active_theme', 'monitor')
on conflict (key) do nothing;

-- v2 settings migration. Historic defaults were 30 days for host raw; the v2
-- contract is 7 days raw plus 90 days rollup. Only the exact old default is
-- rewritten, and only once, so an operator-chosen 720 survives a replay.
do $$
begin
  if not exists (select 1 from settings where key = 'history_storage_v2_migrated') then
    update settings set value = '168' where key = 'record_preserve_time' and value = '720';
    -- I1: no raw family may retain less than 48 hours. The read clamp already
    -- enforces this; raise any legacy stored value once so the admin UI agrees.
    update settings set value = '48'
    where key in ('record_preserve_time', 'ping_record_preserve_time')
      and value ~ '^[0-9]{1,7}$'
      and value::integer < 48;
    insert into settings(key, value) values ('history_storage_v2_migrated', 'true');
  end if;
end $$;

-- Legacy 3 fixed the historic 30-day Ping raw default unconditionally. Keep
-- that fix outside the one-time guard: an install that already recorded
-- history_storage_v2_migrated still needs the stored 720 corrected.
update settings set value = '168' where key = 'ping_record_preserve_time' and value = '720';

alter table public.clients enable row level security;

alter table public.records enable row level security;

alter table public.users enable row level security;

alter table public.login_rate_limits enable row level security;

alter table public.settings enable row level security;

alter table public.ping_tasks enable row level security;

alter table public.ping_task_client_timeouts enable row level security;

alter table public.ping_snapshots enable row level security;

alter table public.offline_notifications enable row level security;

alter table public.expiry_notifications enable row level security;

alter table public.load_notifications enable row level security;

alter table public.audit_logs enable row level security;

do $$
declare
  role_name text;
  table_name text;
  sequence_oid oid;
  app_tables constant text[] := array[
    'clients', 'records', 'users',
    'login_rate_limits', 'settings', 'themes', 'theme_assets', 'ping_tasks',
    'ping_task_client_timeouts', 'ping_snapshots',
    'offline_notifications', 'expiry_notifications', 'load_notifications', 'audit_logs'
  ];
begin
  -- public is shared with other applications. Revoke only this application's
  -- objects; schema access and owner defaults belong to the project owner.
  foreach role_name in array array['public', 'anon', 'authenticated'] loop
    if role_name = 'public' or to_regrole(role_name) is not null then
      foreach table_name in array app_tables loop
        execute format('revoke all on table public.%I from %s', table_name, role_name);
      end loop;
      for sequence_oid in
        select distinct sequence.oid
        from pg_class sequence
        join pg_depend dependency on dependency.objid = sequence.oid
          and dependency.classid = 'pg_class'::regclass
          and dependency.deptype in ('a', 'i')
        join pg_class owner_table on owner_table.oid = dependency.refobjid
        join pg_namespace namespace on namespace.oid = owner_table.relnamespace
        where sequence.relkind = 'S' and namespace.nspname = 'public'
          and owner_table.relname = any(app_tables)
      loop
        execute format('revoke all on sequence %s from %s', sequence_oid::regclass, role_name);
      end loop;
    end if;
  end loop;
end $$;

comment on table clients is 'CF Monitor internal table. Public access must go through the Worker API.';

comment on table users is 'CF Monitor admin users. Do not expose through Supabase Data API.';

comment on table settings is 'CF Monitor settings and internal health keys. Do not expose through Supabase Data API.';

do $$
begin
  if to_regrole('cf_monitor_app') is null then
    begin
      create role cf_monitor_app nologin;
    exception
      -- Two databases in the same cluster can run this migration at once.
      when duplicate_object then null;
    end;
  end if;
end $$;

do $$
begin
  begin
    alter role cf_monitor_app nologin nosuperuser nobypassrls nocreaterole;
  exception
    when insufficient_privilege then
      null;
    when sqlstate 'XX000' then
      -- Concurrent CREATE/ALTER ROLE in another database of the same cluster.
      -- The other session applies the same attributes, so retrying is unsafe
      -- but ignoring this specific race is not.
      if sqlerrm not like '%tuple concurrently updated%' then
        raise;
      end if;
  end;
end $$;

grant usage on schema public to cf_monitor_app;

do $$
declare
  table_name text;
  sequence_oid oid;
  sequence_table_name text;
  app_tables constant text[] := array[
    'clients', 'records', 'users',
    'login_rate_limits', 'settings', 'themes', 'theme_assets', 'ping_tasks',
    'ping_task_client_timeouts', 'ping_snapshots',
    'offline_notifications', 'expiry_notifications', 'load_notifications', 'audit_logs'
  ];
begin
  foreach table_name in array app_tables loop
    execute format('grant select, insert, update, delete on table public.%I to cf_monitor_app, service_role', table_name);
  end loop;
  for sequence_oid, sequence_table_name in
    select distinct sequence.oid, owner_table.relname
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid
      and dependency.classid = 'pg_class'::regclass
      and dependency.deptype in ('a', 'i')
    join pg_class owner_table on owner_table.oid = dependency.refobjid
    join pg_namespace namespace on namespace.oid = owner_table.relnamespace
    where sequence.relkind = 'S' and namespace.nspname = 'public'
      and owner_table.relname = any(app_tables)
  loop
    execute format('grant usage on sequence %s to cf_monitor_app, service_role', sequence_oid::regclass);
    if sequence_table_name = any(array[ 'ping_tasks', 'load_notifications']) then
      -- Restore reserves explicit IDs with setval, which requires UPDATE rather
      -- than USAGE. Do not depend on the project owner's default sequence ACLs.
      execute format('grant update on sequence %s to service_role', sequence_oid::regclass);
    end if;
  end loop;
end $$;

alter table public.clients force row level security;

alter table public.records force row level security;

alter table public.users force row level security;

alter table public.login_rate_limits force row level security;

alter table public.settings force row level security;

alter table public.ping_tasks force row level security;

alter table public.ping_task_client_timeouts force row level security;

alter table public.ping_snapshots force row level security;

alter table public.offline_notifications force row level security;

alter table public.expiry_notifications force row level security;

alter table public.load_notifications force row level security;

alter table public.audit_logs force row level security;

do $$
begin
  if to_regrole('cf_monitor_worker') is null then
    begin
      create role cf_monitor_worker
        login
        inherit
        nosuperuser
        nocreatedb
        nocreaterole
        nobypassrls;
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

do $$
begin
  begin
    alter role cf_monitor_worker
      login
      inherit
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls;
  exception
    when insufficient_privilege then
      null;
    when sqlstate 'XX000' then
      if sqlerrm not like '%tuple concurrently updated%' then
        raise;
      end if;
  end;
end $$;

do $$
begin
  begin
    grant cf_monitor_app to cf_monitor_worker;
  exception
    -- Role membership lives in the shared catalog, so two databases can race.
    when duplicate_object or unique_violation then null;
    when sqlstate 'XX000' then
      if sqlerrm not like '%tuple concurrently updated%' then
        raise;
      end if;
  end;
end $$;

insert into settings (key, value)
values ('active_theme', 'monitor')
on conflict (key) do nothing;

alter table public.themes enable row level security;

alter table public.theme_assets enable row level security;

alter table public.themes force row level security;

alter table public.theme_assets force row level security;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_recovery_code_hashes_array' and conrelid = 'public.users'::regclass) then
    alter table users add constraint users_recovery_code_hashes_array
      check (
        jsonb_typeof(recovery_code_hashes) = 'array'
        and jsonb_array_length(recovery_code_hashes) <= 8
      );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_totp_state_consistent' and conrelid = 'public.users'::regclass) then
    alter table users add constraint users_totp_state_consistent
      check (
        (totp_enabled_at is null and totp_secret_enc is null and recovery_code_hashes = '[]'::jsonb)
        or (totp_enabled_at is not null and nullif(totp_secret_enc, '') is not null)
      );
  end if;
end $$;

-- ⚠️ 所有表 / 列的 DDL 都在本文件，函数在 2_functions.sql，执行顺序保证列先于引用它的函数存在。
-- language sql 的函数体在 CREATE 时就做完整语义校验，列不存在会当场报 42703；
-- 因此新增列的 DDL 只能加在本文件，不能放进 2_functions.sql。
-- 每月流量重置日：节点级配置，经 agent policy 下发。被 cfm_admin_clients 与
-- cfm_create_client（均为 language sql）引用，故必须留在这里，不能放进下方 DDL 块。
alter table clients add column if not exists traffic_reset_day smallint not null default 1 constraint clients_traffic_reset_day_check check (traffic_reset_day between 1 and 31);

-- 对游客隐藏价格。被 cfm_public_clients / cfm_admin_clients / cfm_update_client_returning（language sql）引用，同样必须留在这里。
-- Retired node setting. SQL-string RPC bodies are replaced by 2_functions.sql;
-- no CASCADE, so unrelated dependent objects cannot be removed implicitly.
alter table clients drop column if exists hide_price;

-- Delivery state contains identities/timestamps only, never notification bodies
-- or channel credentials. One row per event source/target bounds active state.
create schema if not exists cfm_internal;

create table if not exists cfm_internal.notification_delivery_state (
  key text primary key check (char_length(key) between 1 and 512),
  event_id text not null check (char_length(event_id) between 1 and 512),
  status text not null check (status in ('pending', 'failed', 'sent')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null,
  claim_token text,
  delivered_at timestamptz,
  updated_at timestamptz not null
);

alter table cfm_internal.notification_delivery_state add column if not exists retired_at timestamptz;

alter table cfm_internal.notification_delivery_state enable row level security;

alter table cfm_internal.notification_delivery_state force row level security;

grant usage on schema cfm_internal to service_role;

create index if not exists idx_notification_delivery_retired
  on cfm_internal.notification_delivery_state(next_attempt_at, key) where retired_at is not null;

insert into settings (key, value) values
  ('webhook_url', ''),
  ('webhook_format', 'generic'),
  ('webhook_secret', ''),
  ('webhook_method', 'POST'),
  ('webhook_content_type', 'application/json'),
  ('webhook_headers_json', ''),
  ('webhook_body_template', '{"message":"{{message}}","title":"{{title}}"}'),
  ('webhook_username', ''),
  ('webhook_password', ''),
  ('webhook_retry_count', '1')
on conflict (key) do nothing;

-- v2 rollups: weekly RANGE partitions, no foreign keys. Deletion is explicit
-- (cfm_delete_clients / orphan sweep), never a cascade.
-- host_rollup keeps mergeable sufficient statistics (count, sum, min, max);
-- averages are derived at read time so larger steps merge exactly.
create table if not exists public.host_rollup (
  client text not null,
  bucket_start timestamptz not null,
  sample_count integer not null,
  sum_cpu double precision not null default 0,
  min_cpu double precision,
  max_cpu double precision,
  sum_ram numeric not null default 0,
  min_ram bigint,
  max_ram bigint,
  sum_disk numeric not null default 0,
  min_disk bigint,
  max_disk bigint,
  sum_swap numeric not null default 0,
  min_swap bigint,
  max_swap bigint,
  sum_net_in numeric not null default 0,
  min_net_in bigint,
  max_net_in bigint,
  sum_net_out numeric not null default 0,
  min_net_out bigint,
  max_net_out bigint,
  sum_connections numeric not null default 0,
  min_connections integer,
  max_connections integer,
  sum_connections_udp numeric not null default 0,
  min_connections_udp integer,
  max_connections_udp integer,
  sum_process_count numeric not null default 0,
  min_process_count integer,
  max_process_count integer,
  first_time timestamptz not null,
  last_time timestamptz not null,
  primary key (client, bucket_start)
) partition by range (bucket_start);

-- Last accepted sample retains fields not represented by mergeable sums.
-- NULL disk_samples marks legacy rollups whose original availability is unknown.
alter table public.host_rollup add column if not exists last_record jsonb;
alter table public.host_rollup add column if not exists disk_samples integer;

create table if not exists public.ping_rollup (
  client text not null,
  task_id integer not null,
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

alter table public.host_rollup enable row level security;
alter table public.host_rollup force row level security;
alter table public.ping_rollup enable row level security;
alter table public.ping_rollup force row level security;

grant truncate on table
  public.records, public.ping_snapshots,
  public.host_rollup, public.ping_rollup
to service_role;

-- Bootstrap the weekly rollup runway at install time. Later runs are managed
-- by cfm_partition_maintain. Monday-aligned, UTC.
do $$
declare
  d date;
  stop date := (date_trunc('week', now() at time zone 'UTC') + interval '14 days')::date;
  t text;
begin
  foreach t in array array['host_rollup', 'ping_rollup'] loop
    -- Truncate after subtracting the lookback so every cursor lands on a
    -- Monday, exactly like cfm_partition_maintain's weekly frontier.
    d := (date_trunc('week', (now() at time zone 'UTC') - interval '90 days'))::date;
    while d < stop loop
      execute format(
        'create table if not exists public.%I partition of public.%I for values from (%L) to (%L)',
        t || '_' || to_char(d, 'YYYYMMDD'), t,
        d::text || ' 00:00:00+00',
        (d + 7)::text || ' 00:00:00+00'
      );
      d := d + 7;
    end loop;
  end loop;
end $$;

-- Partition lifecycle policy. Parent tables are tracked with regclass so a
-- rename/restore resolves through the catalog instead of string matching.
create table if not exists cfm_internal.partition_policy (
  parent regclass primary key,
  grain text not null check (grain in ('day', 'week')),
  runway_days integer not null default 2 check (runway_days >= 0),
  retention_key text not null,
  gate_family text,
  gate_lag interval not null default interval '2 hours'
);

create table if not exists cfm_internal.partition_bounds (
  parent regclass primary key,
  min_start timestamptz,
  max_end timestamptz,
  updated_at timestamptz not null
);

-- rollup_state.watermark is the end of the newest bucket that has been
-- processed at least once. It only moves forward.
create table if not exists cfm_internal.rollup_state (
  family text primary key check (family in ('host', 'ping')),
  watermark timestamptz not null,
  updated_at timestamptz not null default now()
);

-- A late raw sample landing inside an already-rolled-up bucket queues that
-- bucket for a full re-aggregation. task_id is 0 for the host family.
create table if not exists cfm_internal.rollup_dirty (
  family text not null check (family in ('host', 'ping')),
  client text not null,
  task_id integer not null default 0,
  bucket_start timestamptz not null,
  queued_at timestamptz not null default now(),
  primary key (family, client, task_id, bucket_start)
);

-- Last partition-maintenance outcome for the private health/status RPC.
create table if not exists cfm_internal.partition_maintenance_state (
  singleton boolean primary key default true check (singleton),
  updated_at timestamptz not null,
  pending_partitions integer not null default 0 check (pending_partitions >= 0),
  lock_timeouts integer not null default 0 check (lock_timeouts >= 0)
);

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

-- 权限由文件末尾的统一授权块处理；历史上这里漏 grant 导致 PostgREST 42501。

-- 公网 IP 变更通知的服务器层级开关。全局开关是 settings.enable_ip_change_notification
-- （总闸），这里按节点选择要监控的服务器；两处都开启才会发送，缺一不可。
-- 触发依据是 Agent 上报的公网出口 IP（clients.ipv4 / ipv6，即节点页面显示的值，
-- 由 Agent 通过 api.ipify.org 等公网探测接口获得），不是连接 Worker 的源 IP。
-- 建表位置在角色创建之后（与 client_home_ping / 汇总表同一批补丁式写法），
-- 权限模型同上：force RLS + 统一 policy，Worker 经 RPC 读写。
create table if not exists public.ip_change_notifications (
  client text primary key references public.clients(uuid) on delete cascade,
  enable smallint not null default 0
);

alter table public.ip_change_notifications enable row level security;

alter table public.ip_change_notifications force row level security;

-- CPU 负载三元组：records.load（Load1）之外新增 load5/load15。
--
-- 背景：探针原来只报 Load1（agent main.go 经 loadAverageReportable() 可信度门控，
-- 不可信则序列化成 null，老探针缺字段服务端按 0）。1/5/15 分钟三条线要全链路贯通，
-- 落库与读侧必须先有列。
--
-- 幂等：add column if not exists；函数 create or replace；grant 可重复执行。
-- 本文件内建列 DDL 必须排在引用它的函数之前（见
-- worker/test/utils/migration-column-order.test.mjs，存量库 language sql 函数在
-- CREATE 时就做语义校验，列不存在直接 42703 中止整批迁移）。
alter table public.records
  add column if not exists load5 double precision,
  add column if not exists load15 double precision;

comment on column public.records.load5 is 'CPU 1/5/15 分钟负载中的 5 分钟值；null = 探针报告本机负载不可取信，不是 0。';

comment on column public.records.load15 is 'CPU 1/5/15 分钟负载中的 15 分钟值；null = 探针报告本机负载不可取信，不是 0。';

-- 流量统计（vnstat 式按天累计）。
--
-- Agent 只上报各网卡的内核累计计数器，不保存任何本地状态；换算增量、分日、按重置日聚合都在这里：
--   traffic_counter_state  每个节点上一次的网卡读数（用来换算下一次的增量）
--   traffic_daily          每个节点每个「Agent 本地自然日」的上 / 下行增量
-- 月度流量 = traffic_daily 在 [重置日, 今天] 的和。重置日只是求和区间，修改它不会改写任何历史。
-- 写入走 cfm_traffic_apply_samples（同一事务内换算增量、累加当日、更新读数）；
-- 与 records 一样属于运行数据，随节点删除级联清理。
create table if not exists public.traffic_daily (
  client text not null references public.clients(uuid) on delete cascade,
  day date not null,
  up bigint not null default 0 check (up >= 0),
  down bigint not null default 0 check (down >= 0),
  updated_at timestamptz not null default now(),
  primary key (client, day)
);

create table if not exists public.traffic_counter_state (
  client text primary key references public.clients(uuid) on delete cascade,
  -- 统计口径：与新样本不一致时丢弃旧读数、重新起基线
  scope text not null,
  -- 上次读到的开机时间（Unix 秒），0 表示未知
  boot bigint not null default 0,
  -- {"eth0": {"up": n, "down": n}, ...}
  interfaces jsonb not null default '{}'::jsonb,
  -- 上次处理的样本时间（毫秒）。0 表示还没有基线；样本时间不大于它的一律忽略（重发 / 乱序幂等）
  last_ts bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.traffic_daily enable row level security;

alter table public.traffic_daily force row level security;

alter table public.traffic_counter_state enable row level security;

alter table public.traffic_counter_state force row level security;

-- 表级权限统一收敛：public 业务表给 cf_monitor_app / service_role，
-- cfm_internal 只给 service_role。新增表时把表名加进对应清单。
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'host_rollup', 'ping_rollup', 'client_home_ping',
    'ip_change_notifications', 'traffic_daily', 'traffic_counter_state'
  ] loop
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to cf_monitor_app, service_role', table_name);
  end loop;

  foreach table_name in array array[
    'notification_delivery_state', 'partition_policy', 'partition_bounds',
    'rollup_state', 'rollup_dirty', 'partition_maintenance_state'
  ] loop
    execute format('revoke all on table cfm_internal.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on cfm_internal.%I to service_role', table_name);
  end loop;
end $$;

-- 所有业务表统一的 RLS policy：只在缺失时创建，可重复执行。
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'clients', 'records', 'users',
    'login_rate_limits', 'settings', 'themes', 'theme_assets', 'ping_tasks',
    'ping_task_client_timeouts', 'ping_snapshots',
    'offline_notifications', 'expiry_notifications', 'load_notifications', 'audit_logs',
    'client_home_ping', 'host_rollup', 'ping_rollup',
    'traffic_daily', 'traffic_counter_state',
    'ip_change_notifications'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = table_name and policyname = 'cf_monitor_app_all'
    ) then
      execute format(
        'create policy cf_monitor_app_all on public.%I for all to cf_monitor_app using (true) with check (true)',
        table_name
      );
    end if;
  end loop;
end $$;

insert into settings (key, value) values ('schema_bootstrap_version', 'postgres-2026-07-squashed')
  on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';
