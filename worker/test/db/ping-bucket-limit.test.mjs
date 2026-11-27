import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../src/generated/supabase-migrations.ts';

/**
 * Ping 读取的上限必须覆盖 Monitor 的点预算。
 *
 * Monitor 默认请求 1440 个点，窗口两端还会各多一个不完整的桶；如果 SQL 的
 * safe_limit 仍停在 1000，绘图桶会被静默丢掉最老的一段，窗口丢包率也会只
 * 覆盖被返回的那部分。这里同时检查迁移源文件与打包后的 generated 副本。
 */
const source = readFileSync(new URL('../../../supabase/migrations/2_functions.sql', import.meta.url), 'utf8');
const generated = BUNDLED_SUPABASE_MIGRATIONS.find(migration => migration.version === '2_functions')?.sql ?? '';
assert.ok(generated, '2_functions 应出现在打包的迁移里');

function functionBody(sql, name) {
  const marker = `FUNCTION public.${name}(`;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `缺少函数 ${name}`);
  const end = sql.indexOf('$function$;', start);
  assert.ok(end > start, `函数 ${name} 没有结束标记`);
  return sql.slice(start, end);
}

for (const [label, sql] of [['source', source], ['generated', generated]]) {
  for (const name of [
    'cfm_ping_records_for_tasks_range',
    'cfm_ping_records_for_tasks_range_bucketed',
  ]) {
    const text = functionBody(sql, name);
    const match = text.match(
      /safe_limit integer := least\(greatest\(coalesce\(input_limit, \d+\), 1\), (\d+)\)/,
    );
    assert.ok(match, `${label}: ${name} 缺少 safe_limit`);
    assert.ok(
      Number(match[1]) >= 1500,
      `${label}: ${name} 的 safe_limit=${match[1]} 不足以覆盖 1440 点预算和边界桶`,
    );
  }
}

console.log('ping bucket limit tests passed');
