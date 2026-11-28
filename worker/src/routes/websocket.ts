/**
 * 前端与 monitor 主题的实时通道。
 *
 * Agent 的上报 WebSocket（`/api/clients/report`）归 `routes/client.ts`，这里只保留
 * 前端 viewer、monitor 帧与公开实时快照。两边的入口分开后，调整前端实时协议不会
 * 牵动 Agent 的上报通道（反之亦然）；Upgrade/Origin 这类纯判定放在
 * `utils/websocket-request.ts`，不靠路由模块互相 import 复用。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import { createViewerToken, verifyViewerToken } from '../auth/viewer-token';
import { getCloudflareClientIp } from '../utils/request-ip';
import { guardPublicLive, hasAdminSession } from './public';
import { liveDataStub } from '../utils/live-data-object';
import { isWebSocketUpgrade, requestHasValidOrigin } from '../utils/websocket-request';
import { loadLiveSnapshot } from '../services/read/live';
import { readFailureResponse } from '../services/read/failure';
import { checkNativeRateLimit } from '../utils/native-rate-limit';
import { getAdminSessionToken } from '../auth/session';

const wsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
wsRoutes.onError(readFailureResponse);
type WsContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_TOKEN_RATE_LIMIT_MAX = 20;
const LIVE_CLIENTS_CACHE_SECONDS = 2;
const MONITOR_WS_RATE_LIMIT_WINDOW_MS = 60_000;
const MONITOR_WS_RATE_LIMIT_MAX = 30;
/**
 * 通行证有效期。刻意与 viewer 窗口解耦并保持很短——它只是"取证 → 建连"
 * 这一瞬间的一次性凭据，有效期越短，被截获后的可用窗口越小。
 * 它不限制已建立连接的寿命；`live_poll_active_max_duration_sec` 只用于最后离开后的上报宽限期。
 */
const VIEWER_TOKEN_TTL_MS = 60_000;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';
const LOCAL_WS_RATE_LIMIT_SWEEP_EVERY = 256;

let localWsRateLimitSweepCounter = 0;
const localWsRateLimitBuckets = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();

export function invalidateLiveViewerSettingsCache(): void {
  // Kept for the settings save path; viewer tokens stay on the fast default.
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
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
  error: string,
  noStore = false,
): Promise<Response | null> {
  const check = await checkNativeRateLimit(c.env, bucket, ip, max);
  if (check.outcome === 'allowed') return null;
  if (check.outcome === 'limited') {
    return wsRateLimitResponse(error, Math.ceil(windowMs / 1000), max, 0, noStore);
  }
  return localWsRateLimit(c, bucket, ip, max, windowMs, error, noStore);
}

async function enforceViewerTokenRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  return enforceWsRateLimit(
    c,
    'viewer-token',
    ip,
    VIEWER_TOKEN_RATE_LIMIT_MAX,
    VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS,
    'Too many live viewer token requests',
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

/**
 * monitor 主题契约的实时通道：`{admin, nodes}` 全量帧，`?gzip` 发 gzip 二进制。
 *
 * 帧由 Durable Object 从内存里的静态投影 + 实时报告拼装（每帧不查库），按配置的
 * live_poll_active_interval_sec 合并错峰到达的上报。普通 GET 按契约回 426。
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

  // DO 自己从 admin 元数据/数据库派生 monitor 静态投影，路由只负责身份转发。
  const admin = await hasAdminSession(c);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', 'monitor-' + crypto.randomUUID());
  url.searchParams.set('role', 'monitor');
  url.searchParams.set('viewer_ip', requestIp(c));
  // admin 是每个连接自己的身份，不进共享 meta，避免访客被管理员的连接带成 admin。
  if (admin) url.searchParams.set('admin', '1');
  if (gzip) url.searchParams.set('gzip', '1');

  const stub = liveDataStub(c.env.LIVE_DATA);
  const forwarded = new Request(url.toString(), c.req.raw);
  forwarded.headers.delete('X-CF-Monitor-Admin-Token');
  if (admin) forwarded.headers.set('X-CF-Monitor-Admin-Token', getAdminSessionToken(c) || '');
  return stub.fetch(forwarded);
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
    const limited = await guardPublicLive(c);
    if (limited) return limited;
    const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
    const snapshot = await loadLiveSnapshot(c.env, includeHidden);
    return c.json(snapshot, 200, { 'Cache-Control': 'no-store' });
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
  // 观看连接不设置绝对期限；DO 在最后一个连接离开后按配置保持快速上报。
  url.searchParams.set('viewer_ip', viewerIp);
  if (includeHidden) url.searchParams.set('include_hidden', '1');

  const forwarded = new Request(url.toString(), c.req.raw);
  forwarded.headers.delete('X-CF-Monitor-Admin-Token');
  if (includeHidden) forwarded.headers.set('X-CF-Monitor-Admin-Token', getAdminSessionToken(c) || '');
  return stub.fetch(forwarded);
});

wsRoutes.get('/live/clients', async (c) => {
  const startedAt = performance.now();
  const limited = await guardPublicLive(c);
  const rateLimitMs = performance.now() - startedAt;
  if (limited) return limited;
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);

  const liveStarted = performance.now();
  const snapshot = await loadLiveSnapshot(c.env, includeHidden);
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
