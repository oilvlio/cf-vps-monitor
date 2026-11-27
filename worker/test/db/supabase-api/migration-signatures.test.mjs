import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../../src/generated/supabase-migrations.ts';

const migrationsUrl = new URL('../../../../supabase/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort();
const expectedMigrations = ['1_schema', '2_functions'];
assert.deepEqual(migrationFiles, expectedMigrations.map((name) => `${name}.sql`));
assert.deepEqual(BUNDLED_SUPABASE_MIGRATIONS.map(({ version }) => version), expectedMigrations);

// 1_schema.sql：表 / 列 / 约束 / 默认数据（全新安装终态）；2_functions.sql：全部 RPC 与其权限。
const featureSchemaSql = await readFile(new URL('1_schema.sql', migrationsUrl), 'utf8');
const migrationSql = await readFile(new URL('2_functions.sql', migrationsUrl), 'utf8');
const runtimeDefaultsSql = featureSchemaSql;
const generatedSql = await readFile(new URL('../../../src/generated/supabase-migrations.ts', import.meta.url), 'utf8');
const agentRoutesSql = await readFile(new URL('../../../src/routes/client.ts', import.meta.url), 'utf8');
const allMigrationSql = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, migrationsUrl), 'utf8'))).then((sources) => sources.join('\n'));

assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_delete_old_ping_records\(/i,
  'the row-level Ping cleanup RPC is retired; partitions expire through cfm_partition_maintain');
const maintenanceDefinitions = [...allMigrationSql.matchAll(/create or replace function public\.cfm_partition_maintain\([\s\S]*?\$[a-z_]*\$;/gi)];
assert.equal(maintenanceDefinitions.length, 1, 'cfm_partition_maintain is the single lifecycle entry point');
assert.match(maintenanceDefinitions[0][0], /drop table public\.%I/i,
  'expiry drops whole partitions instead of deleting rows');
assert.match(maintenanceDefinitions[0][0], /cfm_internal\.partition_children/i);
const pingReadDefinitions = [...allMigrationSql.matchAll(/create or replace function public\.cfm_ping_records\([\s\S]*?\$[a-z_]*\$;/gi)];
assert.ok(pingReadDefinitions.length > 0, 'legacy-named Ping read RPC should remain defined');
assert.match(pingReadDefinitions.at(-1)[0], /from ping_snapshots/i,
  'the legacy-named read RPC serves partitioned snapshots, not the obsolete ping_records heap');
assert.doesNotMatch(allMigrationSql, /insert\s+into\s+(public\.)?ping_records/i,
  'no application migration writes new data to the obsolete ping_records heap');

const rollupBuildDefinitions = [...allMigrationSql.matchAll(/create or replace function (?:public\.)?cfm_internal\.rollup_range\([\s\S]*?\$[a-z_]*\$;/gi)];
assert.ok(rollupBuildDefinitions.length >= 1, 'rollup builder must stay defined in the terminal files');
assert.match(rollupBuildDefinitions.at(-1)[0], /for key share of t\s*,\s*c/i,
  'rollup builds must lock referenced Ping task and client keys so concurrent deletes cannot fail the FK check');
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_build_(?:ping|history)_rollup\(/i,
  'the per-family builders are gone; cfm_build_rollup is the only entry point');
const rawHostFallbacks = [...allMigrationSql.matchAll(/create or replace function public\.cfm_records_range_aggregated_raw\([\s\S]*?\$[a-z_]*\$;/gi)];
assert.equal(rawHostFallbacks.length, 1, 'the raw-only host aggregate fallback is a single terminal RPC');
assert.match(rawHostFallbacks[0][0], /from public\.records/i);
assert.doesNotMatch(rawHostFallbacks[0][0], /host_rollup/i);
const usageDefinitions = [...allMigrationSql.matchAll(/create or replace function public\.cfm_history_storage_bytes\(\)[\s\S]*?\$[a-z_]*\$;/gi)];
assert.equal(usageDefinitions.length, 1, 'capacity measurement is the single cfm_history_storage_bytes RPC');
assert.doesNotMatch(usageDefinitions[0][0], /pg_advisory_xact_lock/i,
  'capacity measurement must never serialize every caller behind one slow scan');
assert.match(usageDefinitions[0][0], /allocated_bytes/i,
  'v2 capacity is allocated partition-tree bytes, not a live-row estimate');
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_history_storage_usage\(/i,
  'the live-row usage estimate RPC is retired');
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_bounded_storage_row_counts\(/i,
  'row-count capacity callers are retired');
for (const helper of [
  'setting_hours(text, integer, integer, integer)',
  'retention_hours(text)',
  'read_raw_from(text, timestamp with time zone)',
]) {
  const escaped = helper.replace(/[()]/g, '\\$&');
  assert.match(migrationSql, new RegExp(`grant execute on function cfm_internal\\.${escaped} to cf_monitor_app, service_role;`, 'i'),
    `Worker and monitor roles must execute helper ${helper} used transitively by history RPCs`);
}
// 权限统一走 schema 遍历：public RPC 全部收回并授予 service_role，
// cfm_internal 全部收回（需要的调用方在下方显式授权）。
for (const source of [migrationSql, generatedSql]) {
  assert.match(source, /where n\.nspname = 'public' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated[\s\S]*?grant execute on function %s to service_role/i,
    'public RPCs must be revoked from anon/authenticated and granted to service_role in one loop');
  assert.match(source, /where n\.nspname = 'cfm_internal' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated/i,
    'cfm_internal helpers must be revoked from PUBLIC in one loop');
  assert.doesNotMatch(source, /grant execute on function public\.[^;]* to (?:anon|authenticated)/i,
    'no public RPC may be granted to anon or authenticated');
}

assert.doesNotMatch(allMigrationSql, /^\+/m);
assert.doesNotMatch(allMigrationSql, /set token\s*=\s*null/i);
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_set_client_install_token/i);
assert.doesNotMatch(allMigrationSql, /grant execute on function public\.cfm_set_client_install_token/i);
assert.doesNotMatch(agentRoutesSql, /rotateClientToken\(/);
assert.equal((allMigrationSql.match(/create or replace function public\.cfm_create_client\(/gi) || []).length, 1);
assert.equal((allMigrationSql.match(/create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token text, input_token_hash text\)/gi) || []).length, 1);
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token_hash text\)/i);
for (const [name, definition] of [
  ['cfm_insert_monitor_record', /create or replace function public\.cfm_insert_monitor_record\([\s\S]*?\$[a-z_]*\$;/i],
  ['cfm_insert_ping_snapshot', /create or replace function public\.cfm_insert_ping_snapshot\([\s\S]*?\$[a-z_]*\$;/i],
]) {
  const match = allMigrationSql.match(definition);
  assert.ok(match, `${name} remains defined in the terminal migration`);
  assert.match(match[0], /security definer/i, `${name} must own the internal partition-boundary guard check`);
  assert.match(match[0], /set search_path to 'pg_catalog', 'public', 'pg_temp'/i,
    `${name} must pin a safe search_path when running as SECURITY DEFINER`);
}
// 建节点必须同时落库明文 token 与 token_hash——漏掉哪一个都会让新节点的
// 安装 Token 读不回来（2026-07-12 的既有故障）。
// 这里只锁「token/token_hash 进了 insert 列并被赋值」，不锁整张列清单：
// 列清单会随功能增长（如 traffic_reset_day），锁死会让每次加字段都误报。
assert.match(migrationSql, /insert into clients \([\s\S]*?\btoken\b[\s\S]*?\btoken_hash\b[\s\S]*?\)[\s\S]*?input_client->>'token',[\s\S]*?input_client->>'token_hash'/i);
assert.match(migrationSql, /create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token text, input_token_hash text\)[\s\S]*?set token = input_token,[\s\S]*?token_hash = input_token_hash/i);
assert.doesNotMatch(featureSchemaSql, /create or replace function public\.cfm_(?:create_client|rotate_client_token)\(/i);
assert.doesNotMatch(runtimeDefaultsSql, /create or replace function public\.cfm_(?:create_client|rotate_client_token)\(/i);

// 网站监控已下线：迁移文件里不得再出现任何 website 对象（独立为库的遗留表不归迁移管）。
assert.doesNotMatch(migrationSql, /website/i);
assert.doesNotMatch(featureSchemaSql, /website/i);

const mfaSources = [featureSchemaSql + migrationSql, generatedSql];
const mfaFunctions = [
  'cfm_enable_user_totp',
  'cfm_disable_user_totp',
  'cfm_replace_user_recovery_codes',
  'cfm_consume_totp_step',
  'cfm_consume_recovery_code',
];

for (const source of mfaSources) {
  assert.match(source, /totp_secret_enc\s+text/i);
  assert.match(source, /totp_enabled_at\s+timestamptz/i);
  assert.match(source, /totp_last_used_step\s+bigint\s+not null\s+default\s+-1/i);
  assert.match(source, /recovery_code_hashes\s+jsonb\s+not null\s+default\s+'\[\]'::jsonb/i);

  for (const functionName of mfaFunctions) {
    assert.match(source, new RegExp(`create or replace function public\\.${functionName}\\(`, 'i'));
    // 执行权限由 public schema 的遍历统一收回/授予，见上面的循环断言。
    assert.match(source, /where n\.nspname = 'public' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated/i);
  }
}

assert.match(migrationSql, /create or replace function public\.cfm_recover_single_admin\(/i);
assert.match(migrationSql, /totp_secret_enc\s*=\s*null/i);
assert.match(migrationSql, /totp_enabled_at\s*=\s*null/i);
assert.match(migrationSql, /totp_last_used_step\s*=\s*-1/i);
assert.match(migrationSql, /recovery_code_hashes\s*=\s*'\[\]'::jsonb/i);
assert.match(migrationSql, /input_code_hash\s*!~\s*'\^\[A-Za-z0-9_-\]\{43\}\$'/i);
assert.match(runtimeDefaultsSql, /\('webhook_url', ''\)/i);

// 审计节流靠「一条 insert … on conflict do update … where」串行化。任何把它拆回
// 先 select 再 update 的改法都会让并发请求同时判定可写，同一条错误落多行审计日志。
// 这里锁三件事：函数在（且两份 SQL 一致）、on conflict 分支在、比较方向没被写反。
for (const source of [migrationSql, generatedSql]) {
  assert.match(source, /create or replace function public\.cfm_try_claim_audit_throttle\(/i);
  assert.match(source, /where n\.nspname = 'public' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated/i);
}
const throttleBody = migrationSql.match(
  /create or replace function public\.cfm_try_claim_audit_throttle\([\s\S]*?\n\$[a-z_]*\$;/i,
)?.[0];
assert.ok(throttleBody, 'cfm_try_claim_audit_throttle 函数体没截到');
assert.match(throttleBody, /insert into settings \(key, value\)[\s\S]*?on conflict \(key\) do update/i);
// 过期才放行：上次写入时间 <= 现在 - 节流窗口。写成 >= 会变成「越新越放行」。
assert.match(throttleBody, /settings\.value collate "C" <= to_char\(/i);
assert.match(throttleBody, /input_now - make_interval\(secs => input_throttle_ms \/ 1000\.0\)/i);
// 时间戳取调用方传入的 input_now，服务端 now() 会引入第二套时钟。
assert.doesNotMatch(throttleBody, /\bnow\(\)/i);
