import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, ensureHistoryFixturePartitions, rpc } from '../../../scripts/test-support/postgres.mjs';

/**
 * 原始层与汇总层的等价性闸门。
 *
 * Phase 0 先在现有 schema 上跑 Ping / GPU：这两条路径已经有 rollup。
 * Host 的 rollup 在 Phase 1 建表、Phase 3 读取 RPC 切换后加入，用例已去掉 skip。
 *
 * 比较口径：
 * - 计数、最小、最大、时间戳：精确；
 * - 浮点均值/百分位：1e-9 相对误差；
 * - 所有家族的基础桶都是 30 分钟，读取层再按请求步长合并。
 */

const CLIENT = 'equiv-node';
const OTHER_CLIENT = 'equiv-node-2';
const TASKS = [1, 2];
const START = '2026-09-01T00:00:00Z';
const END = '2026-09-01T01:00:00Z';

async function createHistoryDatabase() {
  const database = await createTestDatabase();
  await ensureHistoryFixturePartitions(database, [START]);
  return database;
}

function closeTo(actual, expected, label, epsilon = 1e-9) {
  if (expected === null || expected === undefined) {
    assert.equal(actual, expected, label);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= epsilon * scale,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

async function seedPing(database) {
  await database.exec(`
    insert into clients (uuid, name) values
      ('${CLIENT}', 'Equiv'),
      ('${OTHER_CLIENT}', 'Equiv 2');
    insert into ping_tasks (id, name, target, clients) values
      (1, 'probe-a', 'a.example.com', '["${CLIENT}","${OTHER_CLIENT}"]'),
      (2, 'probe-b', 'b.example.com', '["${CLIENT}"]');
  `);

  // 两个任务、两个节点、两次重传、两条丢包。
  // 非法值单独放在一个用例里：现有原始读取 RPC 直接 `(values)::integer`，
  // 遇到非数字会抛错；Phase 2 改成安全强转后再把它并入主 fixture。
  await database.exec(`
    insert into ping_snapshots (client, time, values_json) values
      ('${CLIENT}', '2026-09-01T00:00:00Z', '{"1":10,"2":100}'),
      ('${CLIENT}', '2026-09-01T00:05:00Z', '{"1":20,"2":-1}'),
      ('${CLIENT}', '2026-09-01T00:10:00Z', '{"1":-1,"2":120}'),
      ('${CLIENT}', '2026-09-01T00:15:00Z', '{"1":30,"2":130}'),
      ('${CLIENT}', '2026-09-01T00:30:00Z', '{"1":40,"2":140}'),
      ('${CLIENT}', '2026-09-01T00:35:00Z', '{"1":50,"2":-1}'),
      ('${CLIENT}', '2026-09-01T00:40:00Z', '{"1":-1,"2":160}'),
      ('${CLIENT}', '2026-09-01T00:45:00Z', '{"1":60,"2":170}'),
      ('${OTHER_CLIENT}', '2026-09-01T00:00:00Z', '{"1":70}'),
      ('${OTHER_CLIENT}', '2026-09-01T00:30:00Z', '{"1":80}');
  `);
}

async function pingRawBuckets(database, client, stepSec = 1800) {
  return rpc(database, 'cfm_ping_records_for_tasks_range_bucketed', {
    input_client: client,
    input_task_ids: TASKS,
    input_start: START,
    input_end: END,
    input_bucket_sec: stepSec,
    input_limit: 2000,
  });
}

async function pingRollupBuckets(database, client, stepSec = 1800) {
  return rpc(database, 'cfm_ping_rollup_range', {
    input_client: client,
    input_task_ids: TASKS,
    input_start: START,
    input_end: END,
    input_step_sec: stepSec,
    input_limit: 2000,
  });
}

/** 原始读取会为每个请求的任务返回 key（无数据是 []）；汇总会省略空任务。 */
function withoutEmptyTasks(value) {
  return Object.fromEntries(Object.entries(value).filter(([, rows]) => Array.isArray(rows) && rows.length > 0));
}

test('Ping raw and 30-minute rollup buckets are equivalent', async () => {
  const database = await createHistoryDatabase();
  try {
    await seedPing(database);
    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: END, input_max_buckets: 48,
    });
    assert.equal(built.buckets, 2, '一个节点两个半小时桶');

    // 把水位线推远，强制读取侧只走 rollup。
    await database.exec(`update cfm_internal.rollup_state set watermark = '2026-09-01T03:00:00Z' where family = 'ping'`);

    for (const client of [CLIENT, OTHER_CLIENT]) {
      const raw = withoutEmptyTasks(await pingRawBuckets(database, client));
      const rolled = withoutEmptyTasks(await pingRollupBuckets(database, client));
      assert.deepEqual(rolled, raw, `${client} 的原始/汇总 30 分钟桶必须一致`);
    }
  } finally {
    await database.close();
  }
});

test('Ping rollup merges to a larger step without losing counts', async () => {
  const database = await createHistoryDatabase();
  try {
    await seedPing(database);
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: END, input_max_buckets: 48 });
    await database.exec(`update cfm_internal.rollup_state set watermark = '2026-09-01T03:00:00Z' where family = 'ping'`);

    const raw = await pingRawBuckets(database, CLIENT, 3600);
    const rolled = await pingRollupBuckets(database, CLIENT, 3600);
    assert.equal(rolled['1'].length, 1);
    assert.equal(rolled['2'].length, 1);

    for (const taskId of ['1', '2']) {
      const rawRow = raw[taskId][0];
      const rolledRow = rolled[taskId][0];
      assert.equal(rolledRow.sample_count, rawRow.sample_count);
      assert.equal(rolledRow.success_count, rawRow.success_count);
      assert.equal(rolledRow.loss_count, rawRow.loss_count);
      assert.equal(rolledRow.min_latency, rawRow.min_latency);
      assert.equal(rolledRow.max_latency, rawRow.max_latency);
      closeTo(rolledRow.avg_latency, rawRow.avg_latency, `${taskId} avg`);
      // 30 分钟存储的 p50/p75 合并到 1 小时是 success_count 加权近似，
      // 与现有读取实现一致；这里只要求落在原始 min/max 之间。
      assert.ok(rolledRow.p50_latency >= rawRow.min_latency);
      assert.ok(rolledRow.p50_latency <= rawRow.max_latency);
    }
  } finally {
    await database.close();
  }
});

test('a late Ping sample re-enters the already-built bucket', async () => {
  const database = await createHistoryDatabase();
  try {
    await seedPing(database);
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: END, input_max_buckets: 48 });

    // 00:20 落在已经汇总过的 00:00-00:30 桶里。
    await database.exec(`
      insert into ping_snapshots (client, time, values_json)
      values ('${CLIENT}', '2026-09-01T00:20:00Z', '{"1":900,"2":-1}');
    `);

    // 下一次构建推进到 01:30，回看 2 小时，必须重算 00:00 桶。
    await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: '2026-09-01T01:30:00Z', input_max_buckets: 48,
    });
    await database.exec(`update cfm_internal.rollup_state set watermark = '2026-09-01T03:00:00Z' where family = 'ping'`);

    const raw = withoutEmptyTasks(await pingRawBuckets(database, CLIENT));
    const rolled = withoutEmptyTasks(await pingRollupBuckets(database, CLIENT));
    assert.deepEqual(rolled, raw, '迟到样本必须出现在重算后的汇总桶里');
    assert.equal(rolled['1'][0].sample_count, 5);
    assert.equal(rolled['1'][0].max_latency, 900);
  } finally {
    await database.close();
  }
});

test('Ping rollup skips invalid values instead of failing the bucket', async () => {
  const database = await createHistoryDatabase();
  try {
    await database.exec(`
      insert into clients (uuid, name) values ('${CLIENT}', 'Invalid values');
      insert into ping_tasks (id, name, target, clients) values
        (1, 'probe-a', 'a.example.com', '["${CLIENT}"]'),
        (3, 'probe-c', 'c.example.com', '["${CLIENT}"]'),
        (4, 'probe-d', 'd.example.com', '["${CLIENT}"]');
      insert into ping_snapshots (client, time, values_json) values
        ('${CLIENT}', '2026-09-01T00:00:00Z', '{"1":"abc","3":42,"4":99999999999}');
    `);

    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: '2026-09-01T01:00:00Z', input_max_buckets: 48,
    });
    assert.equal(typeof built, 'object');

    const rows = await database.query(`
      select task_id, sample_count, success_count, min_latency, max_latency
      from ping_rollup
      where client = $1
      order by task_id
    `, [CLIENT]);
    assert.deepEqual(rows.rows, [{
      task_id: 3, sample_count: 1, success_count: 1, min_latency: 42, max_latency: 42,
    }], '非数字和越界值被跳过，合法值仍然入桶');
  } finally {
    await database.close();
  }
});

async function seedHost(database) {
  await database.exec(`
    insert into clients (uuid, name) values ('${CLIENT}', 'Host Equiv') on conflict (uuid) do nothing;
    insert into records (
      client, time, cpu, ram, disk, swap, net_in, net_out,
      connections, connections_udp, process_count
    ) values
      ('${CLIENT}', '2026-09-01T00:00:00Z', 10, 1000, 2000, 100, 30, 40, 5, 2, 120),
      ('${CLIENT}', '2026-09-01T00:10:00Z', 20, 1100, 2100, 110, 31, 41, 6, 3, 121),
      ('${CLIENT}', '2026-09-01T00:20:00Z', 30, 1200, 2200, 120, 32, 42, 7, 4, 122),
      ('${CLIENT}', '2026-09-01T00:40:00Z', 40, 1300, 2300, 130, 33, 43, 8, 5, 123);
  `);
}

async function rawHostAggregate(database, start, end, bucketSec) {
  return (await database.query(`
    select
      (floor(extract(epoch from time) / $4)::bigint * $4) as bucket_ts,
      count(*)::integer as samples,
      avg(cpu) as cpu,
      max(cpu) as cpu_max,
      cast(avg(ram) as bigint) as mem_used,
      cast(avg(disk) as bigint) as disk_used,
      cast(avg(swap) as bigint) as swap_used,
      cast(avg(net_in) as bigint) as net_rx,
      cast(avg(net_out) as bigint) as net_tx,
      max(net_in) as net_rx_max,
      max(net_out) as net_tx_max,
      cast(round(avg(connections)) as bigint) as tcp,
      cast(round(avg(connections_udp)) as bigint) as udp,
      cast(round(avg(process_count)) as bigint) as procs
    from records
    where client = $1 and time >= $2::timestamptz and time <= $3::timestamptz
    group by 1 order by 1
  `, [CLIENT, start, end, bucketSec])).rows;
}

function assertHostBuckets(rolled, expected, bucketSec, label) {
  assert.equal(rolled.length, expected.length, `${label}: bucket count`);
  for (const [index, raw] of expected.entries()) {
    const bucket = rolled[index];
    assert.equal(Number(bucket.ts), Number(raw.bucket_ts), `${label}: bucket ${index} ts`);
    assert.equal(bucket.samples, raw.samples, `${label}: bucket ${index} samples`);
    closeTo(Number(bucket.cpu), Number(raw.cpu), `${label}: bucket ${index} cpu`);
    closeTo(Number(bucket.cpu_max), Number(raw.cpu_max), `${label}: bucket ${index} cpu_max`);
    assert.equal(bucket.mem_used, Number(raw.mem_used), `${label}: bucket ${index} mem_used`);
    assert.equal(bucket.disk_used, Number(raw.disk_used), `${label}: bucket ${index} disk_used`);
    assert.equal(bucket.swap_used, Number(raw.swap_used), `${label}: bucket ${index} swap_used`);
    assert.equal(bucket.net_rx, Number(raw.net_rx), `${label}: bucket ${index} net_rx`);
    assert.equal(bucket.net_tx, Number(raw.net_tx), `${label}: bucket ${index} net_tx`);
    closeTo(Number(bucket.net_rx_max), Number(raw.net_rx_max), `${label}: bucket ${index} net_rx_max`);
    closeTo(Number(bucket.net_tx_max), Number(raw.net_tx_max), `${label}: bucket ${index} net_tx_max`);
    assert.equal(bucket.tcp, Number(raw.tcp), `${label}: bucket ${index} tcp`);
    assert.equal(bucket.udp, Number(raw.udp), `${label}: bucket ${index} udp`);
    assert.equal(bucket.procs, Number(raw.procs), `${label}: bucket ${index} procs`);
  }
}

test('Host aggregated reads use host_rollup beyond raw retention and match raw', async () => {
  const database = await createHistoryDatabase();
  try {
    await seedHost(database);
    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: '2026-09-01T02:00:00Z', input_max_buckets: 96,
    });
    assert.ok((built.buckets ?? 0) >= 1, 'host rollup must build at least one bucket');
    const rolled = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: CLIENT, input_start: START, input_end: END,
      input_bucket_sec: 3600, input_limit: 100, input_sample_sec: 600,
    });
    assertHostBuckets(rolled, await rawHostAggregate(database, START, END, 3600), 3600, 'rollup-only');
  } finally {
    await database.close();
  }
});

test('Host aggregated reads splice rollup and raw at now - R_raw', async () => {
  const database = await createHistoryDatabase();
  try {
    await database.exec("insert into settings (key, value) values ('record_preserve_time', '48') on conflict (key) do update set value = excluded.value;");
    await database.exec(`insert into clients (uuid, name) values ('${CLIENT}', 'Host Splice')`);
    await database.exec(`
      insert into records (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count) values
        ('${CLIENT}', now() - interval '60 hours', 10, 1000, 2000, 100, 30, 40, 5, 2, 120),
        ('${CLIENT}', now() - interval '1 hour', 20, 1100, 2100, 110, 31, 41, 6, 3, 121);
    `);
    await rpc(database, 'cfm_build_rollup', { input_family: 'host', input_now: new Date().toISOString(), input_max_buckets: 96 });
    const start = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const end = new Date().toISOString();
    const rolled = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: CLIENT, input_start: start, input_end: end,
      input_bucket_sec: 3600, input_limit: 100, input_sample_sec: 600,
    });
    assertHostBuckets(rolled, await rawHostAggregate(database, start, end, 3600), 3600, 'splice');
  } finally {
    await database.close();
  }
});

test('Host aggregate clips the raw/rollup seam and partial query edges without gaps or duplicates', async () => {
  const database = await createHistoryDatabase();
  try {
    await database.exec("insert into settings (key, value) values ('record_preserve_time', '48') on conflict (key) do update set value = excluded.value;");
    await database.exec(`insert into clients (uuid, name) values ('${CLIENT}', 'Host Boundary')`);
    const cutoff = new Date((await database.query(`
      select date_bin(interval '30 minutes', now() - interval '48 hours', timestamptz '1970-01-01') as at
    `)).rows[0].at).getTime();
    const oldTime = new Date(cutoff - 10 * 60_000).toISOString();
    const recentTime = new Date(cutoff + 5 * 60_000).toISOString();
    const end = new Date(cutoff + 20 * 60_000).toISOString();
    const start = new Date(cutoff - 25 * 60_000).toISOString();
    await database.query(`
      insert into records (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count)
      values
        ($1, $2::timestamptz, 10, 1000, 2000, 100, 30, 40, 5, 2, 120),
        ($1, $3::timestamptz, 30, 1200, 2200, 120, 50, 60, 9, 4, 140)
    `, [CLIENT, oldTime, recentTime]);
    await rpc(database, 'cfm_build_rollup', {
      input_family: 'host', input_now: new Date().toISOString(), input_max_buckets: 96,
    });

    const actual = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: CLIENT, input_start: start, input_end: end,
      input_bucket_sec: 3600, input_limit: 100, input_sample_sec: 600,
    });
    const expected = await rawHostAggregate(database, start, end, 3600);
    assertHostBuckets(actual, expected, 3600, 'raw/rollup seam and partial range edges');
    assert.equal(actual.reduce((sum, bucket) => sum + bucket.samples, 0), 2,
      'each source sample contributes exactly once across the seam');
  } finally {
    await database.close();
  }
});

async function rawPingStats(database, client, taskIds, start, end) {
  return (await database.query(`
    select tid, count(*)::integer as samples,
      count(*) filter (where v >= 0)::integer as success_count,
      count(*) filter (where v < 0)::integer as loss_count,
      avg(v) filter (where v >= 0) as avg_latency,
      min(v) filter (where v >= 0) as min_latency,
      max(v) filter (where v >= 0) as max_latency,
      percentile_cont(0.5) within group (order by v) filter (where v >= 0) as p50_latency,
      percentile_cont(0.75) within group (order by v) filter (where v >= 0) as p75_latency,
      stddev_samp(v) filter (where v >= 0) as jitter
    from (
      select i.tid, (s.values_json ->> i.tid::text)::integer as v
      from unnest($3::integer[]) i(tid)
      join ping_snapshots s
        on s.client = $1 and s.values_json ? i.tid::text
       and s.time >= $2::timestamptz and s.time <= $4::timestamptz
    ) x
    group by tid order by tid
  `, [client, start, taskIds, end])).rows;
}

function assertPingStats(stats, expected, label, { exactPercentiles = true } = {}) {
  assert.equal(Object.keys(stats).length, expected.length, `${label}: task count`);
  for (const raw of expected) {
    const actual = stats[String(raw.tid)];
    assert.ok(actual, `${label}: task ${raw.tid} missing`);
    assert.equal(actual.samples, raw.samples, `${label}: task ${raw.tid} samples`);
    assert.equal(actual.success_count, raw.success_count, `${label}: task ${raw.tid} success`);
    assert.equal(actual.loss_count, raw.loss_count, `${label}: task ${raw.tid} loss`);
    closeTo(Number(actual.loss_rate), Number(raw.loss_count) * 100 / Number(raw.samples), `${label}: task ${raw.tid} loss_rate`);
    closeTo(Number(actual.avg_latency), Number(raw.avg_latency), `${label}: task ${raw.tid} avg`);
    closeTo(Number(actual.min_latency), Number(raw.min_latency), `${label}: task ${raw.tid} min`);
    closeTo(Number(actual.max_latency), Number(raw.max_latency), `${label}: task ${raw.tid} max`);
    // Percentiles are merged from per-bucket percentiles; the rollup path can
    // only approximate them. Samples/loss/avg/min/max/jitter stay exact.
    for (const key of ['p50_latency', 'p75_latency']) {
      const value = Number(actual[key]);
      if (exactPercentiles) {
        closeTo(value, Number(raw[key]), `${label}: task ${raw.tid} ${key}`);
      } else {
        assert.ok(
          value >= Number(raw.min_latency) - 1e-9 && value <= Number(raw.max_latency) + 1e-9,
          `${label}: task ${raw.tid} ${key} must stay within [min, max]`,
        );
      }
    }
    closeTo(Number(actual.jitter), Number(raw.jitter), `${label}: task ${raw.tid} jitter`);
  }
}

test('Ping stats merge rollup beyond raw retention and match raw', async () => {
  const database = await createHistoryDatabase();
  try {
    await seedPing(database);
    const built = await rpc(database, 'cfm_build_rollup', {
      input_family: 'ping', input_now: '2026-09-01T02:00:00Z', input_max_buckets: 96,
    });
    assert.ok((built.buckets ?? 0) >= 1, 'ping rollup must build at least one bucket');
    const stats = await rpc(database, 'cfm_ping_stats_for_tasks_range', {
      input_client: CLIENT, input_task_ids: TASKS, input_start: START, input_end: END,
    });
    assertPingStats(stats, await rawPingStats(database, CLIENT, TASKS, START, END), 'rollup-only', { exactPercentiles: false });
  } finally {
    await database.close();
  }
});

test('Ping stats splice rollup and raw at now - R_raw', async () => {
  const database = await createHistoryDatabase();
  try {
    await database.exec("insert into settings (key, value) values ('ping_record_preserve_time', '48') on conflict (key) do update set value = excluded.value;");
    await database.exec(`
      insert into clients (uuid, name) values ('${CLIENT}', 'Ping Splice');
      insert into ping_tasks (id, name, target, clients) values (1, 'probe', 'a.example.com', '["${CLIENT}"]');
      insert into ping_snapshots (client, time, values_json) values
        ('${CLIENT}', now() - interval '60 hours', '{"1":10}'),
        ('${CLIENT}', now() - interval '1 hour', '{"1":20}');
    `);
    await rpc(database, 'cfm_build_rollup', { input_family: 'ping', input_now: new Date().toISOString(), input_max_buckets: 96 });
    const start = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const end = new Date().toISOString();
    const stats = await rpc(database, 'cfm_ping_stats_for_tasks_range', {
      input_client: CLIENT, input_task_ids: [1], input_start: start, input_end: end,
    });
    assertPingStats(stats, await rawPingStats(database, CLIENT, [1], start, end), 'splice', { exactPercentiles: false });
  } finally {
    await database.close();
  }
});

