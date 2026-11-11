/**
 * monitor 主题契约兼容层：把 cf-vps-monitor 的公开数据投影成 monitor hub 1.3.2
 * 认识的公开读接口形状。
 *
 * 契约与顺序以 monitor-probe/themes 的 `preview/hub.js` 为准（它与 hub 本体同步
 * 维护）。收录检查会把每个主题装进最新版 hub 再核对，所以只要这 5 个接口对得上，
 * 主题站里的主题就能直接装，不需要 fork。
 *
 * 这里实现读侧：`/me`（在 public.ts 上与后台会话形状合并）、`/nodes`、
 * `/nodes/:id/metrics`、`/themes/:short/config`。`/api/ws` 见阶段 4。
 *
 * 阶段说明：metrics 由 `cfm_records_range_aggregated` 提供封闭桶（桶内均值 +
 * 峰值 + 按落库间隔折算的 minutes），`day_*`/`total_*` 由 `cfm_traffic_totals`
 * 批量补齐，口径与 hub 对齐。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import type { LiveSnapshot } from '../utils/do-response';
import { readLiveSnapshot } from '../utils/do-response';
import type { PublicClient } from '../utils/public-client';
import type { MonitorTrafficTotals } from '../db/types';
import { readJsonWithLimit } from '../utils/request-body';
import {
  buildMonitorMetricsRows,
  buildMonitorNode,
  buildMonitorPingRows,
  buildMonitorProbes,
  monitorHours,
  monitorMetricsRateLimit,
  monitorNumericId,
  monitorNodeStatic,
  monitorStep,
  monitorTaskIds,
  monitorTasksForClient,
  monitorTrafficWithTotals,
  type MonitorNodeStatic,
} from '../utils/monitor-contract';
import {
  getPublicClientsSnapshot,
  guardMonitorMetrics,
  guardPublicMetadata,
  hasAdminSession,
} from './public';

type MonitorContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const HISTORY_BUCKET_LIMIT = 1500;
const PING_BUCKET_LIMIT = 1200;
const THEME_CONFIG_MAX_BYTES = 32 * 1024;
const THEME_CONFIG_SETTING_PREFIX = 'monitor_theme_config:';
// 历史桶在 10s 内不会变化（records 按 record_persist_interval_sec 批量落库），
// 而主题的实时视图是 5s 一轮、且延迟/丢包视图会按节点扇出请求。用一层进程内
// 缓存吸收同一 isolate 内的重复查询：同一节点的同一查询 10s 内最多触达一次
// 数据库，同一 NAT 后面的多个访客也能共享。
const MONITOR_HISTORY_CACHE_SECONDS = 10;
const MONITOR_HISTORY_CACHE_MAX_ENTRIES = 256;
const monitorHistoryCache = new Map<string, { value: unknown; expiresAt: number }>();

function monitorHistoryCacheGet(key: string): unknown {
  const entry = monitorHistoryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    monitorHistoryCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function monitorHistoryCacheSet(key: string, value: unknown): void {
  if (monitorHistoryCache.size >= MONITOR_HISTORY_CACHE_MAX_ENTRIES) {
    const oldestKey = monitorHistoryCache.keys().next().value;
    if (oldestKey) monitorHistoryCache.delete(oldestKey);
  }
  monitorHistoryCache.set(key, {
    value,
    expiresAt: Date.now() + MONITOR_HISTORY_CACHE_SECONDS * 1000,
  });
}

/** 测试用：清空进程内历史缓存。 */
export function clearMonitorHistoryCache(): void {
  monitorHistoryCache.clear();
}

// 最近一次公开快照里的节点数（进程内，随 /nodes 与 metrics 的查询一起刷新）。
// 历史限流额度按它放大：主题会按节点扇出请求，节点越多需要的额度越高。冷启动
// 时先按 0 走下限，第一次快照返回后就会校准。
let monitorKnownNodeCount = 0;

function monitorMetricsLimit(): number {
  return monitorMetricsRateLimit(monitorKnownNodeCount);
}

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

function jsonWithCache(c: MonitorContext, value: unknown, seconds: number): Response {
  c.header(
    'Cache-Control',
    seconds > 0 ? `public, max-age=${seconds}, s-maxage=${seconds}` : 'private, no-store',
  );
  return c.json(value);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readLive(c: MonitorContext): Promise<LiveSnapshot> {
  try {
    const response = await c.env.LIVE_DATA
      .get(c.env.LIVE_DATA.idFromName('global'))
      .fetch(new Request('https://do/live', { method: 'GET' }));
    return await readLiveSnapshot(response) ?? { online: [], count: 0 };
  } catch {
    return { online: [], count: 0 };
  }
}

function liveEntryFor(live: LiveSnapshot, uuid: string): Record<string, unknown> | null {
  return recordOrNull(live.data?.[uuid]) ?? recordOrNull(live.last_known?.[uuid]);
}

function numberFrom(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * 把 monitor 的「静态节点投影」推进 Durable Object，供 `/api/ws` 逐帧合并实时数据。
 * 推送是节流的：DO 的缓存过期与否由这里控制，不是每帧都写。
 *
 * 这里只推**公开**节点（`getPublicClientsSnapshot(..., includeHidden=false)`），
 * 且**不带 admin**：`admin` 是每个订阅者自己的身份，由 `/api/ws` 在建连时作为
 * 连接属性传给 DO。共享缓存里存一份 admin 位会被广播给所有访客。
 */
const MONITOR_META_PUSH_INTERVAL_MS = 30_000;
let monitorMetaPushedAt = 0;

export async function pushMonitorMetaToDo(
  c: MonitorContext,
  nodes: MonitorNodeStatic[],
): Promise<void> {
  const stub = c.env.LIVE_DATA.get(c.env.LIVE_DATA.idFromName('global'));
  await stub.fetch(new Request('https://do/monitor-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes }),
  }));
}

/** 节流后异步推送（不阻塞响应）。`force` 用于 WebSocket 建连：那一刻必须是最新的。 */
export function scheduleMonitorMetaPush(
  c: MonitorContext,
  clients: readonly PublicClient[],
  totals?: Record<string, MonitorTrafficTotals> | null,
  force = false,
): void {
  const now = Date.now();
  if (!force && now - monitorMetaPushedAt < MONITOR_META_PUSH_INTERVAL_MS) return;
  monitorMetaPushedAt = now;
  const nodes = clients.map(client => monitorNodeStatic(client, totals?.[client.uuid]));
  const task = pushMonitorMetaToDo(c, nodes).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // 无 ExecutionContext（本地/测试）时忽略。
  }
}

function siteUrl(c: MonitorContext): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

export const monitorCompatRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const startedAt = performance.now();
  const value = await work();
  return { ms: performance.now() - startedAt, value };
}

monitorCompatRoutes.get('/nodes', async (c) => {
  const startedAt = performance.now();
  const limited = await guardPublicMetadata(c, 'monitor-nodes');
  if (limited) return limited;
  const rateLimitMs = performance.now() - startedAt;

  const database = getDatabase(c.env);
  const [snapshotResult, liveResult, adminResult] = await Promise.all([
    timed(() => getPublicClientsSnapshot(c, database, false, false)),
    timed(() => readLive(c)),
    timed(() => hasAdminSession(c)),
  ]);
  const snapshot = snapshotResult.value;
  const live = liveResult.value;
  const admin = adminResult.value;

  const onlineSet = new Set(live.online);
  const nowMs = Date.now();
  monitorKnownNodeCount = snapshot.clients.length;
  // day_* / total_* 一次批量取；失败时退回 0，而不是让整个节点列表报错。
  const totalsLookup: db.TrafficTotalsLookup = {};
  const totalsResult = await timed(() => db.getTrafficTotals(
    database,
    snapshot.clients.map(client => client.uuid),
    totalsLookup,
  ).catch(() => ({} as Record<string, MonitorTrafficTotals>)));
  const totals = totalsResult.value;
  const nodes = [...snapshot.clients]
    .sort((left, right) => {
      const orderDiff = (left.sort_order || 0) - (right.sort_order || 0);
      return orderDiff !== 0 ? orderDiff : left.name.localeCompare(right.name);
    })
    .map((client: PublicClient) => {
      const entry = liveEntryFor(live, client.uuid);
      return buildMonitorNode({
        client,
        live: entry,
        online: onlineSet.has(client.uuid),
        lastReportMs: numberFrom(entry, 'lastReportTime'),
        traffic: monitorTrafficWithTotals(entry, totals[client.uuid]),
        nowMs,
        siteUrl: siteUrl(c),
      });
    });

  // 顺带刷新 DO 的静态缓存，让已连着的 /api/ws 客户端也能看到节点增删。
  scheduleMonitorMetaPush(c, snapshot.clients, totals);

  // 分段耗时放在响应头里，线上直接对 Network 面板就能定位慢在哪一段；
  // `traffic-totals` 的 desc 还顺手标出这次是否命中 10s 缓存。
  c.header('Server-Timing', [
    `rate-limit;dur=${rateLimitMs.toFixed(1)}`,
    `snapshot;dur=${snapshotResult.ms.toFixed(1)}`,
    `live;dur=${liveResult.ms.toFixed(1)}`,
    `admin;dur=${adminResult.ms.toFixed(1)}`,
    `traffic-totals;dur=${totalsResult.ms.toFixed(1)};desc="${totalsLookup.cached ? 'cache' : 'database'}"`,
    `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
  ].join(', '));

  // 含 admin 位的响应绝不能进共享缓存，否则访客可能拿到 admin:true。
  // The public theme home polls this endpoint while its store is hydrated.
  // Keep edge/browser caching short so a fresh Agent sample is not hidden
  // behind a stale nodes snapshot.
  return jsonWithCache(c, { admin, nodes }, admin ? 0 : 2);
});

// LuminaPlus' native theme-management page uses the hub's admin-only endpoint.
// Keep that behavior: task targets and node assignments are not public metadata.
monitorCompatRoutes.get('/ping-tasks', async (c) => {
  if (!await hasAdminSession(c)) return c.json({ error: 'Unauthorized' }, 401);
  const database = getDatabase(c.env);
  const [tasks, clients] = await Promise.all([db.listPingTasks(database), db.listClients(database)]);
  const nodeIds = new Map(clients.map(client => [client.uuid, monitorNumericId(client.uuid)]));
  return c.json({
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      target: task.target,
      interval: task.interval_sec,
      nodes: (task.all_clients ? clients.map(client => client.uuid) : task.clients)
        .map(uuid => nodeIds.get(uuid))
        .filter((id): id is number => typeof id === 'number'),
    })),
  }, 200, { 'Cache-Control': 'private, no-store' });
});

monitorCompatRoutes.get('/nodes/:id/metrics', async (c) => {
  const id = (c.req.param('id') || '').trim();
  if (!id) return c.json({ error: '缺少节点 id' }, 400);

  const limited = await guardMonitorMetrics(c, 'monitor-metrics', monitorMetricsLimit());
  if (limited) return limited;

  const database = getDatabase(c.env);
  const snapshot = await getPublicClientsSnapshot(c, database, false, false);
  monitorKnownNodeCount = snapshot.clients.length;
  // 契约里的 id 是整数，DB 主键是 UUID：按同一套哈希映射回来，避免把哈希值当
  // UUID 查库。
  const numericId = Number(id);
  const client = Number.isInteger(numericId)
    ? snapshot.clients.find(candidate => monitorNumericId(candidate.uuid) === numericId)
    : undefined;
  if (!client) {
    return jsonWithCache(c, { metrics: [], ping: [], step: 60, probes: {}, loss: {} }, 30);
  }
  const uuid = client.uuid;

  const hours = monitorHours(c.req.query('hours'));
  const step = monitorStep(hours, c.req.query('points'));
  const series = (c.req.query('series') || '').trim();

  const endMs = Date.now();
  // 与 hub 一致：窗口起点吸附到 step 网格，第一个点因此是完整桶。
  const endSec = Math.floor(endMs / 1000);
  const startSec = Math.floor((endSec - hours * 60 * 60) / step) * step;
  const start = new Date(startSec * 1000).toISOString();
  const end = new Date(endMs).toISOString();

  // 键里带 startSec：窗口起点一变（跨过 step 边界），旧桶自然失效。
  const allTasks = await db.listPingTasks(database).catch(() => []);
  const tasks = monitorTasksForClient(allTasks, uuid);
  const taskIds = monitorTaskIds(tasks);
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
  const cacheKey = `${uuid}|${hours}|${step}|${series}|${startSec}|${taskIds.join(',')}`;
  const cached = monitorHistoryCacheGet(cacheKey);
  if (cached !== undefined) return jsonWithCache(c, cached, MONITOR_HISTORY_CACHE_SECONDS);

  const sampleSec = await recordSampleSeconds(database);

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

  const metrics = series === 'ping' ? [] : buildMonitorMetricsRows(records, step);
  const { ping, loss } = series === 'metrics'
    ? { ping: [], loss: {} }
    : buildMonitorPingRows(byTask, step, taskOrder);
  const payload = {
    metrics,
    ping,
    step,
    probes: series === 'metrics' ? {} : buildMonitorProbes(tasks),
    loss,
  };
  monitorHistoryCacheSet(cacheKey, payload);
  return jsonWithCache(c, payload, MONITOR_HISTORY_CACHE_SECONDS);
});

monitorCompatRoutes.get('/themes/:short/config', async (c) => {
  const short = (c.req.param('short') || '').trim();
  if (!short) return jsonWithCache(c, {}, 60);

  const database = getDatabase(c.env);
  const saved = await db.getSetting(database, `${THEME_CONFIG_SETTING_PREFIX}${short}`).catch(() => null);
  if (saved !== null) {
    try {
      const config = recordOrNull(JSON.parse(saved));
      if (config && new TextEncoder().encode(JSON.stringify(config)).byteLength <= THEME_CONFIG_MAX_BYTES) {
        return jsonWithCache(c, config, 0);
      }
    } catch {
      // Ignore malformed stored values and fall back to the uploaded theme record.
    }
  }
  const theme = await db.getTheme(database, short).catch(() => null);
  if (!theme?.config_json) return jsonWithCache(c, {}, 60);

  let parsed: unknown;
  try {
    parsed = JSON.parse(theme.config_json);
  } catch {
    return jsonWithCache(c, {}, 60);
  }
  const config = recordOrNull(parsed);
  if (config && JSON.stringify(config).length > THEME_CONFIG_MAX_BYTES) {
    return jsonWithCache(c, {}, 60);
  }
  return jsonWithCache(c, config ?? {}, 60);
});

monitorCompatRoutes.put('/themes/:short/config', async (c) => {
  if (!await hasAdminSession(c)) return c.json({ error: 'Unauthorized' }, 401);

  const short = (c.req.param('short') || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(short)) return c.json({ error: '主题 ID 无效' }, 400);

  const parsed = await readJsonWithLimit(c.req.raw, THEME_CONFIG_MAX_BYTES);
  if (!parsed.ok) {
    return parsed.reason === 'too_large'
      ? c.json({ error: '主题配置过大' }, 413)
      : c.json({ error: '主题配置 JSON 格式错误' }, 400);
  }
  const config = recordOrNull(parsed.body);
  if (!config) return c.json({ error: '主题配置必须是 JSON 对象' }, 400);

  const serialized = JSON.stringify(config);
  if (new TextEncoder().encode(serialized).byteLength > THEME_CONFIG_MAX_BYTES) {
    return c.json({ error: '主题配置过大' }, 413);
  }
  await db.setSetting(getDatabase(c.env), `${THEME_CONFIG_SETTING_PREFIX}${short}`, serialized);
  return c.json({ success: true }, 200, { 'Cache-Control': 'no-store' });
});
