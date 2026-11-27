/**
 * RATE_LIMIT 对象的统一入口。
 *
 * 只有敏感低频入口（管理员恢复 POST、Agent 鉴权失败、setup 初始化）还走 DO：
 * 它们需要跨机房精确计数，调用次数又少。高频路径用原生 Rate Limiting 绑定。
 *
 * 与 LIVE_DATA 同样的原因：对象的位置在第一次 `get()` 时确定，早期创建的对象
 * 落在 DFW，跨洲往返会额外增加延迟。这里统一用带 `-v2` 后缀的新对象名 + APAC
 * 放置提示；限流状态本来就是短命计数器，丢一次不影响语义。
 *
 * 所有调用点都传**逻辑名**（`setup-init`），后缀在这里统一加。这样新增对象时
 * 不会有人忘记改名，而忘记改名就等于把对象留在美区。
 */

import type { Bindings } from '../index';
// 同上：显式 `.ts` 扩展名以兼容 Node 原生加载。
import { APAC_DO_LOCATION_HINT } from './durable-object-placement.ts';

/** 迁移用的后缀。改这里等于再搬一次对象（限流状态会重置）。 */
const RATE_LIMIT_OBJECT_SUFFIX = '-v2';

/** 已知限流对象的逻辑名。调用方只应使用这里的值。 */
export const RATE_LIMIT_OBJECT_NAMES = {
  // 敏感低频入口：管理员恢复（POST）、Agent 鉴权失败、setup 初始化。
  publicApi: 'public-api',
  agentIngress: 'agent-ingress',
  setupInit: 'setup-init',
  // 健康 / 诊断探针。只读 /health，不写计数。
  healthProbe: 'health-probe',
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
