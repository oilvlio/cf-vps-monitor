/**
 * WebSocket routes for agent reports and live viewer snapshots.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { createViewerToken, verifyViewerToken } from '../auth/viewer-token';
import { getAgentClientIdentityByToken } from './client';
import { getCloudflareClientIp, isPublicIpAddress } from '../utils/request-ip';
import { readLiveSnapshot, readRateLimitResult } from '../utils/do-response';
import { hasAdminSession, getPublicClientsSnapshot, invalidatePublicMetadataCache } from './public';
import { pushMonitorMetaToDo } from './monitor-compat';
import { monitorNodeStatic } from '../utils/monitor-contract';
import { liveDataStub } from '../utils/live-data-object';
import { rateLimitStub } from '../utils/rate-limit-object';

const wsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type WsContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type CloudflareRequestMetadata = {
  city?: unknown;
  region?: unknown;
  country?: unknown;
};
const VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_TOKEN_RATE_LIMIT_MAX = 20;
const LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS = 60_000;
const LIVE_CLIENTS_RATE_LIMIT_MAX = 180;
const LIVE_CLIENTS_CACHE_SECONDS = 2;
const MONITOR_WS_RATE_LIMIT_WINDOW_MS = 60_000;
const MONITOR_WS_RATE_LIMIT_MAX = 30;
/**
 * 通行证有效期。刻意与 viewer 窗口解耦并保持很短——它只是"取证 → 建连"
 * 这一瞬间的一次性凭据，有效期越短，被截获后的可用窗口越小。
 * viewer 窗口另由 DO 依据 `live_poll_active_max_duration_sec` 决定。
 */
const VIEWER_TOKEN_TTL_MS = 60_000;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';
const LOCAL_WS_RATE_LIMIT_SWEEP_EVERY = 256;

let localWsRateLimitSweepCounter = 0;
const localWsRateLimitBuckets = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();

/**
 * 上一次成功推进 DO 的静态投影。快照与流量总量都带 isolate 缓存，命中时返回同一
 * 个对象引用；两者都没变就说明 DO 里的投影也是最新的，可以直接跳过这次写入，
 * 省掉 WS 建连路径上的一次 DO 往返（以及一次无意义的全量帧广播）。
 */
let lastMonitorMetaPush: {
  snapshot: Awaited<ReturnType<typeof getPublicClientsSnapshot>>;
  totals: Record<string, db.MonitorTrafficTotals>;
} | null = null;

export function invalidateLiveViewerSettingsCache(): void {
  // Kept for the settings save path; viewer tokens stay on the fast default.
}

function bearerToken(c: WsContext): string {
  const authHeader = c.req.header('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function requestHasValidOrigin(c: WsContext): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;

  try {
    const requestUrl = new URL(c.req.url);
    const originUrl = new URL(origin);
    return originUrl.protocol === requestUrl.protocol && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

function isWebSocketUpgrade(c: WsContext): boolean {
  return (c.req.header('Upgrade') || '').toLowerCase() === 'websocket';
}

function viewerTokenFromProtocol(c: WsContext): string {
  const protocols = (c.req.header('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean);
  const markerIndex = protocols.indexOf(LIVE_VIEWER_WS_PROTOCOL);
  return markerIndex >= 0 ? protocols[markerIndex + 1] || '' : '';
}

function requestIp(c: WsContext): string {
  return getCloudflareClientIp(c);
}

function requestRegion(c: WsContext): string {
  const cf = (c.req.raw as Request & { cf?: CloudflareRequestMetadata }).cf ?? {};
  return [cf.city, cf.region, cf.country || c.req.header('CF-IPCountry')]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ');
}

function isUnknownRegion(region: string): boolean {
  return /^(unknown|未知)$/i.test(region.trim());
}

function isCountryCodeRegion(region: string): boolean {
  return /^[A-Z]{2}$/i.test(region.trim());
}

function isDetailedRegion(region: string): boolean {
  const text = region.trim();
  return text !== '' && !isUnknownRegion(text) && !isCountryCodeRegion(text);
}

async function syncAgentNetworkMetadata(c: WsContext, client: db.ClientIdentity, patch: Partial<db.Client>): Promise<void> {
  const safePatch: Record<string, unknown> = { uuid: client.uuid, ...patch };
  if (typeof patch.ipv4 === 'string') {
    safePatch.has_ipv4 = patch.ipv4.trim() !== '';
  }
  if (typeof patch.ipv6 === 'string') {
    safePatch.has_ipv6 = patch.ipv6.trim() !== '';
  }
  const stub = liveDataStub(c.env.LIVE_DATA);
  await stub.fetch(new Request('https://do/client-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'agent',
      uuid: client.uuid,
      name: client.name || client.uuid,
      hidden: client.hidden,
      client: safePatch,
    }),
  })).catch(() => undefined);
}

function cleanupLocalWsRateLimitBuckets(nowMs: number): void {
  for (const [key, bucket] of localWsRateLimitBuckets) {
    if (bucket.resetAt <= nowMs || nowMs - bucket.lastSeenAt > VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS * 5) {
      localWsRateLimitBuckets.delete(key);
    }
  }
}

function wsRateLimitResponse(error: string, retryAfter: number, limit: number, remaining: number, noStore = false): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
  };
  if (noStore) headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify({ error }), { status: 429, headers });
}

function localWsRateLimit(
  c: WsContext,
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
  error: string,
  noStore = false,
): Response | null {
  const nowMs = Date.now();
  localWsRateLimitSweepCounter += 1;
  if (localWsRateLimitSweepCounter % LOCAL_WS_RATE_LIMIT_SWEEP_EVERY === 0) {
    cleanupLocalWsRateLimitBuckets(nowMs);
  }

  const key = `ws:${bucket}:${ip || 'unknown'}`;
  let state = localWsRateLimitBuckets.get(key);
  if (!state || state.resetAt <= nowMs) {
    state = { count: 0, resetAt: nowMs + windowMs, lastSeenAt: nowMs };
  }
  state.count += 1;
  state.lastSeenAt = nowMs;
  localWsRateLimitBuckets.set(key, state);

  const retryAfter = Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
  const remaining = Math.max(0, max - state.count);
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(remaining));
  if (state.count <= max) return null;
  return wsRateLimitResponse(error, retryAfter, max, remaining, noStore);
}

async function enforceWsRateLimit(
  c: WsContext,
  doName: string,
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
  error: string,
  noStore = false,
): Promise<Response | null> {
  try {
    const namespace = c.env.RATE_LIMIT;
    if (!namespace) return localWsRateLimit(c, bucket, ip, max, windowMs, error, noStore);
    const stub = rateLimitStub(namespace, doName);
    const response = await stub.fetch(new Request('https://do/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, ip, max, windowMs }),
    }));
    if (!response.ok) throw new Error(`DO rate limit HTTP ${response.status}`);
    const result = await readRateLimitResult(response, { limit: max, remaining: max });
    if (!result) throw new Error('DO rate limit returned an invalid response');
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return null;
    return wsRateLimitResponse(
      error,
      result.retryAfter,
      result.limit,
      result.remaining,
      noStore,
    );
  } catch {
    return localWsRateLimit(c, bucket, ip, max, windowMs, error, noStore);
  }
}

async function enforceViewerTokenRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  return enforceWsRateLimit(
    c,
    'viewer-token',
    'viewer-token',
    ip,
    VIEWER_TOKEN_RATE_LIMIT_MAX,
    VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS,
    'Too many live viewer token requests',
    true,
  );
}

async function enforceLiveClientsRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  return enforceWsRateLimit(
    c,
    'live-clients',
    'live-clients',
    ip,
    LIVE_CLIENTS_RATE_LIMIT_MAX,
    LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS,
    'Too many live clients requests',
    true,
  );
}

async function enforceMonitorWsRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  // 建连限流不要求跨机房强一致：本地计数即可省掉一次限流 DO 往返。
  return localWsRateLimit(
    c,
    'monitor-ws',
    ip,
    MONITOR_WS_RATE_LIMIT_MAX,
    MONITOR_WS_RATE_LIMIT_WINDOW_MS,
    'Too many monitor websocket connections',
  );
}

function jwtSecret(c: WsContext): string {
  return String(c.env.JWT_SECRET || '').trim();
}

wsRoutes.get('/clients/report', async (c) => {
  const token = bearerToken(c) || String(c.req.query('token') || '').trim();

  if (!token) {
    return c.json({ error: 'Missing token' }, 401);
  }

  const database = getDatabase(c.env);
  const client = await getAgentClientIdentityByToken(database, token, c.env, getCloudflareClientIp(c, ''));
  if (!client) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  const region = requestRegion(c);
  const sourceIp = getCloudflareClientIp(c, '');
  const sourceIpIsPublic = isPublicIpAddress(sourceIp);
  if (region) {
    const storedClient = await db.getClient(database, client.uuid);
    const patch: Partial<db.Client> = {};
    if (storedClient) {
      if (
        region &&
        (
          !storedClient.region ||
          isUnknownRegion(storedClient.region) ||
          (isCountryCodeRegion(storedClient.region) && isDetailedRegion(region))
        )
      ) {
        patch.region = region;
      }
      if (Object.keys(patch).length > 0) {
        await db.updateClient(database, client.uuid, patch);
        await syncAgentNetworkMetadata(c, client, patch);
        invalidatePublicMetadataCache();
      }
    }
  }

  if (!isWebSocketUpgrade(c)) {
    return c.json({ error: 'WebSocket upgrade required' }, 400);
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const stub = liveDataStub(c.env.LIVE_DATA);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', client.uuid);
  url.searchParams.set('name', client.name);
  url.searchParams.set('hidden', client.hidden ? '1' : '0');
  url.searchParams.set('role', 'agent');
  if (sourceIpIsPublic) url.searchParams.set('source_ip', sourceIp);
  if (region) url.searchParams.set('region', region);

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

/**
 * monitor 主题契约的实时通道：`{admin, nodes}` 全量帧，`?gzip` 发 gzip 二进制。
 *
 * 帧由 Durable Object 从内存里的静态投影 + 实时报告拼装（每帧不查库），推送节奏
 * 跟随 agent 上报（3–5s），而不是上游 hub 的 2s。普通 GET 按契约回 426。
 */
wsRoutes.get('/ws', async (c) => {
  if (!isWebSocketUpgrade(c)) {
    return c.text('需要 WebSocket', 426);
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }
  const limited = await enforceMonitorWsRateLimit(c, requestIp(c));
  if (limited) return limited;

  const gzip = c.req.query('gzip') !== undefined && c.req.query('gzip') !== '0';

  const database = getDatabase(c.env);
  const [admin, snapshot] = await Promise.all([
    hasAdminSession(c),
    getPublicClientsSnapshot(c, database, false, false),
  ]);

  // 建连时把静态投影推进 DO，保证首帧就是当前数据；之后只在 /api/nodes 被访问时
  // 节流刷新（节点增删），运行期每帧都不再查库。快照和流量都命中缓存时投影没有
  // 变化，跳过这次 DO 写入。
  try {
    const totals = await db.getTrafficTotals(database, snapshot.clients.map(client => client.uuid))
      .catch(() => ({} as Record<string, db.MonitorTrafficTotals>));
    const unchanged = lastMonitorMetaPush !== null
      && lastMonitorMetaPush.snapshot === snapshot
      && lastMonitorMetaPush.totals === totals;
    if (!unchanged) {
      await pushMonitorMetaToDo(
        c,
        snapshot.clients.map(client => monitorNodeStatic(client, totals[client.uuid])),
      );
      lastMonitorMetaPush = { snapshot, totals };
    }
  } catch {
    // DO 写失败不阻塞建连：旧缓存仍能出帧，下一次 /api/nodes 会刷新。
  }

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', 'monitor-' + crypto.randomUUID());
  url.searchParams.set('role', 'monitor');
  // admin 是每个连接自己的身份，不进共享 meta，避免访客被管理员的连接带成 admin。
  if (admin) url.searchParams.set('admin', '1');
  if (gzip) url.searchParams.set('gzip', '1');

  const stub = liveDataStub(c.env.LIVE_DATA);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/ws/live-token', async (c) => {
  const secret = jwtSecret(c);
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }

  const ip = requestIp(c);
  const limited = await enforceViewerTokenRateLimit(c, ip);
  if (limited) return limited;

  c.header('Cache-Control', 'no-store');
  return c.json(await createViewerToken({
    ip,
    secret,
    ttlMs: VIEWER_TOKEN_TTL_MS,
  }));
});

wsRoutes.get('/ws/live', async (c) => {
  if (!isWebSocketUpgrade(c)) {
    const stub = liveDataStub(c.env.LIVE_DATA);
    const url = new URL(c.req.url);
    const includeHidden = url.searchParams.get('include_hidden') === '1' && await hasAdminSession(c);
    if (includeHidden) url.searchParams.set('include_hidden', '1');
    else url.searchParams.delete('include_hidden');
    return stub.fetch(new Request(url.toString(), { method: 'GET' }));
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const viewerIp = requestIp(c);
  const viewerToken = viewerTokenFromProtocol(c);
  const secret = jwtSecret(c);
  if (!viewerToken) {
    return c.json({ error: 'Missing viewer token' }, 401);
  }
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }
  if (!await verifyViewerToken({ token: viewerToken, ip: viewerIp, secret })) {
    return c.json({ error: 'Invalid viewer token' }, 403);
  }

  const stub = liveDataStub(c.env.LIVE_DATA);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', 'frontend-' + crypto.randomUUID());
  url.searchParams.set('role', 'viewer');
  // 不再传 viewer_ttl_ms：窗口交由 DO 依据自己已缓存的设置决定。
  url.searchParams.set('viewer_ip', viewerIp);
  if (includeHidden) url.searchParams.set('include_hidden', '1');

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/live/clients', async (c) => {
  const startedAt = performance.now();
  const limited = await enforceLiveClientsRateLimit(c, requestIp(c));
  const rateLimitMs = performance.now() - startedAt;
  if (limited) return limited;
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);

  const stub = liveDataStub(c.env.LIVE_DATA);

  const liveStarted = performance.now();
  const response = await stub.fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`, { method: 'GET' }));
  const snapshot = await readLiveSnapshot(response) ?? { online: [], count: 0 };
  const liveMs = performance.now() - liveStarted;
  c.header('Cache-Control', includeHidden ? 'no-store' : `public, max-age=${LIVE_CLIENTS_CACHE_SECONDS}, s-maxage=${LIVE_CLIENTS_CACHE_SECONDS}, stale-while-revalidate=${LIVE_CLIENTS_CACHE_SECONDS * 2}`);
  c.header('Server-Timing', [
    `rate-limit;dur=${rateLimitMs.toFixed(1)}`,
    `live;dur=${liveMs.toFixed(1)}`,
    `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
  ].join(', '));
  return c.json(snapshot);
});

export { wsRoutes };
