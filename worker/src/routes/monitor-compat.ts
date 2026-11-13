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
import { createAnonEdgeCache } from '../monitor/cache/edge-cache';
import { TtlCache } from '../monitor/cache/ttl-cache';
import { loadMonitorMetrics, clearMetricsMetaCache, findMonitorClient } from '../monitor/services/metrics';
import { loadNodes, type MonitorContext } from '../monitor/services/nodes';
import {
  loadThemeConfig,
  THEME_CONFIG_MAX_BYTES,
  THEME_CONFIG_SETTING_PREFIX,
} from '../monitor/services/theme-config';
import { recordOrNull } from '../monitor/services/json';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { getAdminSessionToken } from '../auth/session';
import { readJsonWithLimit } from '../utils/request-body';
import {
  monitorHours,
  monitorMetricsRateLimit,
  monitorNumericId,
  monitorStep,
} from '../monitor/contract';
import {
  getPublicClientsSnapshot,
  guardMonitorMetrics,
  guardPublicMetadata,
  hasAdminSession,
} from './public';

/** 测试用：清空 metrics 的元数据缓存（实现已搬到 services/metrics）。 */
export { clearMetricsMetaCache as clearMonitorMetricsMetaCache };

// 主题配置只在管理员保存时变化；按 isolate 缓存 5 秒，避免每次页面加载都查一次
// Supabase。GET 仍然 no-store，管理员保存后会主动清掉本地缓存。
const THEME_CONFIG_CACHE_MS = 5_000;
const themeConfigCache = new TtlCache<Record<string, unknown>>(THEME_CONFIG_CACHE_MS, 64);

/** 测试和保存路径用：清掉一个（或全部）主题配置缓存。 */
export function clearThemeConfigCache(short?: string): void {
  if (short) themeConfigCache.delete(short);
  else themeConfigCache.clear();
}

// 历史桶在 10s 内不会变化（records 按 record_persist_interval_sec 批量落库），
// 而主题的实时视图是 5s 一轮、且延迟/丢包视图会按节点扇出请求。用一层进程内
// 缓存吸收同一 isolate 内的重复查询：同一节点的同一查询 10s 内最多触达一次
// 数据库，同一 NAT 后面的多个访客也能共享。
const MONITOR_HISTORY_CACHE_SECONDS = 10;
const MONITOR_HISTORY_CACHE_MAX_ENTRIES = 256;
const monitorHistoryCache = new TtlCache<unknown>(
  MONITOR_HISTORY_CACHE_SECONDS * 1000,
  MONITOR_HISTORY_CACHE_MAX_ENTRIES,
);

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

function jsonWithCache(c: MonitorContext, value: unknown, seconds: number): Response {
  c.header(
    'Cache-Control',
    seconds > 0 ? `public, max-age=${seconds}, s-maxage=${seconds}` : 'private, no-store',
  );
  return c.json(value);
}

// 匿名访客的 /api/nodes 边缘缓存：命中时整条链路（限流 + LIVE_DATA DO + Supabase）
// 都可以跳过。实时数字由 WebSocket 推送，几秒的静态元数据滞后对首页没有影响。
const NODES_ANON_CACHE_SECONDS = 4;
const NODES_CACHE_HEADER = 'X-CF-VPS-Monitor-Nodes-Cache';
const NODES_CACHED_AT_HEADER = 'X-CF-VPS-Monitor-Nodes-Cached-At';
const anonNodesEdgeCache = createAnonEdgeCache({
  seconds: NODES_ANON_CACHE_SECONDS,
  header: NODES_CACHE_HEADER,
  cachedAtHeader: NODES_CACHED_AT_HEADER,
});

/** 固定缓存键：主题会在 URL 上带随机 query 绕过浏览器缓存，不能让它切碎边缘缓存。 */
function anonNodesCacheRequest(c: MonitorContext): Request {
  return new Request(new URL('/api/nodes', c.req.url).toString(), { method: 'GET' });
}

function waitUntilFrom(c: MonitorContext): ((task: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return ctx?.waitUntil ? (task: Promise<unknown>) => ctx.waitUntil(task) : undefined;
  } catch {
    // 无 ExecutionContext（本地/测试）时退化为直接等待。
    return undefined;
  }
}

// 匿名访客的历史曲线边缘缓存：主题在 /traffic 与详情页会按节点扇出请求，同一
// 数据中心里第二个访客起直接命中。键只保留 hours/step/series，忽略主题加上的
// 随机 query，避免把同一份数据切成无数份。
const METRICS_ANON_CACHE_SECONDS = 10;
const METRICS_CACHE_HEADER = 'X-CF-VPS-Monitor-Metrics-Cache';
const METRICS_CACHED_AT_HEADER = 'X-CF-VPS-Monitor-Metrics-Cached-At';
const anonMetricsEdgeCache = createAnonEdgeCache({
  seconds: METRICS_ANON_CACHE_SECONDS,
  header: METRICS_CACHE_HEADER,
  cachedAtHeader: METRICS_CACHED_AT_HEADER,
});

function anonMetricsCacheRequest(
  c: MonitorContext,
  id: string,
  hours: number,
  step: number,
  series: string,
): Request {
  const url = new URL(`/api/nodes/${encodeURIComponent(id)}/metrics`, c.req.url);
  url.search = '';
  url.searchParams.set('hours', String(hours));
  url.searchParams.set('step', String(step));
  url.searchParams.set('series', series);
  return new Request(url.toString(), { method: 'GET' });
}

export const monitorCompatRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

monitorCompatRoutes.get('/nodes', async (c) => {
  const startedAt = performance.now();
  // 只有匿名访客能共享边缘缓存。带管理员会话的请求要保留 admin 位，必须绕过
  // 缓存直达数据层。缓存命中时连限流一起跳过：命中本身不产生 DO/Supabase 成本。
  const anonymous = !getAdminSessionToken(c);
  if (anonymous) {
    const cached = await anonNodesEdgeCache.get(anonNodesCacheRequest(c));
    if (cached) return cached;
  }

  // 限流现在走 Rate Limiting 绑定（本地计数，约 0ms），所以先挡超限请求再取数：
  // 被限流的请求不会再去读 LIVE_DATA DO，也不会触发管理员校验。
  const rateLimitStarted = performance.now();
  const limited = await guardPublicMetadata(c, 'monitor-nodes');
  if (limited) return limited;
  const rateLimitMs = performance.now() - rateLimitStarted;

  const database = getDatabase(c.env);
  const loaded = await loadNodes(c, database);
  const { admin, clients: snapshotClients, nodes } = loaded;
  monitorKnownNodeCount = snapshotClients.length;

  // 分段耗时放在响应头里，线上直接对 Network 面板就能定位慢在哪一段；
  // `traffic-totals` 的 desc 还顺手标出这次是否命中 10s 缓存。
  c.header('Server-Timing', [
    `rate-limit;dur=${rateLimitMs.toFixed(1)}`,
    `snapshot;dur=${loaded.timings.snapshot.toFixed(1)}`,
    `live;dur=${loaded.timings.live.toFixed(1)}`,
    `admin;dur=${loaded.timings.admin.toFixed(1)}`,
    `traffic-totals;dur=${loaded.timings.totals.toFixed(1)};desc="${loaded.totalsCacheHit ? 'cache' : 'database'}"`,
    `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
  ].join(', '));

  // 含 admin 位的响应绝不能进共享缓存，否则访客可能拿到 admin:true。
  // The public theme home polls this endpoint while its store is hydrated.
  // Keep edge/browser caching short so a fresh Agent sample is not hidden
  // behind a stale nodes snapshot.
  if (!anonymous || admin) return jsonWithCache(c, { admin, nodes }, 0);
  // 匿名访客的浏览器缓存与边缘缓存用同一个 TTL，保证 preload 的响应能被主题复用。
  c.header(NODES_CACHE_HEADER, 'miss');
  const response = jsonWithCache(c, { admin, nodes }, NODES_ANON_CACHE_SECONDS);
  anonNodesEdgeCache.put(waitUntilFrom(c), anonNodesCacheRequest(c), response);
  return response;
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

  const hours = monitorHours(c.req.query('hours'));
  const step = monitorStep(hours, c.req.query('points'));
  const series = (c.req.query('series') || '').trim();

  // 匿名请求先看边缘缓存；管理员会话可能带额外可见性，不读写共享缓存。
  const anonymous = !(await hasAdminSession(c));
  const metricsCacheRequest = anonymous
    ? anonMetricsCacheRequest(c, id, hours, step, series)
    : null;
  if (metricsCacheRequest) {
    const cached = await anonMetricsEdgeCache.get(metricsCacheRequest);
    if (cached) return cached;
  }

  const startedAt = performance.now();
  const limited = await guardMonitorMetrics(c, 'monitor-metrics', monitorMetricsLimit());
  const rateLimitMs = performance.now() - startedAt;
  if (limited) return limited;

  const snapshotAt = performance.now();
  const database = getDatabase(c.env);
  const snapshot = await getPublicClientsSnapshot(c, database, false, false);
  const snapshotMs = performance.now() - snapshotAt;
  monitorKnownNodeCount = snapshot.clients.length;
  // 契约里的 id 是整数，DB 主键是 UUID：按同一套哈希映射回来，避免把哈希值当
  // UUID 查库。
  const client = findMonitorClient(snapshot.clients, id);
  if (!client) {
    const response = jsonWithCache(c, { metrics: [], ping: [], step: 60, probes: {}, loss: {} }, 30);
    if (metricsCacheRequest) anonMetricsEdgeCache.put(waitUntilFrom(c), metricsCacheRequest, response);
    return response;
  }
  const uuid = client.uuid;

  const endMs = Date.now();
  // 与 hub 一致：窗口起点吸附到 step 网格，第一个点因此是完整桶。
  const endSec = Math.floor(endMs / 1000);
  const startSec = Math.floor((endSec - hours * 60 * 60) / step) * step;
  const start = new Date(startSec * 1000).toISOString();
  const end = new Date(endMs).toISOString();

  // 键里带 startSec：窗口起点一变（跨过 step 边界），旧桶自然失效。任务列表
  // 不放进键里：它在 30 秒缓存内基本不变，提前命中比多查一次 Supabase 划算。
  const cacheKey = `${uuid}|${hours}|${step}|${series}|${startSec}`;
  const cached = monitorHistoryCache.get(cacheKey);
  if (cached !== undefined) {
    c.header('Server-Timing', [
      `rate-limit;dur=${rateLimitMs.toFixed(1)}`,
      `snapshot;dur=${snapshotMs.toFixed(1)}`,
      'history;desc="memory";dur=0',
      `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
    ].join(', '));
    const response = jsonWithCache(c, cached, MONITOR_HISTORY_CACHE_SECONDS);
    if (metricsCacheRequest) anonMetricsEdgeCache.put(waitUntilFrom(c), metricsCacheRequest, response);
    return response;
  }

  // 任务列表、落库间隔与区间历史都由 services/metrics 装配。
  const loaded = await loadMonitorMetrics(database, uuid, { start, end, step, series });
  const payload = loaded.payload;
  monitorHistoryCache.set(cacheKey, payload);
  c.header('Server-Timing', [
    `rate-limit;dur=${rateLimitMs.toFixed(1)}`,
    `snapshot;dur=${snapshotMs.toFixed(1)}`,
    `meta;dur=${loaded.metaMs.toFixed(1)};desc="${loaded.metaCacheHit ? 'cache' : 'database'}"`,
    `query;dur=${loaded.queryMs.toFixed(1)}`,
    `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
  ].join(', '));
  const response = jsonWithCache(c, payload, MONITOR_HISTORY_CACHE_SECONDS);
  if (metricsCacheRequest) anonMetricsEdgeCache.put(waitUntilFrom(c), metricsCacheRequest, response);
  return response;
});

monitorCompatRoutes.get('/themes/:short/config', async (c) => {
  const short = (c.req.param('short') || '').trim();
  if (!short) return jsonWithCache(c, {}, 60);

  let config = themeConfigCache.get(short);
  if (config === undefined) {
    config = await loadThemeConfig(getDatabase(c.env), short);
    themeConfigCache.set(short, config);
  }
  return jsonWithCache(c, config, 0);
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
  clearThemeConfigCache(short);
  // 主题当前只检查 PUT 状态码、不读响应体；把新配置带回来是为了让其他客户端
  // （或以后版本的主题）保存后立刻用上新值，而不必等 5 秒缓存过期。
  return c.json({ success: true, config }, 200, { 'Cache-Control': 'no-store' });
});
