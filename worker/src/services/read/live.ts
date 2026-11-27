/**
 * 实时快照（LIVE_DATA Durable Object）的统一读入口。
 *
 * 原生读 API 里有多条路径都需要同一份 DO 快照：
 * - `/api/live` 代理原始响应；
 * - `/api/live/clients`、`/api/public/bootstrap` 取解析后的 JSON；
 * - monitor 的 `/api/nodes` 把实时条目合进节点投影。
 *
 * 这里只负责“带上管理员视角去 DO 读、校验形状、失败时明确报错”，
 * 限流、缓存头、Server-Timing 仍留在各路由。路由之间不要再各自拼
 * `https://do/live`，否则 include_hidden 与失败回退的口径很容易漂移。
 */
import type { Bindings } from '../../index';
import { readLiveSnapshot, type LiveSnapshot } from '../../utils/do-response';
import { liveDataStub } from '../../utils/live-data-object';
import { ReadUnavailableError } from './failure';

/** loadLiveSnapshot 需要的 Worker 绑定：只有 LIVE_DATA。 */
export type LiveReadEnv = { LIVE_DATA: Bindings['LIVE_DATA'] };

/** `/live` 的 DO 请求；管理员视角才带 include_hidden。 */
export function liveSnapshotRequest(includeHidden: boolean): Request {
  return new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`, { method: 'GET' });
}

/**
 * 把 Worker 收到的原始请求改写成 DO 的 `/live` 请求。
 *
 * 代理路径（`/api/live`、`/ws/live` 的非升级 GET）需要保留原始 query 与头，
 * 只覆盖 include_hidden，避免匿名请求借用 header/query 冒充管理员视角。
 */
export function liveSnapshotProxyRequest(request: Request, includeHidden: boolean): Request {
  const url = new URL(request.url);
  if (includeHidden) url.searchParams.set('include_hidden', '1');
  else url.searchParams.delete('include_hidden');
  return new Request(url.toString(), request);
}

/** 读一份解析后的实时快照；故障不能伪装成所有节点离线。 */
export async function loadLiveSnapshot(
  env: LiveReadEnv,
  includeHidden: boolean,
): Promise<LiveSnapshot> {
  try {
    const response = await liveDataStub(env.LIVE_DATA).fetch(liveSnapshotRequest(includeHidden));
    if (!response.ok) throw new ReadUnavailableError();
    const snapshot = await readLiveSnapshot(response);
    if (!snapshot) throw new ReadUnavailableError();
    return snapshot;
  } catch {
    throw new ReadUnavailableError();
  }
}

/** 取节点的实时条目：在线条目优先，离线时回落到 last_known。 */
export function liveEntryFor(
  live: LiveSnapshot,
  uuid: string,
): Record<string, unknown> | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  return record(live.data?.[uuid]) ?? record(live.last_known?.[uuid]);
}

/** 实时条目里的数字字段；非法值按 0 处理（与节点投影口径一致）。 */
export function liveNumber(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
