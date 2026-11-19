/**
 * /api/nodes 的数据装配：公开节点快照 + LIVE_DATA 实时条目 + 累计流量，
 * 产出 monitor 契约的 node 列表。路由只负责限流、缓存与响应头。
 *
 * 依赖全部注入（不接收 Hono Context，也不反向 import routes/public）：
 * 快照与会话校验由调用方（monitor-compat）接好线，单测可直接给假实现。
 */
import type { Context } from 'hono';
import type { Bindings, Variables } from '../../index';
import * as db from '../../db/queries';
import type { MonitorTrafficTotals } from '../../db/types';
import type { LiveSnapshot } from '../../utils/do-response';
import { readLiveSnapshot } from '../../utils/do-response';
import { liveDataStub } from '../../utils/live-data-object';
import type { PublicClient } from '../../utils/public-client';
import {
  buildMonitorNode,
  monitorTrafficWithTotals,
  type MonitorNode,
} from '../contract';
import { recordOrNull } from './json';

export type MonitorContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export type Timed<T> = { ms: number; value: T };

export async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const startedAt = performance.now();
  const value = await work();
  return { ms: performance.now() - startedAt, value };
}

/** loadNodes 需要的 Worker 绑定：只有 LIVE_DATA。 */
export type LoadNodesEnv = { LIVE_DATA: Bindings['LIVE_DATA'] };

async function readLive(env: LoadNodesEnv, includeHidden: boolean): Promise<LiveSnapshot> {
  try {
    // 管理员会话才带 include_hidden：否则 DO 会把隐藏节点的实时条目过滤掉，
    // 管理员看到的隐藏节点会是「离线、全零」。
    const response = await liveDataStub(env.LIVE_DATA)
      .fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`, { method: 'GET' }));
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

export type LoadNodesResult = {
  admin: boolean;
  clients: readonly PublicClient[];
  nodes: MonitorNode[];
  totals: Record<string, MonitorTrafficTotals>;
  totalsCacheHit: boolean;
  timings: { snapshot: number; live: number; admin: number; totals: number };
};

/**
 * loadNodes 的依赖。snapshot / adminSession 在 routes/monitor-compat 里接到
 * getPublicClientsSnapshot 与 hasAdminSession；单测注入假实现即可，无需伪造
 * Hono Context。
 */
export type LoadNodesDeps = {
  database: db.QueryDatabase;
  env: LoadNodesEnv;
  /** /api/nodes 请求的 origin（hub 契约里 me.site 的口径）。 */
  siteUrl: string;
  /** 公开节点快照（带 overlay 与可见性处理）；管理员会话时 includeHidden 为 true。 */
  snapshot: (includeHidden: boolean) => Promise<{ clients: readonly PublicClient[] }>;
  /** 当前请求是否管理员会话。 */
  adminSession: () => Promise<boolean>;
};

export async function loadNodes(deps: LoadNodesDeps): Promise<LoadNodesResult> {
  // 管理员身份要先于快照与实时数据确定：它决定是否包含隐藏节点。匿名请求没有会话
  // cookie，这一步不碰库；管理员请求多一次（带缓存的）会话校验。
  const adminResult = await timed(() => deps.adminSession());
  const admin = adminResult.value;
  const [snapshotResult, liveResult] = await Promise.all([
    timed(() => deps.snapshot(admin)),
    timed(() => readLive(deps.env, admin)),
  ]);
  const snapshot = snapshotResult.value;
  const live = liveResult.value;

  const onlineSet = new Set(live.online);
  const nowMs = Date.now();
  // day_* / total_* 一次批量取；失败时退回 0，而不是让整个节点列表报错。
  const totalsLookup: db.TrafficTotalsLookup = {};
  const totalsResult = await timed(() => db.getTrafficTotals(
    deps.database,
    snapshot.clients.map(client => client.uuid),
    totalsLookup,
  ).catch(() => ({} as Record<string, MonitorTrafficTotals>)));
  const totals = totalsResult.value;
  const origin = deps.siteUrl;
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
        siteUrl: origin,
      });
    });

  return {
    admin,
    clients: snapshot.clients,
    nodes,
    totals,
    totalsCacheHit: totalsLookup.cached ?? false,
    timings: {
      snapshot: snapshotResult.ms,
      live: liveResult.ms,
      admin: adminResult.ms,
      totals: totalsResult.ms,
    },
  };
}
