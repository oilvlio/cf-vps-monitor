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
  type MonitorPingWindowStats,
} from '../contract';
import { resolveHistoryWindow } from '../../utils/history-bucket';
import { loadAggregatedHostHistory, loadPingHistory, loadPingWindowStats } from '../../services/read/history';
import { TtlCache } from '../cache/ttl-cache';
import { ReadUnavailableError } from '../../services/read/failure';

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

type HistorySettings = { sampleSec: number; hostHours: number; pingHours: number };

async function recordSampleSeconds(database: db.QueryDatabase): Promise<HistorySettings> {
  try {
    const settings = await db.getSettingsByKeys(database, [RECORD_SAMPLE_SETTING_KEY, 'record_preserve_time', 'ping_record_preserve_time']);
    const value = Number(settings[RECORD_SAMPLE_SETTING_KEY]);
    const hours = (key: string) => {
      const value = Number(settings[key]);
      return Number.isFinite(value) && value > 0 ? Math.min(720, Math.max(48, Math.floor(value))) : 168;
    };
    return {
      sampleSec: Number.isFinite(value) ? Math.min(MAX_RECORD_SAMPLE_SEC, Math.max(MIN_RECORD_SAMPLE_SEC, Math.floor(value))) : DEFAULT_RECORD_SAMPLE_SEC,
      hostHours: hours('record_preserve_time'), pingHours: hours('ping_record_preserve_time'),
    };
  } catch {
    throw new ReadUnavailableError();
  }
}

// ping 任务列表和落库间隔很少变化，但每次 metrics 都会各查一次 Supabase。按
// isolate 缓存 30 秒，热路径上就能和区间查询并行、只留一次真正的数据库往返。
const MONITOR_METRICS_META_CACHE_MS = 30_000;
const MONITOR_HISTORY_SETTINGS_CACHE_MS = 5_000;
const METRICS_META_CACHE_KEY = 'value';
const monitorPingTasksCache = new TtlCache<Awaited<ReturnType<typeof db.listPingTasks>>>(
  MONITOR_METRICS_META_CACHE_MS,
  1,
);
const monitorRecordSampleCache = new TtlCache<HistorySettings>(MONITOR_HISTORY_SETTINGS_CACHE_MS, 1);

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
  const tasks = await db.listPingTasks(database).catch(() => { throw new ReadUnavailableError(); });
  monitorPingTasksCache.set(METRICS_META_CACHE_KEY, tasks);
  return { tasks, hit: false };
}

async function cachedRecordSampleSeconds(
  database: db.QueryDatabase,
): Promise<{ value: HistorySettings; hit: boolean }> {
  const cached = monitorRecordSampleCache.get(METRICS_META_CACHE_KEY);
  if (cached !== undefined) return { value: cached, hit: true };
  const value = await recordSampleSeconds(database);
  monitorRecordSampleCache.set(METRICS_META_CACHE_KEY, value);
  return { value, hit: false };
}

const HISTORY_BUCKET_LIMIT = 1500;
// 分桶 RPC 的上限必须覆盖 monitor 的点预算（1440）+ 窗口两端的边界桶。
// SQL 侧的 safe_limit 同步放宽到 2000；两边改一处时必须同时改另一处，否则
// 绘图桶会被静默截断，窗口丢包率也会只覆盖被返回的那一段。
const PING_BUCKET_LIMIT = 2000;

type MonitorPingWindowStatsMap = Record<string, MonitorPingWindowStats>;

// loadPingWindowStats 见 services/read/history：与原生 /records/ping/stats 共用
// 同一套 raw/rollup 选择。失败向上传递，不能用绘图点估算完整窗口。

export type LoadMetricsArgs = {
  start: string;
  end: string;
  step: number;
  series: string;
  /** Nominal range before the route snaps the start to the output grid. */
  rangeMs?: number;
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
  const { start, end, series } = args;

  // 任务列表与落库间隔互不依赖，并行取；命中 30 秒缓存时不再触达数据库。
  const metaAt = performance.now();
  const [pingTasksResult, sampleResult] = await Promise.all([
    series === 'metrics' ? Promise.resolve({ tasks: [], hit: true }) : cachedPingTasks(database),
    cachedRecordSampleSeconds(database),
  ]);
  const metaMs = performance.now() - metaAt;
  const tasks = monitorTasksForClient(pingTasksResult.tasks, uuid);
  const taskIds = monitorTaskIds(tasks);
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
  const sampleSec = sampleResult.value.sampleSec;
  const rangeMs = args.rangeMs ?? Date.parse(end) - Date.parse(start);
  const endMs = Date.parse(end);
  const pingPlan = resolveHistoryWindow(rangeMs, args.step, sampleResult.value.pingHours, endMs).plan;
  const hostPlan = resolveHistoryWindow(rangeMs, args.step, sampleResult.value.hostHours, endMs).plan;
  const step = Math.max(args.step,
    series === 'metrics' ? hostPlan.stepSec : series === 'ping' ? pingPlan.stepSec
      : Math.max(hostPlan.stepSec, pingPlan.stepSec));
  // Mixed windows must query both series on the step advertised in the response.
  // Different raw-retention cutoffs can resolve to different plans; leaving Ping
  // on its finer plan would create duplicate timestamps after projection snaps it
  // to the host grid.
  const pingQueryPlan = { ...pingPlan, stepSec: step };
  const endSec = Math.floor(Date.parse(end) / 1000);
  const queryStart = step === args.step
    ? start
    : new Date(Math.floor((endSec - rangeMs / 1000) / step) * step * 1000).toISOString();

  const queryAt = performance.now();
  const windowStatsPromise = series === 'metrics' || taskIds.length === 0
    ? Promise.resolve(null)
    : loadPingWindowStats(database, { uuid, taskIds, start: queryStart, end, source: pingPlan.source })
      .catch(() => { throw new ReadUnavailableError(); }) as Promise<MonitorPingWindowStatsMap | null>;
  const [records, byTask, windowStats] = await Promise.all([
    series === 'ping'
      ? Promise.resolve([])
      : loadAggregatedHostHistory(database, {
        uuid, start: queryStart, end, stepSec: step, limit: HISTORY_BUCKET_LIMIT, sampleSec,
      }).catch(() => { throw new ReadUnavailableError(); }),
    series === 'metrics' || taskIds.length === 0
      ? Promise.resolve({})
      : loadPingHistory(database, {
        uuid, taskIds, start: queryStart, end, limit: PING_BUCKET_LIMIT, plan: pingQueryPlan,
      }).catch(() => { throw new ReadUnavailableError(); }),
    windowStatsPromise,
  ]);
  const queryMs = performance.now() - queryAt;

  const metrics = series === 'ping' ? [] : buildMonitorMetricsRows(records, step);
  const { ping, loss } = series === 'metrics'
    ? { ping: [], loss: {} }
    : buildMonitorPingRows(byTask, step, taskOrder, windowStats);

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
