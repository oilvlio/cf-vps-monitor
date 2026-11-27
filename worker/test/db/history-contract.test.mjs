import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

/**
 * 历史存储的公共 RPC 契约。
 *
 * 这个文件是 Phase 0 的闸门：重构期间 RPC 名称、参数名/顺序、返回类型
 * 和返回 JSON 的必填字段都不能变。允许的唯一字段变化是原始行上可选的
 * `id`（前端类型是 `id?: number`，没有读取方使用它）。v2 去掉代理主键后
 * 该字段消失，测试对 `id` 只做“可有可无”的断言。
 *
 * 需要故意改接口时，先改这里，再改实现——不要反过来。
 */

const CLIENT = 'contract-node';
const TASK = 7;
// Ping writes reject samples older than the late-arrival window, so the fixture
// clock has to be recent. Round to a 30-minute boundary so rollup buckets are
// deterministic.
const BASE_MS = Math.floor((Date.now() - 60 * 60 * 1000) / (30 * 60 * 1000)) * 30 * 60 * 1000;
const BASE = new Date(BASE_MS).toISOString();
const MID = new Date(BASE_MS + 30 * 60 * 1000).toISOString();
const END = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
const LATER = new Date(BASE_MS + 3 * 60 * 60 * 1000).toISOString();

/** name -> [identity args, result type] */
const CONTRACT = {
  // 写入 / 构建
  cfm_insert_monitor_record: ['input_record jsonb', 'void'],
  cfm_insert_ping_snapshot: ['input_client text, input_time text, input_results jsonb', 'void'],
  cfm_build_rollup: ['input_family text, input_now timestamp with time zone, input_max_buckets integer', 'jsonb'],

  // Host 读取
  cfm_recent_records: ['input_client text, input_limit integer', 'jsonb'],
  cfm_records_range_limited: ['input_client text, input_start text, input_end text, input_limit integer', 'jsonb'],
  cfm_records_range_bucketed: ['input_client text, input_start text, input_end text, input_bucket_sec integer, input_limit integer', 'jsonb'],
  cfm_records_range_aggregated: ['input_client text, input_start text, input_end text, input_bucket_sec integer, input_limit integer, input_sample_sec integer', 'jsonb'],
  cfm_records_range_aggregated_raw: ['input_client text, input_start text, input_end text, input_bucket_sec integer, input_limit integer, input_sample_sec integer', 'jsonb'],
  cfm_records_range_paged: ['input_client text, input_start text, input_end text, input_page integer, input_limit integer', 'jsonb'],
  cfm_records_range_cursor: ['input_client text, input_start text, input_end text, input_cursor text, input_limit integer', 'jsonb'],
  cfm_latest_record_times_for_clients: ['input_clients jsonb', 'jsonb'],
  cfm_load_metric_window_stats: ['input_clients jsonb, input_start text, input_end text, input_metric text, input_threshold double precision', 'jsonb'],

  // Ping 读取
  cfm_ping_records: ['input_client text, input_task_id integer, input_limit integer', 'jsonb'],
  cfm_ping_records_paged: ['input_client text, input_task_id integer, input_page integer, input_limit integer, input_start text, input_end text', 'jsonb'],
  cfm_ping_records_cursor: ['input_client text, input_task_id integer, input_cursor text, input_limit integer, input_start text, input_end text', 'jsonb'],
  cfm_ping_records_for_tasks: ['input_client text, input_task_ids jsonb, input_limit integer, input_cursor text', 'jsonb'],
  cfm_ping_records_for_tasks_range: ['input_client text, input_task_ids jsonb, input_start text, input_end text, input_limit integer', 'jsonb'],
  cfm_ping_records_for_tasks_range_bucketed: ['input_client text, input_task_ids jsonb, input_start text, input_end text, input_bucket_sec integer, input_limit integer', 'jsonb'],
  cfm_ping_rollup_range: ['input_client text, input_task_ids jsonb, input_start text, input_end text, input_step_sec integer, input_limit integer', 'jsonb'],
  cfm_ping_stats_for_tasks_range: ['input_client text, input_task_ids jsonb, input_start text, input_end text', 'jsonb'],
  cfm_ping_stats_from_rollup: ['input_client text, input_task_ids jsonb, input_start text, input_end text', 'jsonb'],
  cfm_home_ping_rows: ['input_start text, input_end text, input_row_limit integer', 'jsonb'],

  // 容量 / 清理 / 分区
  cfm_history_storage_bytes: ['', 'jsonb'],
  cfm_history_maintenance_status: ['', 'jsonb'],
  cfm_delete_clients: ['input_uuids jsonb', 'jsonb'],
  cfm_delete_ping_task: ['input_id integer', 'jsonb'],
  cfm_cleanup_orphan_client_data: ['', 'jsonb'],
  cfm_partition_tree_total_bytes: ['input_table regclass', 'bigint'],
};

const RECORD_KEYS = [
  'client', 'time', 'cpu', 'gpu', 'ram', 'ram_total', 'swap', 'swap_total',
  'load', 'load5', 'load15', 'temp', 'disk', 'disk_total', 'net_in', 'net_out',
  'net_total_up', 'net_total_down', 'process_count', 'connections',
  'connections_udp', 'uptime',
];

const AGGREGATED_KEYS = [
  'ts', 'samples', 'minutes', 'cpu', 'cpu_max', 'mem_used', 'disk_used',
  'net_rx', 'net_tx', 'net_rx_max', 'net_tx_max', 'swap_used', 'tcp', 'udp', 'procs',
];

const PING_ROW_KEYS = ['client', 'task_id', 'time', 'value'];

const PING_BUCKET_KEYS = [
  'time', 'task_id', 'value', 'sample_count', 'success_count', 'loss_count',
  'avg_latency', 'min_latency', 'max_latency', 'p50_latency', 'p75_latency',
];

const PING_STATS_KEYS = [
  'samples', 'success_count', 'loss_count', 'loss_rate', 'avg_latency',
  'min_latency', 'max_latency', 'p50_latency', 'p75_latency', 'jitter',
];

function assertHasKeys(value, keys, label) {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  for (const key of keys) {
    assert.ok(Object.hasOwn(value, key), `${label} is missing key ${key}`);
  }
}

async function seed(database) {
  await database.exec(`
    insert into clients (uuid, name) values ('${CLIENT}', 'Contract');
    insert into ping_tasks (id, name, target, clients) values (${TASK}, 'probe', 'example.com', '["${CLIENT}"]');
  `);
  await rpc(database, 'cfm_insert_monitor_record', {
    input_record: { client: CLIENT, time: BASE, cpu: 12.5, ram: 1024, disk: 2048, net_in: 10, net_out: 20 },
  });
  await rpc(database, 'cfm_insert_ping_snapshot', {
    input_client: CLIENT,
    input_time: BASE,
    input_results: [{ taskId: String(TASK), value: 22 }],
  });
}

test('history RPC signatures are frozen', async () => {
  const database = await createTestDatabase();
  try {
    const names = Object.keys(CONTRACT);
    const result = await database.query(`
      select p.proname,
        pg_get_function_identity_arguments(p.oid) as args,
        pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname, args
    `, [names]);

    for (const [name, [expectedArgs, expectedResult]] of Object.entries(CONTRACT)) {
      const rows = result.rows.filter(row => row.proname === name);
      assert.equal(rows.length, 1, `${name} must have exactly one overload`);
      assert.equal(rows[0].args, expectedArgs, `${name} argument contract changed`);
      assert.equal(rows[0].result, expectedResult, `${name} return type changed`);
    }
  } finally {
    await database.close();
  }
});

test('history read RPCs keep their JSON shapes', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);

    const recent = await rpc(database, 'cfm_recent_records', { input_client: CLIENT, input_limit: 10 });
    assert.ok(Array.isArray(recent) && recent.length > 0, 'recent_records returns rows');
    assertHasKeys(recent[0], RECORD_KEYS, 'cfm_recent_records row');

    const limited = await rpc(database, 'cfm_records_range_limited', {
      input_client: CLIENT, input_start: BASE, input_end: END, input_limit: 10,
    });
    assert.ok(Array.isArray(limited) && limited.length > 0, 'records_range_limited returns rows');
    assertHasKeys(limited[0], RECORD_KEYS, 'cfm_records_range_limited row');

    const bucketed = await rpc(database, 'cfm_records_range_bucketed', {
      input_client: CLIENT, input_start: BASE, input_end: END, input_bucket_sec: 900, input_limit: 10,
    });
    assert.ok(Array.isArray(bucketed) && bucketed.length > 0, 'records_range_bucketed returns rows');
    assertHasKeys(bucketed[0], RECORD_KEYS, 'cfm_records_range_bucketed row');

    const aggregated = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: CLIENT, input_start: BASE, input_end: END,
      input_bucket_sec: 900, input_limit: 10, input_sample_sec: 120,
    });
    assert.ok(Array.isArray(aggregated) && aggregated.length > 0, 'records_range_aggregated returns rows');
    assertHasKeys(aggregated[0], AGGREGATED_KEYS, 'cfm_records_range_aggregated bucket');

    const rawAggregated = await rpc(database, 'cfm_records_range_aggregated_raw', {
      input_client: CLIENT, input_start: BASE, input_end: END,
      input_bucket_sec: 900, input_limit: 10, input_sample_sec: 120,
    });
    assert.deepEqual(rawAggregated, aggregated, 'raw-only host fallback must preserve the aggregate response shape and values');

    const latestTimes = await rpc(database, 'cfm_latest_record_times_for_clients', { input_clients: [CLIENT] });
    assert.ok(Array.isArray(latestTimes), 'latest_record_times returns an array');
    if (latestTimes.length > 0) {
      assertHasKeys(latestTimes[0], ['client', 'last_time'], 'cfm_latest_record_times_for_clients row');
    }

    const loadStats = await rpc(database, 'cfm_load_metric_window_stats', {
      input_clients: [CLIENT], input_start: BASE, input_end: END,
      input_metric: 'cpu', input_threshold: 10,
    });
    assert.equal(typeof loadStats, 'object', 'load_metric_window_stats returns an object');
    if (Object.hasOwn(loadStats, CLIENT)) {
      assertHasKeys(loadStats[CLIENT], ['samples', 'exceeded', 'avg_value'], 'load metric stats');
    }

    const pingRows = await rpc(database, 'cfm_ping_records', { input_client: CLIENT, input_task_id: TASK, input_limit: 10 });
    assert.ok(Array.isArray(pingRows) && pingRows.length > 0, 'ping_records returns rows');
    assertHasKeys(pingRows[0], PING_ROW_KEYS, 'cfm_ping_records row');

    const pingRange = await rpc(database, 'cfm_ping_records_for_tasks_range', {
      input_client: CLIENT, input_task_ids: [TASK], input_start: BASE,
      input_end: END, input_limit: 10,
    });
    assert.equal(typeof pingRange, 'object', 'ping range returns an object keyed by task');
    assert.ok(Array.isArray(pingRange[String(TASK)]), 'ping range has a rows array');
    assertHasKeys(pingRange[String(TASK)][0], PING_ROW_KEYS, 'cfm_ping_records_for_tasks_range row');

    const pingBucketed = await rpc(database, 'cfm_ping_records_for_tasks_range_bucketed', {
      input_client: CLIENT, input_task_ids: [TASK], input_start: BASE,
      input_end: END, input_bucket_sec: 1800, input_limit: 10,
    });
    assert.ok(Array.isArray(pingBucketed[String(TASK)]), 'bucketed ping has a rows array');
    assertHasKeys(pingBucketed[String(TASK)][0], PING_BUCKET_KEYS, 'bucketed ping row');

    const pingStats = await rpc(database, 'cfm_ping_stats_for_tasks_range', {
      input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
    });
    assertHasKeys(pingStats[String(TASK)], PING_STATS_KEYS, 'ping stats row');

    const homeRows = await rpc(database, 'cfm_home_ping_rows', {
      input_start: BASE, input_end: END, input_row_limit: 10,
    });
    assert.equal(typeof homeRows, 'object', 'home ping rows returns an object');

    // 构建一次 rollup，验证汇总读取形状。基础桶是 30 分钟，input_now 取样本
    // 之后的 MID，确保覆盖 BASE 所在的桶。
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: MID, input_max_buckets: 48 });

    const pingRollup = await rpc(database, 'cfm_ping_rollup_range', {
      input_client: CLIENT, input_task_ids: [TASK], input_start: BASE,
      input_end: END, input_step_sec: 1800, input_limit: 10,
    });
    assert.ok(Array.isArray(pingRollup[String(TASK)]), 'ping rollup has a rows array');
    if (pingRollup[String(TASK)].length > 0) {
      assertHasKeys(pingRollup[String(TASK)][0], PING_BUCKET_KEYS, 'ping rollup row');
    }

    const pingStatsFromRollup = await rpc(database, 'cfm_ping_stats_from_rollup', {
      input_client: CLIENT, input_task_ids: [TASK], input_start: BASE, input_end: END,
    });
    if (Object.hasOwn(pingStatsFromRollup, String(TASK))) {
      assertHasKeys(pingStatsFromRollup[String(TASK)], PING_STATS_KEYS, 'rollup ping stats');
    }

    const bytes = await rpc(database, 'cfm_history_storage_bytes');
    assertHasKeys(bytes, ['total'], 'cfm_history_storage_bytes');
    assert.equal(typeof bytes.total, 'number');
    assert.ok(bytes.total >= 0);

    const maintenance = await rpc(database, 'cfm_history_maintenance_status');
    assertHasKeys(maintenance, ['checked_at', 'rollups', 'partitions', 'partition_maintenance'], 'cfm_history_maintenance_status');
    assert.deepEqual(Object.keys(maintenance.rollups).sort(), ['host', 'ping']);
    assert.ok(Object.hasOwn(maintenance.partitions, 'public.records'));
    assertHasKeys(maintenance.partition_maintenance, ['updated_at', 'pending_partitions', 'lock_timeouts'], 'partition maintenance state');
  } finally {
    await database.close();
  }
});

test('write RPCs stay void and build RPCs stay JSON objects', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);

    // PGlite 的 `select func()` 对 void 返回空字符串，PostgREST 返回 null；
    // 契约只要求“没有返回值”，两种都接受。
    const isVoid = value => value === null || value === undefined || value === '';

    assert.ok(isVoid(await rpc(database, 'cfm_insert_monitor_record', {
      input_record: { client: CLIENT, time: MID },
    })));

    assert.ok(isVoid(await rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: CLIENT,
      input_time: MID,
      input_results: [{ taskId: String(TASK), value: 11 }],
    })));

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: END, input_max_buckets: 10,
    });
    assert.equal(typeof built, 'object');
    assert.ok(Object.hasOwn(built, 'buckets'));

    const history = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: LATER, input_max_buckets: 48,
    });
    assert.equal(typeof history, 'object');
    assert.ok(Object.hasOwn(history, 'family'));
  } finally {
    await database.close();
  }
});
