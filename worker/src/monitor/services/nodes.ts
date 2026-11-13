/**
 * /api/nodes 的数据装配：公开节点快照 + LIVE_DATA 实时条目 + 累计流量，
 * 产出 monitor 契约的 node 列表。路由只负责限流、缓存与响应头。
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
import { getPublicClientsSnapshot, hasAdminSession } from '../../routes/public';
import { recordOrNull } from './json';

export type MonitorContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export type Timed<T> = { ms: number; value: T };

export async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const startedAt = performance.now();
  const value = await work();
  return { ms: performance.now() - startedAt, value };
}

async function readLive(c: MonitorContext): Promise<LiveSnapshot> {
  try {
    const response = await liveDataStub(c.env.LIVE_DATA)
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

function siteUrl(c: MonitorContext): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

export type LoadNodesResult = {
  admin: boolean;
  clients: readonly PublicClient[];
  nodes: MonitorNode[];
  totals: Record<string, MonitorTrafficTotals>;
  totalsCacheHit: boolean;
  timings: { snapshot: number; live: number; admin: number; totals: number };
};

export async function loadNodes(
  c: MonitorContext,
  database: db.QueryDatabase,
): Promise<LoadNodesResult> {
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
  // day_* / total_* 一次批量取；失败时退回 0，而不是让整个节点列表报错。
  const totalsLookup: db.TrafficTotalsLookup = {};
  const totalsResult = await timed(() => db.getTrafficTotals(
    database,
    snapshot.clients.map(client => client.uuid),
    totalsLookup,
  ).catch(() => ({} as Record<string, MonitorTrafficTotals>)));
  const totals = totalsResult.value;
  const origin = siteUrl(c);
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
