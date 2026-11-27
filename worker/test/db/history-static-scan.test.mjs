import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestDatabase } from '../../../scripts/test-support/postgres.mjs';

const functionsSql = readFileSync(new URL('../../../supabase/migrations/2_functions.sql', import.meta.url), 'utf8');

/**
 * 函数体引用扫描。
 *
 * Postgres 只在 CREATE 时校验 language sql 的函数体；plpgsql 的表名/列名要到
 * 第一次执行才解析。v2 删除了 gpu_records / ping_records / batch_hash 等对象，
 * 这里直接从 pg_proc.prosrc 扫描残留引用，避免靠“跑到哪炸到哪”才发现。
 *
 * 扫描前去掉注释和单引号字面量，这样 `jsonb_build_object('gpu_records', 0)`
 * 这种兼容旧形状的输出不会被误报；`'public.gpu_records'::regclass` 单独用
 * 字面量模式匹配。
 */

const DROPPED_RELATIONS = ['gpu_records', 'ping_records', 'history_storage_usage_cache'];
const DROPPED_COLUMNS = ['batch_hash'];
const HISTORY_PARENTS = ['records', 'ping_snapshots', 'host_rollup', 'ping_rollup'];

function stripCommentsAndLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
}

function findIssues(row) {
  const code = stripCommentsAndLiterals(row.prosrc);
  const issues = [];

  const relation = /\b(?:from|join|into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\b/gi;
  for (const match of code.matchAll(relation)) {
    if (DROPPED_RELATIONS.includes(match[1].toLowerCase())) {
      issues.push(`references dropped relation ${match[1]}`);
    }
  }

  for (const column of DROPPED_COLUMNS) {
    if (new RegExp(`\\b${column}\\b`, 'i').test(code)) issues.push(`references dropped column ${column}`);
  }

  for (const parent of HISTORY_PARENTS) {
    if (new RegExp(`\\b${parent}\\s*\\.\\s*id\\b`, 'i').test(code)) {
      issues.push(`references removed surrogate key ${parent}.id`);
    }
  }

  if (/\bcfm_estimate_history_relation\s*\(/i.test(code)) {
    issues.push('calls dropped function cfm_estimate_history_relation');
  }

  for (const relation of DROPPED_RELATIONS) {
    const literal = new RegExp(`pg_(?:total_relation_size|relation_size|table_size)\\(\\s*'(?:public\\.)?${relation}'`, 'i');
    if (literal.test(row.prosrc)) issues.push(`sizes dropped relation ${relation}`);
  }

  return issues;
}

test('no function body references objects removed by the v2 layout', async () => {
  const database = await createTestDatabase();
  try {
    const result = await database.query(`
      select n.nspname as schema, p.proname as name,
        pg_get_function_identity_arguments(p.oid) as args,
        p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname in ('public', 'cfm_internal')
        and l.lanname in ('sql', 'plpgsql')
      order by n.nspname, p.proname, args
    `);

    const failures = [];
    for (const row of result.rows) {
      const issues = findIssues(row);
      for (const issue of issues) failures.push(`${row.schema}.${row.name}(${row.args}): ${issue}`);
    }
    assert.deepEqual(failures, [], `stale references found:\n${failures.join('\n')}`);
  } finally {
    await database.close();
  }
});

test('2_functions.sql no longer defines GPU history', () => {
  // Retirement drops stay; every other line must be free of GPU history objects.
  const leftovers = functionsSql
    .split('\n')
    .filter(line => /gpu_snapshots|gpu_rollup|cfm_gpu_|cfm_insert_gpu_snapshot|\bjnum\b|\bjidx\b/.test(line))
    .filter(line => !/^drop function if exists public\.cfm_/.test(line));
  assert.deepEqual(leftovers, [], 'GPU history must not survive in 2_functions.sql');
});

test('history maintenance status RPC is granted only to the service role', async () => {
  const database = await createTestDatabase();
  try {
    const result = await database.query(`
      select p.proacl::text as acl
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'cfm_history_maintenance_status'
    `);
    assert.equal(result.rows.length, 1);
    const acl = result.rows[0].acl || '';
    assert.match(acl, /service_role=X/);
    assert.doesNotMatch(acl, /(?:^|[,{])=X|anon=X|authenticated=X/);
  } finally {
    await database.close();
  }
});
