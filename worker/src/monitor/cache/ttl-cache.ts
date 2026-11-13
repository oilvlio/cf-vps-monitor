/**
 * 进程内 TTL 缓存：固定过期时间 + 按写入顺序淘汰最旧条目。
 *
 * 语义与 monitor-compat.ts 里原先四份手写缓存完全一致：
 * - 读取时惰性删除过期条目；
 * - 写入时若已达上限，先删最旧的键（Map 的插入顺序）；
 * - 不做主动定时清理（isolate 生命周期短，惰性清理足够）。
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
