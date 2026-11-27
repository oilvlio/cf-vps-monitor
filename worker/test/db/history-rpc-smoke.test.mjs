import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createRealPostgresDatabase,
  hasRealPostgres,
  rpc,
} from '../../../scripts/test-support/real-postgres.mjs';

/**
 * RPC 冒烟测试。
 *
 * 目录等价只能证明对象存在；plpgsql 的表名、列名和函数调用要等到第一次
 * 执行才解析。这里用真实 Postgres，把 Worker 会调用的历史 RPC 每个都跑
 * 一遍（最小参数），一旦出现 42P01 / 42703 / 42883 之类的 schema 错误就
 * 直接失败。
 *
 * 参数表之外的 Worker 历史 RPC 会先由 client.ts 的调用名反查出来，缺参数
 * 就报错，避免新增 RPC 时漏测。
 */

const CLIENT = 'smoke-node';
const TASK = 11;
const BASE_MS = Math.floor((Date.now() - 60 * 60 * 1000) / (30 * 60 * 1000)) * 30 * 60 * 1000;
const BASE = new Date(BASE_MS).toISOString();
const END = new Date(BASE_MS + 2 * 60 * 60 * 1000).toISOString();
const LATER = new Date(BASE_MS + 4 * 60 * 60 * 1000).toISOString();
const ANCIENT = '2000-01-01T00:00:00.000Z';

/**
 * name -> minimal valid arguments for a fresh, seeded database.
 *
 * Destructive calls are kept at the end of the object so insertion order gives
 * the reads something to look at.
 */
const RPC_ARGS = {
  cfm_insert_monitor_record: {
    input_record: { client: CLIENT, time: BASE, cpu: 1.5, ram: 1024 },
  },
  cfm_insert_ping_snapshot: {
    input_client: CLIENT,
    input_time: BASE,
    input_results: [{ taskId: String(TASK), value: 12 }],
  },

  cfm_build_rollup: { input_family: 'ping', input_now: LATER, input_max_buckets: 4 },

  cfm_recent_records: { input_client: CLIENT, input_limit: 10 },
  cfm_records_range_limited: { input_client: CLIENT, input_start: BASE, input_end: END, input_limit: 10 },
  cfm_records_range_bucketed: {
    input_client: CLIENT, input_start: BASE, input_end: END, input_bucket_sec: 900, input_limit: 10,
  },
  cfm_records_range_aggregated: {
    input_client: CLIENT, input_start: BASE, input_end: END,
    input_bucket_sec: 900, input_limit: 10, input_sample_sec: 120,
  },
  cfm_records_range_aggregated_raw: {
    input_client: CLIENT, input_start: BASE, input_end: END,
    input_bucket_sec: 900, input_limit: 10, input_sample_sec: 120,
  },
  cfm_records_range_paged: {
    input_client: CLIENT, input_start: BASE, input_end: END, input_page: 1, input_limit: 10,
  },
  cfm_records_range_cursor: {
    input_client: CLIENT, input_start: BASE, input_end: END, input_limit: 10,
  },
  cfm_latest_record_times_for_clients: { input_clients: [CLIENT] },
  cfm_load_metric_window_stats: {
    input_clients: [CLIENT], input_start: BASE, input_end: END,
    input_metric: 'cpu', input_threshold: 10,
  },

  cfm_ping_records: { input_client: CLIENT, input_task_id: TASK, input_limit: 10 },
  cfm_ping_records_paged: {
    input_client: CLIENT, input_task_id: TASK, input_page: 1, input_limit: 10,
  },
  cfm_ping_records_cursor: { input_client: CLIENT, input_task_id: TASK, input_limit: 10 },
  cfm_ping_records_for_tasks: { input_client: CLIENT, input_task_ids: [TASK], input_limit: 10 },
  cfm_ping_records_for_tasks_range: {
    input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END, input_limit: 10,
  },
  cfm_ping_records_for_tasks_range_bucketed: {
    input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
    input_bucket_sec: 1800, input_limit: 10,
  },
  cfm_ping_rollup_range: {
    input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
    input_step_sec: 1800, input_limit: 10,
  },
  cfm_ping_stats_for_tasks_range: {
    input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
  },
  cfm_ping_stats_from_rollup: {
    input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
  },
  cfm_home_ping_rows: { input_start: BASE, input_end: END, input_row_limit: 10 },

  cfm_history_storage_bytes: {},
  cfm_history_maintenance_status: {},
  cfm_partition_tree_total_bytes: { input_table: 'public.records' },
  cfm_partition_maintain: { input_now: new Date().toISOString() },

  // Destructive tail. Use non-existent ids where possible so the smoke pass
  // does not depend on earlier calls having left rows behind.
  cfm_delete_clients: { input_uuids: ['smoke-missing-client'] },
  cfm_delete_ping_task: { input_id: 999_999 },
  cfm_cleanup_orphan_client_data: {},
};

// Names in client.ts that belong to the history/storage/partition family. Any
// new one must get a row in RPC_ARGS, otherwise this test fails loudly instead
// of silently skipping it.
const HISTORY_RPC_NAME = /^cfm_(?:insert_monitor_record|insert_ping_snapshot|recent_records|records_range_[a-z_]+|latest_record_times_for_clients|load_metric_window_stats|ping_records[a-z_]*|ping_rollup_range|ping_stats_[a-z_]+|build_rollup|home_ping_rows|history_storage_bytes|history_maintenance_status|partition_tree_total_bytes|partition_maintain|cleanup_orphan_client_data|delete_clients|delete_ping_task)$/;

async function workerHistoryRpcs() {
  const source = await readFile(
    new URL('../../src/db/supabase-api/client.ts', import.meta.url),
    'utf8',
  );
  const names = new Set();
  for (const match of source.matchAll(/'((?:cfm_[a-z0-9_]+))'/g)) {
    if (HISTORY_RPC_NAME.test(match[1])) names.add(match[1]);
  }
  return [...names].sort();
}

function describeError(error) {
  return `sqlstate=${error.code ?? 'unknown'} message=${error.message}`;
}

test('every Worker history RPC executes against a fresh database', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  const database = await createRealPostgresDatabase();
  try {
    await database.query(`
      insert into public.clients (uuid, name, token) values ('${CLIENT}', 'Smoke', 'smoke-token');
      insert into public.ping_tasks (id, name, target, clients)
        values (${TASK}, 'smoke', 'example.com', '["${CLIENT}"]');
    `);

    const used = await workerHistoryRpcs();
    const missing = used.filter(name => !Object.hasOwn(RPC_ARGS, name));
    assert.deepEqual(missing, [], `add minimal arguments for new Worker history RPC(s): ${missing.join(', ')}`);

    const failures = [];
    for (const [name, args] of Object.entries(RPC_ARGS)) {
      try {
        await rpc(database, name, args);
      } catch (error) {
        const schemaError = typeof error.code === 'string' && error.code.startsWith('42');
        failures.push({
          name,
          schema: schemaError,
          detail: describeError(error),
        });
      }
    }

    const schemaFailures = failures.filter(failure => failure.schema);
    assert.deepEqual(schemaFailures, [], `undefined schema object(s):\n${schemaFailures.map(f => `${f.name}: ${f.detail}`).join('\n')}`);
    assert.deepEqual(failures, [], `history RPC smoke failures:\n${failures.map(f => `${f.name}: ${f.detail}`).join('\n')}`);
  } finally {
    await database.close();
  }
});

test('service_role executes insert RPCs without direct raw-write-guard permission', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  const database = await createRealPostgresDatabase();
  try {
    await database.query(`
      insert into public.clients (uuid, name, token) values ('insert-role-smoke', 'Insert role smoke', 'smoke-token');
      insert into public.ping_tasks (id, name, target, clients)
        values (992, 'insert-role-smoke-probe', 'example.com', '["insert-role-smoke"]');
    `);

    const service = await database.connect();
    try {
      await service.query('set role service_role');
      await rpc(service, 'cfm_insert_ping_snapshot', {
        input_client: 'insert-role-smoke', input_time: new Date().toISOString(),
        input_results: [{ taskId: '992', value: 15 }],
      });
      await rpc(service, 'cfm_insert_monitor_record', {
        input_record: { client: 'insert-role-smoke', time: new Date().toISOString(), cpu: 12 },
      });

      await assert.rejects(
        service.query("select cfm_internal.raw_write_allowed('public.records'::regclass, now())"),
        { code: '42501' },
      );
    } finally {
      await service.end();
    }

    const counts = await database.query(`
      select
        (select count(*)::integer from public.ping_snapshots where client='insert-role-smoke') as ping,
        (select count(*)::integer from public.records where client='insert-role-smoke') as records
    `);
    assert.deepEqual(counts.rows[0], { ping: 1, records: 1 });
  } finally {
    await database.close();
  }
});
