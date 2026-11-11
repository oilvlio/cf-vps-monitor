import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

// monitor 主题契约的两支读 RPC：封闭桶聚合（metrics）与 day_*/total_* 流量。
const METRICS_START = '2026-10-01T00:00:00Z';
const METRICS_END = '2026-10-01T00:20:00Z';
const BUCKET_SEC = 600;
const bucketTs = iso => Math.floor(Date.parse(iso) / 1000 / BUCKET_SEC) * BUCKET_SEC;

test('cfm_records_range_aggregated returns sealed bucket means, peaks and sample-derived minutes', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec("insert into clients (uuid, name) values ('agg', 'agg');");
    await database.query(`
      insert into records
        (client, time, cpu, ram, disk, swap, net_in, net_out, connections, connections_udp, process_count)
      values
        ('agg', '2026-10-01T00:00:00Z', 10, 100, 50, 5, 1000, 500, 10, 2, 50),
        ('agg', '2026-10-01T00:02:00Z', 20, 200, 60, 6, 3000, 600, 20, 4, 60),
        ('agg', '2026-10-01T00:09:00Z', 30, 300, 70, 7, 2000, 700, 30, 6, 70),
        ('agg', '2026-10-01T00:12:00Z', 40, 400, 80, 8, 4000, 800, 40, 8, 80)
    `);

    const rows = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: 'agg',
      input_start: METRICS_START,
      input_end: METRICS_END,
      input_bucket_sec: BUCKET_SEC,
      input_limit: 10,
      // records 每 120s 落一条，一条代表 2 分钟。
      input_sample_sec: 120,
    });

    assert.equal(rows.length, 2, '按 10 分钟分出两个桶');
    assert.equal(rows[0].ts, bucketTs(METRICS_START));
    assert.equal(rows[0].samples, 3);
    // 整桶均值 + 峰值，而不是桶里最新一行的值。
    assert.equal(rows[0].cpu, 20);
    assert.equal(rows[0].cpu_max, 30);
    assert.equal(rows[0].mem_used, 200);
    assert.equal(rows[0].disk_used, 60);
    assert.equal(rows[0].swap_used, 6);
    assert.equal(rows[0].net_rx, 2000);
    assert.equal(rows[0].net_rx_max, 3000);
    assert.equal(rows[0].net_tx, 600);
    assert.equal(rows[0].net_tx_max, 700);
    assert.equal(rows[0].tcp, 20);
    assert.equal(rows[0].udp, 4);
    assert.equal(rows[0].procs, 60);
    // 3 个样本 × 120s / 60 = 6 分钟，且不超过桶宽 10 分钟。
    assert.equal(rows[0].minutes, 6);

    assert.equal(rows[1].ts, bucketTs('2026-10-01T00:12:00Z'));
    assert.equal(rows[1].samples, 1);
    assert.equal(rows[1].cpu, 40);
    assert.equal(rows[1].minutes, 2);
  } finally {
    await database.close();
  }
});

test('cfm_records_range_aggregated caps minutes at the bucket width and keeps the newest buckets under a limit', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec("insert into clients (uuid, name) values ('agg', 'agg');");
    // 同一桶 5 个样本，但 sample_sec 很大：minutes 仍不得超过 step/60。
    await database.query(`
      insert into records (client, time, cpu)
      values
        ('agg', '2026-10-01T00:00:00Z', 1),
        ('agg', '2026-10-01T00:02:00Z', 2),
        ('agg', '2026-10-01T00:04:00Z', 3),
        ('agg', '2026-10-01T00:06:00Z', 4),
        ('agg', '2026-10-01T00:08:00Z', 5),
        ('agg', '2026-10-01T00:12:00Z', 6)
    `);

    const rows = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: 'agg',
      input_start: METRICS_START,
      input_end: METRICS_END,
      input_bucket_sec: 60,
      input_limit: 100,
      input_sample_sec: 3600,
    });
    assert.ok(rows.every(row => row.minutes === 1), 'step=60 时 minutes 最多 1');

    const limited = await rpc(database, 'cfm_records_range_aggregated', {
      input_client: 'agg',
      input_start: METRICS_START,
      input_end: METRICS_END,
      input_bucket_sec: 60,
      input_limit: 1,
      input_sample_sec: 60,
    });
    assert.equal(limited.length, 1);
    assert.equal(
      limited[0].ts,
      Math.floor(Date.parse('2026-10-01T00:12:00Z') / 60_000) * 60,
      'limit 保留最新的桶',
    );
  } finally {
    await database.close();
  }
});

test('cfm_traffic_totals batches day_*/total_* and ignores a stale latest day', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients (uuid, name) values ('t1', 't1'), ('t2', 't2'), ('t3', 't3'), ('t4', 't4');
      insert into traffic_daily (client, day, up, down) values
        ('t1', current_date - 1, 111, 222),
        ('t1', current_date - 30, 1000, 2000),
        ('t2', current_date - 40, 5, 7),
        ('t4', current_date + 1, 9, 8);
    `);

    const totals = await rpc(database, 'cfm_traffic_totals', {
      input_clients: ['t1', 't2', 't3', 't4'],
    });

    // t1 的最近日桶是昨天（±1 天内），算作「今天」；total 仍包含 30 天前的历史。
    assert.deepEqual(totals.t1, { day_rx: 222, day_tx: 111, total_rx: 2222, total_tx: 1111 });
    // t2 最近一次上报在 40 天前：day_* 归零，但 total_* 保留。
    assert.deepEqual(totals.t2, { day_rx: 0, day_tx: 0, total_rx: 7, total_tx: 5 });
    // 未来一天（Agent 本地时区跨日）也算今天。
    assert.deepEqual(totals.t4, { day_rx: 8, day_tx: 9, total_rx: 8, total_tx: 9 });
    // 没有流量记录的节点不出现在结果里。
    assert.equal(totals.t3, undefined);
  } finally {
    await database.close();
  }
});
