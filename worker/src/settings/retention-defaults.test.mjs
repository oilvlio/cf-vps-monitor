import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const {
  SETTING_SCHEMA,
  RECORD_RETENTION_DEFAULT_HOURS,
  RECORD_RETENTION_MAX_HOURS,
  PING_RAW_RETENTION_DEFAULT_HOURS,
  PING_RAW_RETENTION_MAX_HOURS,
  PING_ROLLUP_RETENTION_DEFAULT_HOURS,
  PING_ROLLUP_RETENTION_MAX_HOURS,
  normalizeSettingValue,
} = await import('./schema.ts');
const { MONITOR_HISTORY_DAYS, MONITOR_MAX_HOURS } = createWorkerLoader().load('worker/src/monitor/contract.ts');

// General history remains 30 days; raw Ping is seven days and rollups default to 90 days.
assert.equal(RECORD_RETENTION_DEFAULT_HOURS, 720);
assert.equal(RECORD_RETENTION_MAX_HOURS, 720);

assert.equal(SETTING_SCHEMA.record_preserve_time.defaultValue, '720');
assert.equal(SETTING_SCHEMA.record_preserve_time.max, RECORD_RETENTION_MAX_HOURS);
assert.equal(PING_RAW_RETENTION_DEFAULT_HOURS, 168);
assert.equal(PING_RAW_RETENTION_MAX_HOURS, 720);
assert.equal(SETTING_SCHEMA.ping_record_preserve_time.defaultValue, '168');
assert.equal(SETTING_SCHEMA.ping_record_preserve_time.max, PING_RAW_RETENTION_MAX_HOURS);
assert.deepEqual(normalizeSettingValue('ping_record_preserve_time', '168'), { ok: true, value: '168' });
assert.equal(normalizeSettingValue('ping_record_preserve_time', '721').ok, false);
assert.equal(PING_ROLLUP_RETENTION_DEFAULT_HOURS, 2160);
assert.equal(PING_ROLLUP_RETENTION_MAX_HOURS, 8760);
assert.equal(SETTING_SCHEMA.ping_rollup_preserve_time.defaultValue, '2160');
assert.equal(SETTING_SCHEMA.ping_rollup_preserve_time.max, PING_ROLLUP_RETENTION_MAX_HOURS);

// monitor 兼容层的 history_days / hours 上限必须跟随保留上限，否则会提供查不到数据的档位。
assert.equal(MONITOR_MAX_HOURS, RECORD_RETENTION_MAX_HOURS);
assert.equal(MONITOR_HISTORY_DAYS * 24, RECORD_RETENTION_MAX_HOURS);

// seed 必须与 schema 默认值一致：seed 写的是真实行，buildAdminSettings 取 stored ?? default，
// 两者不一致时改 schema 毫无效果（见 schema.ts 里 record_persist_interval_sec 的注释）。
const schemaSql = readFileSync(new URL('../../../supabase/migrations/1_schema.sql', import.meta.url), 'utf8');
for (const key of ['record_preserve_time', 'record_high_watermark_rows']) {
  const match = schemaSql.match(new RegExp(`\\('${key}', '([^']*)'\\)`));
  assert.ok(match, `1_schema.sql 必须 seed ${key}`);
  assert.equal(match[1], SETTING_SCHEMA[key].defaultValue, `${key} 的 seed 与 schema 默认值必须一致`);
}
const rollupMigration = readFileSync(new URL('../../../supabase/migrations/3_ping_rollup.sql', import.meta.url), 'utf8');
assert.match(schemaSql, /\('ping_record_preserve_time', '720'\)/, '旧 schema seed 继续保持可重放');
assert.match(rollupMigration, /update settings set value='168' where key='ping_record_preserve_time' and value='720'/);
assert.match(rollupMigration, /ping_rollup_preserve_time','2160'/);

// 行数熔断线按保留期同比放宽（7 天 → 30 天约 4.3 倍），且仍在允许范围内。
const rows = SETTING_SCHEMA.record_high_watermark_rows;
assert.equal(rows.defaultValue, '3000000');
assert.ok(Number(rows.defaultValue) <= rows.max);
const live = readFileSync(new URL('../do/live-data.ts', import.meta.url), 'utf8');
assert.match(live, /RECORD_HIGH_WATERMARK_DEFAULT_ROWS = 3_000_000;/, 'DO 的回退默认值要与 schema 一致');
assert.match(live, /'ping_record_preserve_time'/, 'DO must load the configured raw Ping retention');
assert.match(live, /this\.pingObservedMaxAgeMs = Math\.max\(0, boundedPingRetentionHours - 24\) \* 60 \* 60 \* 1000;/, 'Ping backlog age follows configured retention with a one-day safety margin');

// 清理任务与手动清理都不能再把保留时间夹回 168 小时。
for (const file of ['../index.ts', '../routes/admin.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.min\(168,/, `${file} 不应再硬编码 168 小时上限`);
  assert.match(source, /RECORD_RETENTION_MAX_HOURS/, `${file} 应使用共享的保留上限常量`);
}
