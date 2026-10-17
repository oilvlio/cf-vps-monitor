-- 修复迁移 7 / 9 遗漏的 app 角色权限。
-- 项目安全模型（见 2_security_access.sql）：业务表统一 grant 给 cf_monitor_app /
-- service_role，并建 cf_monitor_app_all policy；RPC 以 invoker 身份运行。
-- client_home_ping 与三张 rollup 表建表时只做了 revoke + force RLS，没有补这
-- 两项，导致 Worker 经 PostgREST 调用时报 42501 permission denied，
-- PostgREST 回 403，Worker 侧表现为 500（cfm_home_ping_assignments、
-- cfm_home_ping_rows、cfm_build_history_rollup 均受影响）。
-- 幂等：grant / drop policy if exists 可重复执行。

grant select, insert, update, delete on table public.client_home_ping to cf_monitor_app, service_role;
grant select, insert, update, delete on table public.records_rollup to cf_monitor_app, service_role;
grant select, insert, update, delete on table public.gpu_rollup to cf_monitor_app, service_role;
grant select, insert, update, delete on table public.ping_rollup to cf_monitor_app, service_role;

drop policy if exists cf_monitor_app_all on public.client_home_ping;
drop policy if exists cf_monitor_app_all on public.records_rollup;
drop policy if exists cf_monitor_app_all on public.gpu_rollup;
drop policy if exists cf_monitor_app_all on public.ping_rollup;

create policy cf_monitor_app_all on public.client_home_ping for all to cf_monitor_app using (true) with check (true);
create policy cf_monitor_app_all on public.records_rollup for all to cf_monitor_app using (true) with check (true);
create policy cf_monitor_app_all on public.gpu_rollup for all to cf_monitor_app using (true) with check (true);
create policy cf_monitor_app_all on public.ping_rollup for all to cf_monitor_app using (true) with check (true);

-- 函数执行授权与老函数对齐的基础上补 app 角色，保证 Worker 身份可执行。
grant execute on function public.cfm_home_ping_assignments() to cf_monitor_app;
grant execute on function public.cfm_set_home_ping_task(text, bigint) to cf_monitor_app;
grant execute on function public.cfm_home_ping_rows(text, text, integer) to cf_monitor_app;
grant execute on function public.cfm_build_history_rollup(text) to cf_monitor_app;
grant execute on function public.cfm_records_rollup_range(text, text, text) to cf_monitor_app;
grant execute on function public.cfm_ping_rollup_range(text, bigint, text, text) to cf_monitor_app;
grant execute on function public.cfm_gpu_rollup_range(text, text, text) to cf_monitor_app;

notify pgrst, 'reload schema';
