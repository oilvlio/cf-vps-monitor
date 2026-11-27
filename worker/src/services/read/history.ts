/**
 * 历史查询的统一入口。
 *
 * 原生读 API（`/api/records/load`、`/api/records/ping`、`/api/records/ping/batch`、
 * `/api/records/ping/stats`）与 monitor 的 `/api/nodes/:id/metrics` 之前各自写了一遍
 * “按窗口选 raw / rollup，再挑对应 RPC”。同一份 `resolveHistoryPlan` 被复制四次，
 * 任何一次漏改都会让两条读路径对同一窗口给出不同的源或步长。
 *
 * 这里只放“plan → RPC”的选择与调用；参数解析、可见性、缓存、响应包络仍在路由里。
 */
import * as db from '../../db/queries';
import type { MonitorMetricsBucket, MonitorRecord, PingHistoryRecord, PingTaskStats } from '../../db/types';
import { ReadUnavailableError } from './failure';
import {
  historyBucketSec,
  resolveHistoryPlan,
  type PingHistoryPlan,
} from '../../utils/history-bucket';

/** 原生 Ping 历史的分桶计划（与 monitor 共用 resolveHistoryPlan）。 */
export function pingHistoryPlan(
  rangeMs: number,
  options: Parameters<typeof resolveHistoryPlan>[1],
): PingHistoryPlan {
  return resolveHistoryPlan(rangeMs, options);
}

export type PingHistoryQuery = {
  uuid: string;
  taskIds: number[];
  start?: string;
  end?: string;
  limit: number;
  plan: PingHistoryPlan;
};

/**
 * 按计划读 Ping 绘图桶。
 *
 * - rollup：30 分钟（或 monitor 的整小时倍数）合并桶；
 * - raw + stepSec>0：原始样本按 step 聚合计数、延迟分位数与极值；
 * - raw + stepSec=0：短窗口直接读原始行，不聚合。
 */
export function loadPingHistory(
  database: db.QueryDatabase,
  query: PingHistoryQuery,
): Promise<Record<string, PingHistoryRecord[]>> {
  const { uuid, taskIds, start, end, limit, plan } = query;
  if (plan.source === 'rollup') {
    return db.getPingRollupRange(database, uuid, taskIds, start, end, plan.stepSec, limit)
      .catch(() => { throw new ReadUnavailableError(); });
  }
  if (plan.stepSec > 0) {
    return db.getPingRecordsForTasksRangeBucketed(database, uuid, taskIds, start, end, plan.stepSec, limit)
      .catch(() => { throw new ReadUnavailableError(); });
  }
  return db.getPingRecordsForTasksRange(database, uuid, taskIds, start, end, limit)
    .catch(() => { throw new ReadUnavailableError(); });
}

export type PingStatsQuery = {
  uuid: string;
  taskIds: number[];
  start: string;
  end: string;
  source: PingHistoryPlan['source'];
};

/** 整窗 Ping 统计：与绘图桶同源（rollup 窗口读 rollup 统计，raw 窗口扫原始样本）。 */
export function loadPingWindowStats(
  database: db.QueryDatabase,
  query: PingStatsQuery,
): Promise<Record<string, PingTaskStats>> {
  const { uuid, taskIds, start, end, source } = query;
  if (source === 'rollup') {
    return db.getPingStatsFromRollupRange(database, uuid, taskIds, start, end)
      .catch(() => { throw new ReadUnavailableError(); });
  }
  return db.getPingStatsForTasksRange(database, uuid, taskIds, start, end)
    .catch(() => { throw new ReadUnavailableError(); });
}

export type HostHistoryQuery = {
  uuid: string;
  start: string;
  end: string;
  limit: number;
};

/**
 * 原生 `/api/records/load` 的有界窗口查询：按点预算分桶，并合并 raw/rollup。
 * monitor 的聚合桶走 `loadAggregatedHostHistory`（它要桶内均值/峰值而不是样本行）。
 */
export function loadHostHistory(
  database: db.QueryDatabase,
  query: HostHistoryQuery,
): Promise<MonitorRecord[]> {
  const { uuid, start, end, limit } = query;
  const rangeMs = Date.parse(end) - Date.parse(start);
  const bucketSec = Math.max(historyBucketSec(rangeMs) || 60,
    Math.ceil(rangeMs / 1000 / Math.max(1, limit - 1)));
  return db.getRecordsByTimeRangeBucketed(database, uuid, start, end, bucketSec, limit)
    .catch(() => { throw new ReadUnavailableError(); });
}

export type AggregatedHostHistoryQuery = {
  uuid: string;
  start: string;
  end: string;
  stepSec: number;
  limit: number;
  sampleSec: number;
};

/** monitor 的 host 历史：rollup + raw 按网格合并（桶内均值 + 峰值，含当前未满桶）。 */
export function loadAggregatedHostHistory(
  database: db.QueryDatabase,
  query: AggregatedHostHistoryQuery,
): Promise<MonitorMetricsBucket[]> {
  const { uuid, start, end, stepSec, limit, sampleSec } = query;
  return db.getRecordsByTimeRangeAggregated(database, uuid, start, end, stepSec, limit, sampleSec);
}
