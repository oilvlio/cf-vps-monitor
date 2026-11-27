import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';
import { readFileSync } from 'node:fs';

// --- capacity-fuse-bytes ---
{
  const { SETTING_SCHEMA } = await import('../../src/settings/schema.ts');
  const { evaluateHistoryCapacity } = await import('../../src/utils/history-capacity.ts');

  // ── 容量熔断按分区树字节计量 ──
  // v2 只保留原始表 + 30 分钟汇总表，历史只能靠整分区 DROP 收缩，因此熔断直接比较
  // 所有历史父表的 pg_total_relation_size 分区树之和（含索引与 TOAST）。不再估算
  // 「有效行字节」，也不再用行数做第二道闸门。
  const entry = SETTING_SCHEMA.record_high_watermark_bytes;
  assert.ok(entry, '必须存在 record_high_watermark_bytes 设置项');
  assert.equal(entry.type, 'integer');
  assert.equal(entry.defaultValue, '419430400', '默认 400 MiB');
  assert.equal(entry.public, false, '容量熔断线不对游客公开');
  assert.ok(entry.min >= 16_777_216, '下界不能低到让熔断永远处于触发态');

  // 行数设置已不再属于容量模型；保留历史设置读取的兼容性由 schema 的
  // removed-key 处理负责，不应继续出现在运行期配置或熔断逻辑中。
  assert.equal(SETTING_SCHEMA.record_high_watermark_rows, undefined, '行数熔断设置已移除');

  const live = readFileSync(new URL('../../src/do/live-data.ts', import.meta.url), 'utf8');
  const rpc = readFileSync(new URL('../../../supabase/migrations/2_functions.sql', import.meta.url), 'utf8');
  const schemaSql = readFileSync(new URL('../../../supabase/migrations/1_schema.sql', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../../src/routes/admin.ts', import.meta.url), 'utf8');

  // 1) 度量必须来自分区树总字节（含索引与 TOAST），且不包含已删除的旧表。
  assert.match(rpc, /create or replace function public\.cfm_history_storage_bytes\(\)/i,
    '必须有按字节度量的 RPC');
  assert.match(rpc, /public\.cfm_partition_tree_total_bytes\('public\.records'::regclass\)/i,
    '必须按分区树计量：pg_relation_size 不含索引，正是旧口径漏算的部分');
  assert.match(rpc, /'total',/,
    'total 必须是各历史父表分区树之和');
  assert.doesNotMatch(rpc, /pg_total_relation_size\('public\.gpu_records'\)/i,
    '已删除的 gpu_records 不得再计入容量');
  assert.match(rpc, /where n\.nspname = 'public' and p\.prokind = 'f'[\s\S]*?revoke all on function %s from public, anon, authenticated[\s\S]*?grant execute on function %s to service_role/i,
    '新 RPC 由统一循环收回 public 权限且只授权 service_role');
  assert.doesNotMatch(rpc, /grant execute on function public\.[^;]* to (?:anon|authenticated)/i,
    '不得把任何 public RPC 暴露给匿名或登录角色');

  // 2) The bytes RPC returns actual partition-tree allocation, including the
  // one field consumed by the runtime fuse. The estimate-shaped RPC is gone.
  assert.match(rpc, /'allocated_bytes'/);
  assert.doesNotMatch(rpc, /create or replace function public\.cfm_history_storage_usage\(/i);

  // 3) 种子与熔断判定
  assert.match(schemaSql, /\('record_high_watermark_bytes', '419430400'\)/, '设置种子必须写入默认值');
  const limits = { byteLimit: 419430400 };
  const usage = { allocated_bytes: 420 };
  assert.equal(evaluateHistoryCapacity(usage, limits).blocked, false, '远低于字节线不熔断');
  assert.equal(evaluateHistoryCapacity({ allocated_bytes: limits.byteLimit }, limits).blocked, true, '分配字节到线熔断');
  assert.equal(evaluateHistoryCapacity(usage, { ...limits, wasBlocked: true }).blocked, false, '低于低水位恢复');

  // 4) 快照复用：熔断线改了必须立刻重算，否则改了设置也要等缓存过期才生效
  assert.match(live, /snapshot\.highWatermarkBytes === this\.recordHighWatermarkBytes/,
    '字节熔断线变化必须让旧快照失效');

  // 5) 设置变更要能传导到 DO
  assert.match(admin, /'record_high_watermark_bytes',/, '后台必须允许编辑该设置');
  assert.match(live, /'record_high_watermark_bytes',/, 'DO 必须订阅该设置键');

  console.log('ok - 分区树字节熔断与已废弃别名形状');
}

// --- retention-defaults ---
{
  const {
    SETTING_SCHEMA,
    RECORD_RETENTION_DEFAULT_HOURS,
    RECORD_RETENTION_MAX_HOURS,
    RAW_RETENTION_MIN_HOURS,
    PING_RAW_RETENTION_DEFAULT_HOURS,
    PING_RAW_RETENTION_MAX_HOURS,
    ROLLUP_RETENTION_DEFAULT_HOURS,
    ROLLUP_RETENTION_MIN_HOURS,
    ROLLUP_RETENTION_MAX_HOURS,
    ROLLUP_RETENTION_SAFETY_MARGIN_HOURS,
    normalizeSettingValue,
    sanitizeSettingsForStorage,
    validateHistoryRetentionInvariant,
  } = await import('../../src/settings/schema.ts');
  const { MONITOR_HISTORY_DAYS, MONITOR_MAX_HOURS } = createWorkerLoader().load('worker/src/monitor/contract.ts');

  // Raw host/Ping history defaults to seven days; rollups default to 90 days.
  assert.equal(RECORD_RETENTION_DEFAULT_HOURS, 168);
  assert.equal(RECORD_RETENTION_MAX_HOURS, 720);

  assert.equal(SETTING_SCHEMA.record_preserve_time.defaultValue, '168');
  assert.equal(SETTING_SCHEMA.record_preserve_time.max, RECORD_RETENTION_MAX_HOURS);
  assert.equal(RAW_RETENTION_MIN_HOURS, 48);
  assert.equal(SETTING_SCHEMA.record_preserve_time.min, RAW_RETENTION_MIN_HOURS);
  assert.equal(normalizeSettingValue('record_preserve_time', '47').ok, false, 'raw history below 48h violates I1');
  assert.deepEqual(normalizeSettingValue('record_preserve_time', '48'), { ok: true, value: '48' });
  assert.equal(PING_RAW_RETENTION_DEFAULT_HOURS, 168);
  assert.equal(PING_RAW_RETENTION_MAX_HOURS, 720);
  assert.equal(SETTING_SCHEMA.ping_record_preserve_time.defaultValue, '168');
  assert.equal(SETTING_SCHEMA.ping_record_preserve_time.min, RAW_RETENTION_MIN_HOURS);
  assert.equal(SETTING_SCHEMA.ping_record_preserve_time.max, PING_RAW_RETENTION_MAX_HOURS);
  assert.deepEqual(normalizeSettingValue('ping_record_preserve_time', '168'), { ok: true, value: '168' });
  assert.equal(normalizeSettingValue('ping_record_preserve_time', '721').ok, false);
  // The shared v2 rollup retention: 90 days by default, 7 days to 365 days.
  assert.equal(ROLLUP_RETENTION_DEFAULT_HOURS, 2160);
  assert.equal(ROLLUP_RETENTION_MIN_HOURS, 168);
  assert.equal(ROLLUP_RETENTION_MAX_HOURS, 8760);
  assert.equal(SETTING_SCHEMA.rollup_preserve_time.defaultValue, '2160');
  assert.equal(SETTING_SCHEMA.rollup_preserve_time.min, 168);
  assert.equal(SETTING_SCHEMA.rollup_preserve_time.max, 8760);
  assert.deepEqual(normalizeSettingValue('rollup_preserve_time', '2160'), { ok: true, value: '2160' });
  assert.equal(normalizeSettingValue('rollup_preserve_time', '167').ok, false);
  assert.equal(normalizeSettingValue('rollup_preserve_time', '8761').ok, false);
  assert.equal(ROLLUP_RETENTION_SAFETY_MARGIN_HOURS, 2);
  assert.equal(validateHistoryRetentionInvariant({ record_preserve_time: '720', ping_record_preserve_time: '168', rollup_preserve_time: '723' }), null);
  assert.match(validateHistoryRetentionInvariant({ record_preserve_time: '720', ping_record_preserve_time: '168', rollup_preserve_time: '722' }), /大于.*2 小时/);
  assert.match(validateHistoryRetentionInvariant({ record_preserve_time: '48', ping_record_preserve_time: '720', rollup_preserve_time: '721' }), /当前至少 723 小时/);
  assert.equal(sanitizeSettingsForStorage({ ping_rollup_preserve_time: '2160' }).ok, false,
    'the retired per-Ping key is not a valid runtime setting');

  // monitor 兼容层的 history_days / hours 上限必须跟随保留上限，否则会提供查不到数据的档位。
  assert.equal(MONITOR_MAX_HOURS, RECORD_RETENTION_MAX_HOURS);
  assert.equal(MONITOR_HISTORY_DAYS * 24, RECORD_RETENTION_MAX_HOURS);

  // seed 必须与 schema 默认值一致：seed 写的是真实行，buildAdminSettings 取 stored ?? default，
  // 两者不一致时改 schema 毫无效果（见 schema.ts 里 record_persist_interval_sec 的注释）。
  const schemaSql = readFileSync(new URL('../../../supabase/migrations/1_schema.sql', import.meta.url), 'utf8');
  for (const key of ['record_preserve_time', 'rollup_preserve_time']) {
    const match = schemaSql.match(new RegExp(`\\('${key}', '([^']*)'\\)`));
    assert.ok(match, `1_schema.sql 必须 seed ${key}`);
    assert.equal(match[1], SETTING_SCHEMA[key].defaultValue, `${key} 的 seed 与 schema 默认值必须一致`);
}
assert.match(schemaSql, /\('ping_record_preserve_time', '168'\)/, '新装 Ping seed 直接是新默认值');
assert.match(schemaSql, /update settings set value = '168' where key = 'record_preserve_time' and value = '720'/, 'v2 只把旧默认 720 改成 168');
assert.match(schemaSql, /update settings set value = '168' where key = 'ping_record_preserve_time' and value = '720'/, 'legacy 3 的 Ping 720 修正必须折叠进终态');
assert.match(schemaSql, /value::integer < 48/, 'v2 把低于 48 小时的原始保留值抬到下限');
assert.match(schemaSql, /history_storage_v2_migrated/, 'v2 设置迁移只能执行一次');
assert.match(schemaSql, /select 'rollup_preserve_time', value\s+from settings\s+where key = 'ping_rollup_preserve_time'/, '旧 rollup key 在迁移时复制到新 key');
assert.match(schemaSql, /\('rollup_preserve_time', '2160'\)/, '新装 rollup 保留期 seed 是 90 天');
for (const file of ['../../src/routes/admin.ts', '../../src/index.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ping_rollup_preserve_time/, `${file} should use the shared rollup retention key`);
}

// v2 容量熔断只看历史分区树实际分配字节；行数设置已退役。
const bytes = SETTING_SCHEMA.record_high_watermark_bytes;
assert.equal(bytes.defaultValue, '419430400');
assert.ok(Number(bytes.defaultValue) <= bytes.max);
assert.equal(SETTING_SCHEMA.record_high_watermark_rows, undefined, '行数熔断设置已移除');
const live = readFileSync(new URL('../../src/do/live-data.ts', import.meta.url), 'utf8');
assert.match(live, /RECORD_HIGH_WATERMARK_DEFAULT_BYTES = 419_430_400;/, 'DO 的回退默认值要与 schema 一致');
assert.match(live, /'ping_record_preserve_time'/, 'DO must load the configured raw Ping retention');
assert.match(live, /this\.pingObservedMaxAgeMs = \(boundedPingRetentionHours - 24\) \* 60 \* 60 \* 1000;/, 'Ping backlog age follows configured retention');

// 清理任务与手动清理都必须走统一的整分区维护入口，而不是各自按行删除。
for (const file of ['../../src/index.ts', '../../src/routes/admin.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.min\(168,/, `${file} 不应再硬编码 168 小时上限`);
  assert.match(source, /maintainHistory/, `${file} 应调用统一的 cfm_partition_maintain 入口`);
}
}

// --- schema ---
{
const {
  buildAdminSettings,
  buildPublicSettings,
  normalizeSettingValue,
  sanitizeSettingsForStorage,
} = await import('../../src/settings/schema.ts');

assert.equal(normalizeSettingValue('site_logo_url', '/api/site-logo?v=1').ok, true);
assert.equal(normalizeSettingValue('site_logo_url', 'https://example.com/logo.png').ok, false);
assert.equal(normalizeSettingValue('site_logo_type', 'image/png').ok, true);
assert.equal(normalizeSettingValue('site_logo_data', 'a'.repeat(1500001)).ok, false);
assert.deepEqual(normalizeSettingValue('notification_method', 'webhook'), { ok: true, value: 'webhook' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'discord'), { ok: true, value: 'discord' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'custom'), { ok: true, value: 'custom' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'dingtalk'), { ok: true, value: 'dingtalk' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'wecom'), { ok: true, value: 'wecom' });
assert.equal(normalizeSettingValue('webhook_url', 'https://hooks.example.com/path?token=secret').ok, true);
assert.equal(normalizeSettingValue('webhook_url', 'http://hooks.example.com/path').ok, false);
assert.equal(normalizeSettingValue('webhook_url', 'https://127.0.0.1/path').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_method', 'GET'), { ok: true, value: 'GET' });
assert.deepEqual(normalizeSettingValue('webhook_method', 'POST'), { ok: true, value: 'POST' });
assert.equal(normalizeSettingValue('webhook_method', 'PUT').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_retry_count', '3'), { ok: true, value: '3' });
assert.equal(normalizeSettingValue('webhook_retry_count', '0').ok, false);
assert.equal(normalizeSettingValue('webhook_retry_count', '4').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_headers_json', '{"X-Test":"ok"}'), { ok: true, value: '{"X-Test":"ok"}' });
assert.equal(normalizeSettingValue('webhook_headers_json', '[]').ok, false);
assert.equal(normalizeSettingValue('webhook_headers_json', '{"X-Test":1}').ok, false);
assert.equal(normalizeSettingValue('webhook_content_type', 'application/json; charset=utf-8').ok, true);
assert.equal(normalizeSettingValue('webhook_content_type', 'application/json\r\nX-Bad: 1').ok, false);
assert.deepEqual(normalizeSettingValue('update_mode', 'fork'), { ok: false, error: '未知设置: update_mode' });

const publicSettings = buildPublicSettings({
  site_logo_url: '/api/site-logo?v=1',
  site_logo_data: 'private-image-data',
  site_logo_type: 'image/png',
});

assert.equal(publicSettings.site_logo_url, '/api/site-logo?v=1');
assert.equal('site_logo_data' in publicSettings, false);
assert.equal('site_logo_type' in publicSettings, false);

// webhook 自指：写入路径拦，读取路径不拦。
const SELF = 'monitor.example.com';
const SELF_URL = `https://${SELF}/api/hook`;

// 不传 selfHost 时行为与改动前一致——已有调用方（读取路径）不知道自己的域名。
assert.equal(normalizeSettingValue('webhook_url', SELF_URL).ok, true);
// 传了就拦，且提示要说人话，不能只回通用的「类型或取值无效」。
const selfResult = normalizeSettingValue('webhook_url', SELF_URL, SELF);
assert.equal(selfResult.ok, false);
assert.match(selfResult.error, /不能填本站地址/);
// 外部地址照常通过，并被归一化
assert.deepEqual(
  normalizeSettingValue('webhook_url', 'https://hooks.example.com/hook', SELF),
  { ok: true, value: 'https://hooks.example.com/hook' },
);
// 清空仍然允许：用户得有办法把坏值删掉
assert.deepEqual(normalizeSettingValue('webhook_url', '', SELF), { ok: true, value: '' });
// 非法地址仍走通用提示，不该被 self_host 的话术盖掉
assert.match(normalizeSettingValue('webhook_url', 'http://example.com/h', SELF).error, /类型或取值无效/);

// 透传到写入入口
const rejected = sanitizeSettingsForStorage({ webhook_url: SELF_URL }, { selfHost: SELF });
assert.equal(rejected.ok, false);
assert.match(rejected.errors.join(' | '), /不能填本站地址/);
assert.deepEqual(
  sanitizeSettingsForStorage({ webhook_url: SELF_URL }).errors,
  [],
  '不传 selfHost 时不该拦',
);
assert.match(
  sanitizeSettingsForStorage({ ping_rollup_preserve_time: '2160' }).errors.join(' '),
  /未知设置/,
  'retired Ping-only rollup key is not a runtime setting',
);

// 读取路径绝不能拦：否则存量坏值每次读取都判无效、回落成默认值，等于静默清空用户配置。
assert.equal(buildAdminSettings({ webhook_url: SELF_URL }).webhook_url, SELF_URL);
}
