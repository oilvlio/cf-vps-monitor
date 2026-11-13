/**
 * /api/nodes/:id/metrics 的数据装配：节点查找、任务/落库间隔元数据、聚合历史。
 * 路由只负责参数解析、限流、内存/边缘缓存与响应头。
 */
import * as db from '../../db/queries';
import type { PublicClient } from '../../utils/public-client';
import {
  buildMonitorMetricsRows,
  buildMonitorPingRows,
  buildMonitorProbes,
  monitorNumericId,
  monitorTaskIds,
  monitorTasksForClient,
  type MonitorMetricsRow,
  type MonitorPingRow,
} from '../contract';
import { TtlCache } from '../cache/ttl-cache';

/** 契约里的 id 是整数哈希：按同一套映射把路径参数还原成节点。 */
export function findMonitorClient(
  clients: readonly PublicClient[],
  idText: string,
): PublicClient | undefined {
  const numericId = Number(idText);
  if (!Number.isInteger(numericId)) return undefined;
  return clients.find(candidate => monitorNumericId(candidate.uuid) === numericId);
}

export type MonitorMetricsPayload = {
  metrics: MonitorMetricsRow[];
  ping: MonitorPingRow[];
  step: number;
  probes: Record<string, string>;
  loss: Record<string, number>;
};

// records 的落库间隔来自后台设置（record_persist_interval_sec，默认 120s）；
// 一条记录代表这段时间的数据，metrics 的 minutes 需要它才能折算准确。
const RECORD_SAMPLE_SETTING_KEY = 'record_persist_interval_sec';
const DEFAULT_RECORD_SAMPLE_SEC = 120;
const MIN_RECORD_SAMPLE_SEC = 3;
const MAX_RECORD_SAMPLE_SEC = 3600;

async function recordSampleSeconds(database: db.QueryDatabase): Promise<number> {
  try {
    const settings = await db.getSettingsByKeys(database, [RECORD_SAMPLE_SETTING_KEY]);
    const value = Number(settings[RECORD_SAMPLE_SETTING_KEY]);
    if (!Number.isFinite(value)) return DEFAULT_RECORD_SAMPLE_SEC;
    return Math.min(MAX_RECORD_SAMPLE_SEC, Math.max(MIN_RECORD_SAMPLE_SEC, Math.floor(value)));
  } catch {
    return DEFAULT_RECORD_SAMPLE_SEC;
  }
}

// ping 任务列表和落库间隔很少变化，但每次 metrics 都会各查一次 Supabase。按
// isolate 缓存 30 秒，热路径上就能和区间查询并行、只留一次真正的数据库往返。
const MONITOR_METRICS_META_CACHE_MS = 30_000;
const METRICS_META_CACHE_KEY = 'value';
const monitorPingTasksCache = new TtlCache<Awaited<ReturnType<typeof db.listPingTasks>>>(
  MONITOR_METRICS_META_CACHE_MS,
  1,
);
const monitorRecordSampleCache = new TtlCache<number>(MONITOR_METRICS_META_CACHE_MS, 1);

/** 测试用：清空 metrics 的元数据缓存。 */
export function clearMetricsMetaCache(): void {
  monitorPingTasksCache.clear();
  monitorRecordSampleCache.clear();
}

async function cachedPingTasks(
  database: db.QueryDatabase,
): Promise<{ tasks: Awaited<ReturnType<typeof db.listPingTasks>>; hit: boolean }> {
  const cached = monitorPingTasksCache.get(METRICS_META_CACHE_KEY);
  if (cached !== undefined) return { tasks: cached, hit: true };
  const tasks = await db.listPingTasks(database).catch(() => []);
  monitorPingTasksCache.set(METRICS_META_CACHE_KEY, tasks);
  return { tasks, hit: false };
}

async function cachedRecordSampleSeconds(
  database: db.QueryDatabase,
): Promise<{ value: number; hit: boolean }> {
  const cached = monitorRecordSampleCache.get(METRICS_META_CACHE_KEY);
  if (cached !== undefined) return { value: cached, hit: true };
  const value = await recordSampleSeconds(database);
  monitorRecordSampleCache.set(METRICS_META_CACHE_KEY, value);
  return { value, hit: false };
}

const HISTORY_BUCKET_LIMIT = 1500;
const PING_BUCKET_LIMIT = 1200;

export type LoadMetricsArgs = {
  start: string;
  end: string;
  step: number;
  series: string;
};

export type LoadMetricsResult = {
  payload: MonitorMetricsPayload;
  metaMs: number;
  queryMs: number;
  metaCacheHit: boolean;
};

export async function loadMonitorMetrics(
  database: db.QueryDatabase,
  uuid: string,
  args: LoadMetricsArgs,
): Promise<LoadMetricsResult> {
  const { start, end, step, series } = args;

  // 任务列表与落库间隔互不依赖，并行取；命中 30 秒缓存时不再触达数据库。
  const metaAt = performance.now();
  const [pingTasksResult, sampleResult] = await Promise.all([
    cachedPingTasks(database),
    cachedRecordSampleSeconds(database),
  ]);
  const metaMs = performance.now() - metaAt;
  const tasks = monitorTasksForClient(pingTasksResult.tasks, uuid);
  const taskIds = monitorTaskIds(tasks);
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
  const sampleSec = sampleResult.value;

  const queryAt = performance.now();
  const [records, byTask] = await Promise.all([
    series === 'ping'
      ? Promise.resolve([])
      : db.getRecordsByTimeRangeAggregated(
        database, uuid, start, end, step, HISTORY_BUCKET_LIMIT, sampleSec,
      ).catch(() => []),
    series === 'metrics' || taskIds.length === 0
      ? Promise.resolve({})
      : db.getPingRecordsForTasksRangeBucketed(database, uuid, taskIds, start, end, step, PING_BUCKET_LIMIT)
        .catch(() => ({} as Record<string, never[]>)),
  ]);
  const queryMs = performance.now() - queryAt;

  const metrics = series === 'ping' ? [] : buildMonitorMetricsRows(records, step);
  const { ping, loss } = series === 'metrics'
    ? { ping: [], loss: {} }
    : buildMonitorPingRows(byTask, step, taskOrder);

  return {
    payload: {
      metrics,
      ping,
      step,
      probes: series === 'metrics' ? {} : buildMonitorProbes(tasks),
      loss,
    },
    metaMs,
    queryMs,
    metaCacheHit: pingTasksResult.hit && sampleResult.hit,
  };
}
