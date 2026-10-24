// 详情页历史数据的会话内缓存：来回切换时间档/页签时命中缓存、不重复请求，
// 但缓存有有效期——放得太久，曲线最新的一段会一直停在多久以前。
export const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface HistoryCacheEntry<T> {
  value: T;
  savedAt: number;
}

export type HistoryCache<T> = Map<string, HistoryCacheEntry<T>>;

/** 取未过期的缓存；过期的顺手删掉并按未命中处理。 */
export function readFreshCache<T>(
  cache: HistoryCache<T>,
  key: string,
  now: number = Date.now(),
  ttlMs: number = HISTORY_CACHE_TTL_MS,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.savedAt >= ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/** 写缓存，同时清掉其它已过期的条目（点「刷新」会换新的键，旧键不会再被读到）。 */
export function writeCache<T>(
  cache: HistoryCache<T>,
  key: string,
  value: T,
  now: number = Date.now(),
  ttlMs: number = HISTORY_CACHE_TTL_MS,
): void {
  for (const [entryKey, entry] of cache) {
    if (now - entry.savedAt >= ttlMs) cache.delete(entryKey);
  }
  cache.set(key, { value, savedAt: now });
}
