import type { PublicClientRow } from '../db/types';
import { isPublicIpAddress } from './request-ip.ts';

export type PublicClient = Omit<PublicClientRow, 'ipv4' | 'ipv6'> & {
  has_ipv4: boolean;
  has_ipv6: boolean;
  tags: string;
};

type PublicClientSource = PublicClientRow & {
  token?: unknown;
  remark?: unknown;
};

export const PUBLIC_CLIENT_FIELDS = [
  'uuid', 'name', 'cpu_name', 'virtualization', 'arch', 'cpu_cores', 'os',
  'kernel_version', 'gpu_name', 'region', 'public_remark', 'mem_total', 'swap_total',
  'disk_total', 'version', 'price', 'billing_cycle', 'auto_renewal', 'currency',
  'expired_at', 'group', 'tags', 'hidden', 'hide_price', 'traffic_limit', 'traffic_limit_type',
  'traffic_reset_day', 'sort_order', 'created_at', 'updated_at',
] as const;

function pickFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    // Patches omit missing fields; explicit zero/empty/null values remain meaningful.
    if (Object.hasOwn(source, key) && source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function isPublicTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return !['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}

export function sanitizePublicTags(tags: unknown): string {
  if (typeof tags !== 'string') return '';
  return tags
    .split(/[;,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter(isPublicTag)
    .join(';');
}

// 「对游客隐藏价格」时，游客侧这四个计费字段被替换成前端视为“无价格”的零值
// （price=0 时前端不渲染价格标签）。到期时间 expired_at 不属于价格，保持公开。
const GUEST_HIDDEN_PRICE_VALUES = {
  price: 0,
  billing_cycle: 0,
  auto_renewal: false,
  currency: '',
} as const;

/**
 * 按受众投影价格可见性。
 * - 管理员：原样返回（后台需要看到并编辑真实价格）。
 * - 游客：永远不返回 hide_price 开关本身；开关为 true 时把价格相关字段覆盖为零值。
 *   覆盖是“有则无条件写入”而不是“有价格才改”：元数据事件是补丁语义，
 *   游客端之前可能已经缓存了旧价格，必须用显式零值把它冲掉。
 * hidePriceOverride 用于补丁里没带 hide_price 字段、但调用方能从别处查到开关的场景。
 */
export function applyPriceVisibility<T extends object>(client: T, administrator: boolean, hidePriceOverride?: boolean): T {
  if (administrator) return client;
  const record = { ...client } as Record<string, unknown>;
  const hidePrice = hidePriceOverride ?? Boolean(record.hide_price);
  delete record.hide_price;
  if (hidePrice) Object.assign(record, GUEST_HIDDEN_PRICE_VALUES);
  return record as T;
}

export function toPublicClient(client: PublicClientSource): PublicClient {
  const { ipv4, ipv6 } = client;
  const publicClient = pickFields(client, PUBLIC_CLIENT_FIELDS);
  return {
    ...publicClient,
    has_ipv4: typeof ipv4 === 'string' && isPublicIpAddress(ipv4),
    has_ipv6: typeof ipv6 === 'string' && isPublicIpAddress(ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
}
