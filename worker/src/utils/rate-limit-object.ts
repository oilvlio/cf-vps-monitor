/**
 * RATE_LIMIT 对象的统一入口。
 *
 * 与 LIVE_DATA 同样的原因：对象的位置在第一次 `get()` 时确定，早期创建的对象
 * 落在 DFW，公开读接口每次限流都要多付约 200ms 的跨洲往返。这里统一用带 `-v2`
 * 后缀的新对象名 + APAC 放置提示；限流状态本来就是短命计数器，丢一次不影响语义。
 */

import type { Bindings } from '../index';
// 同上：显式 `.ts` 扩展名以兼容 Node 原生加载。
import { APAC_DO_LOCATION_HINT } from './durable-object-placement.ts';

/** 迁移前后的对象名，调用方只应使用这里的 v2 名字。 */
export const RATE_LIMIT_OBJECT_NAMES = {
  publicApi: 'public-api-v2',
  agentIngress: 'agent-ingress-v2',
  adminHealth: 'admin-health-v2',
} as const;

export function rateLimitId(namespace: Bindings['RATE_LIMIT'], name: string): DurableObjectId {
  return namespace.idFromName(name);
}

export function rateLimitStub(namespace: Bindings['RATE_LIMIT'], name: string) {
  return namespace.get(rateLimitId(namespace, name), { locationHint: APAC_DO_LOCATION_HINT });
}
