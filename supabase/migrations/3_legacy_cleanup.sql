-- 已下线功能的遗留对象清理。
-- 全新库里这些对象根本不存在，下面全是 no-op；已部署的旧库会在这里被清掉。
-- 当所有部署都升级过之后，可以整个删除本文件。
set local search_path = public;

-- 网站监控：功能已移除，worker / 前端 / agent 均无引用。
-- README 承诺过「原有网站监控数据会保留」，所以这里不销毁用户数据：
--   · 两个触发器无条件摘掉（它们依赖的函数下面要删；留着没有任何作用）；
--   · 表只有在完全为空时才删除，里面还有数据的库原样保留这两张表。
do $$
begin
  if to_regclass('public.website_monitors') is not null then
    drop trigger if exists cfm_website_config_revision on public.website_monitors;
    drop trigger if exists cfm_website_delivery_retirement on public.website_monitors;
  end if;
  -- 对表的引用必须放在嵌套的 if 里：PL/pgSQL 按整条表达式规划，表不存在时短路求值也救不了。
  if to_regclass('public.website_checks') is not null and to_regclass('public.website_monitors') is not null then
    if not exists (select 1 from public.website_checks) and not exists (select 1 from public.website_monitors) then
      drop table public.website_checks;
      drop table public.website_monitors;
    end if;
  end if;
end;
$$;

-- 仅为网站监控的一次性数据迁移服务的内部辅助表，不含用户数据。
drop table if exists cfm_internal.data_migrations;

-- 早期 rollup 方案遗留：这两张表没有写入方，历史查询走查询时分桶（gpu_rollup 仍在使用，保留）。
-- 同样只在为空时删除，避免误删任何曾经写入过的数据。
do $$
begin
  if to_regclass('public.records_rollup') is not null then
    if not exists (select 1 from public.records_rollup) then
      drop table public.records_rollup;
    end if;
  end if;
  if to_regclass('public.ping_rollup') is not null then
    if not exists (select 1 from public.ping_rollup) then
      drop table public.ping_rollup;
    end if;
  end if;
end;
$$;

-- 通知投递账本里属于网站监控的条目（只是去重用的派生状态）。
delete from cfm_internal.notification_delivery_state where key like 'website:%';

-- 不再被 worker 调用的函数（网站监控、已移除的 TS 封装对应的 RPC、从未被调度的 cfm_compact_history）。

drop function if exists cfm_internal.rotate_website_config_revision();
drop function if exists public.cfm_agent_website_probe_tasks(text, text, integer);
drop function if exists public.cfm_clear_login_rate_limits(jsonb);
drop function if exists public.cfm_client_exists(text);
drop function if exists public.cfm_client_visibility(text);
drop function if exists public.cfm_compact_history(text);
drop function if exists public.cfm_create_user(text, text, text);
drop function if exists public.cfm_create_website_monitor(jsonb);
drop function if exists public.cfm_delete_old_website_checks(text, integer);
drop function if exists public.cfm_delete_user_if_matches(text, text, text);
drop function if exists public.cfm_delete_website_monitor(integer);
drop function if exists public.cfm_due_website_monitors(text, integer);
drop function if exists public.cfm_ensure_initial_admin(text, text, text);
drop function if exists public.cfm_expiry_notification(text);
drop function if exists public.cfm_history_storage_counts();
drop function if exists public.cfm_latest_record_times();
drop function if exists public.cfm_latest_records();
drop function if exists public.cfm_login_rate_limit(text);
drop function if exists public.cfm_mark_website_monitor_notified(integer, text, jsonb);
drop function if exists public.cfm_offline_notification(text);
drop function if exists public.cfm_ping_rollup_range(text, bigint, text, text);
drop function if exists public.cfm_ping_task(integer);
drop function if exists public.cfm_public_website_monitor(integer, integer, boolean);
drop function if exists public.cfm_public_websites(integer, integer, boolean);
drop function if exists public.cfm_record_website_check(jsonb);
drop function if exists public.cfm_records_range(text, text, text);
drop function if exists public.cfm_records_rollup_range(text, text, text);
drop function if exists public.cfm_reorder_website_monitors(jsonb);
drop function if exists public.cfm_set_login_rate_limit(jsonb);
drop function if exists public.cfm_set_login_rate_limits(jsonb);
drop function if exists public.cfm_set_website_monitor_enabled(integer, boolean);
drop function if exists public.cfm_set_website_monitor_visibility(integer, boolean);
drop function if exists public.cfm_storage_row_counts();
drop function if exists public.cfm_update_user_username(text, text);
drop function if exists public.cfm_update_website_monitor(integer, jsonb);
drop function if exists public.cfm_website_checks(integer, integer);
drop function if exists public.cfm_website_monitor(integer);
drop function if exists public.cfm_website_monitors();

-- 旧的 11 个迁移合并之后，清掉它们在 setup_migrations 里的登记，避免留下对不上号的历史记录。
-- setup_migrations 由 worker 的 /db-init 创建，单独跑 SQL（如测试库）时可能不存在。
do $$
begin
  if to_regclass('cfm_internal.setup_migrations') is not null then
    delete from cfm_internal.setup_migrations
    where version in ('1_core_schema', '2_security_access', '3_feature_schema', '4_rpc_api', '5_runtime_defaults', '6_history_rollup', '7_history_rollup_tables', '8_history_auto_downsample', '9_home_ping_task', '9_home_ping_task_grants', '9_loadavg_triple');
  end if;
end;
$$;

notify pgrst, 'reload schema';
