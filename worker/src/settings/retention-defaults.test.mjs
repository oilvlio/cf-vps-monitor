import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const {
  SETTING_SCHEMA,
  RECORD_RETENTION_DEFAULT_HOURS,
  RECORD_RETENTION_MAX_HOURS,
  normalizeSettingValue,
} = await import('./schema.ts');
const { MONITOR_HISTORY_DAYS, MONITOR_MAX_HOURS } = createWorkerLoader().load('worker/src/monitor/contract.ts');

// ── 历史保留时间：默认 30 天（与 monitor-hub 一致） ──
assert.equal(RECORD_RETENTION_DEFAULT_HOURS, 720);
assert.equal(RECORD_RETENTION_MAX_HOURS, 720);

for (const key of ['record_preserve_time', 'ping_record_preserve_time']) {
  const entry = SETTING_SCHEMA[key];
  assert.equal(entry.defaultValue, '720', `${key} 默认 720 小时`);
  assert.equal(entry.max, 720, `${key} 上限 720 小时`);
  assert.deepEqual(normalizeSettingValue(key, '720'), { ok: true, value: '720' });
  assert.equal(normalizeSettingValue(key, '721').ok, false, `${key} 不接受超过上限的值`);
  assert.deepEqual(normalizeSettingValue(key, '168'), { ok: true, value: '168' }, '存量部署已存的 168 仍然合法');
}

// monitor 兼容层的 history_days / hours 上限必须跟随保留上限，否则会提供查不到数据的档位。
assert.equal(MONITOR_MAX_HOURS, RECORD_RETENTION_MAX_HOURS);
assert.equal(MONITOR_HISTORY_DAYS * 24, RECORD_RETENTION_MAX_HOURS);

// seed 必须与 schema 默认值一致：seed 写的是真实行，buildAdminSettings 取 stored ?? default，
// 两者不一致时改 schema 毫无效果（见 schema.ts 里 record_persist_interval_sec 的注释）。
const schemaSql = readFileSync(new URL('../../../supabase/migrations/1_schema.sql', import.meta.url), 'utf8');
for (const key of ['record_preserve_time', 'ping_record_preserve_time', 'record_high_watermark_rows']) {
  const match = schemaSql.match(new RegExp(`\\('${key}', '([^']*)'\\)`));
  assert.ok(match, `1_schema.sql 必须 seed ${key}`);
  assert.equal(match[1], SETTING_SCHEMA[key].defaultValue, `${key} 的 seed 与 schema 默认值必须一致`);
}

// 行数熔断线按保留期同比放宽（7 天 → 30 天约 4.3 倍），且仍在允许范围内。
const rows = SETTING_SCHEMA.record_high_watermark_rows;
assert.equal(rows.defaultValue, '3000000');
assert.ok(Number(rows.defaultValue) <= rows.max);
const live = readFileSync(new URL('../do/live-data.ts', import.meta.url), 'utf8');
assert.match(live, /RECORD_HIGH_WATERMARK_DEFAULT_ROWS = 3_000_000;/, 'DO 的回退默认值要与 schema 一致');
assert.match(live, /PING_OBSERVED_MAX_AGE_MS = RECORD_RETENTION_MAX_HOURS \* 60 \* 60 \* 1000;/, 'Ping 积压的最大年龄要跟随保留上限');

// 清理任务与手动清理都不能再把保留时间夹回 168 小时。
for (const file of ['../index.ts', '../routes/admin.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.min\(168,/, `${file} 不应再硬编码 168 小时上限`);
  assert.match(source, /RECORD_RETENTION_MAX_HOURS/, `${file} 应使用共享的保留上限常量`);
}
