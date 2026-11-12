/**
 * RATE_LIMIT 对象的统一入口。
 *
 * 与 LIVE_DATA 同样的原因：对象的位置在第一次 `get()` 时确定，早期创建的对象
 * 落在 DFW，公开读接口每次限流都要多付约 200ms 的跨洲往返。这里统一用带 `-v2`
 * 后缀的新对象名 + APAC 放置提示；限流状态本来就是短命计数器，丢一次不影响语义。
 *
 * 所有调用点都传**逻辑名**（`live-clients`），后缀在这里统一加。这样新增对象时
 * 不会有人忘记改名，而忘记改名就等于把对象留在美区。
 */

import type { Bindings } from '../index';
// 同上：显式 `.ts` 扩展名以兼容 Node 原生加载。
import { APAC_DO_LOCATION_HINT } from './durable-object-placement.ts';

/** 迁移用的后缀。改这里等于再搬一次对象（限流状态会重置）。 */
const RATE_LIMIT_OBJECT_SUFFIX = '-v2';

/** 已知限流对象的逻辑名。调用方只应使用这里的值。 */
export const RATE_LIMIT_OBJECT_NAMES = {
  publicApi: 'public-api',
  agentIngress: 'agent-ingress',
  adminHealth: 'admin-health',
  liveClients: 'live-clients',
  viewerToken: 'viewer-token',
  setupStatus: 'setup-status',
  setupInit: 'setup-init',
  setupDiagnostics: 'setup-diagnostics',
} as const;

/** 逻辑名 → 实际对象名。 */
export function rateLimitObjectName(name: string): string {
  return `${name}${RATE_LIMIT_OBJECT_SUFFIX}`;
}

export function rateLimitId(namespace: Bindings['RATE_LIMIT'], name: string): DurableObjectId {
  return namespace.idFromName(rateLimitObjectName(name));
}

export function rateLimitStub(namespace: Bindings['RATE_LIMIT'], name: string) {
  return namespace.get(rateLimitId(namespace, name), { locationHint: APAC_DO_LOCATION_HINT });
}
