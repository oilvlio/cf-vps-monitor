import type { Bindings } from '../index';

/**
 * Cloudflare 原生 Rate Limiting 绑定。
 *
 * 高频入口（公开读、Agent 正常上报、WebSocket 建连）只需要流量整形，按机房近似
 * 计数就够了：每次检查没有 Durable Object 往返，也不消耗 DO 的请求 / 写入额度。
 * 真正需要精确、跨机房生效的敏感低频入口（初始化、管理员恢复、Agent 鉴权失败）
 * 仍然走 RateLimitDO。
 */
export type NativeRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

/**
 * 绑定在 wrangler 配置里按窗口上限声明（period 固定 60s）；调用方只传业务上限，
 * 这里映射到对应绑定。未配置（本地 dev / 单测）时返回 null，调用方退回 isolate
 * 本地计数，接口不会因此 500。
 */
const BINDING_BY_LIMIT: Readonly<Record<number, string>> = {
  5: 'RATE_LIMIT_5',
  20: 'RATE_LIMIT_20',
  30: 'RATE_LIMIT_30',
  60: 'RATE_LIMIT_60',
  120: 'RATE_LIMIT_120',
  180: 'RATE_LIMIT_180',
  240: 'RATE_LIMIT_240',
  3000: 'RATE_LIMIT_3000',
};

/** 高频路径依赖的绑定清单；部署与 setup 诊断共用。 */
export const NATIVE_RATE_LIMIT_BINDINGS = Object.values(BINDING_BY_LIMIT);

export type NativeRateLimitCheck =
  | { outcome: 'allowed' }
  | { outcome: 'limited' }
  | { outcome: 'unavailable' };

export function nativeRateLimiter(env: Bindings, maxRequests: number): NativeRateLimiter | null {
  const name = BINDING_BY_LIMIT[maxRequests];
  if (!name) return null;
  const candidate = (env as unknown as Record<string, unknown>)[name];
  return candidate && typeof (candidate as NativeRateLimiter).limit === 'function'
    ? candidate as NativeRateLimiter
    : null;
}

export async function checkNativeRateLimit(
  env: Bindings,
  bucket: string,
  key: string,
  maxRequests: number,
): Promise<NativeRateLimitCheck> {
  const limiter = nativeRateLimiter(env, maxRequests);
  if (!limiter) return { outcome: 'unavailable' };
  try {
    const result = await limiter.limit({ key: `${bucket}:${key}` });
    return result.success ? { outcome: 'allowed' } : { outcome: 'limited' };
  } catch {
    // 绑定故障时按“不可用”处理，调用方退回本地计数。
    return { outcome: 'unavailable' };
  }
}
