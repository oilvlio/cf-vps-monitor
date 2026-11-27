/**
 * 匿名访客的边缘缓存（Cloudflare `caches.default`）。
 *
 * 合并自 monitor-compat.ts 里 /nodes 与 /metrics 两套几乎相同的手写 get/put：
 * - get：命中且未超过 TTL 才返回，重写 Cache-Control / 命中标记 / Server-Timing；
 * - put：给响应标 miss、写入副本（附带写入时间戳与 stored 标记），失败静默。
 *
 * 键由调用方构造：主题会带随机 query 绕过浏览器缓存，键必须只包含语义参数，
 * 否则边缘缓存会被切碎。
 */
export type AnonEdgeCacheOptions = {
  /** 新鲜期（秒），与响应的 max-age / s-maxage 一致。 */
  seconds: number;
  /** 命中/未命中标记头，例如 X-CF-VPS-Monitor-Nodes-Cache。 */
  header: string;
  /** 写入时间戳头，用于判定是否过期，例如 X-CF-VPS-Monitor-Nodes-Cached-At。 */
  cachedAtHeader: string;
};

export type AnonEdgeCache = {
  get(request: Request): Promise<Response | null>;
  put(
    waitUntil: ((task: Promise<unknown>) => void) | undefined,
    request: Request,
    response: Response,
  ): void;
};

export function createAnonEdgeCache(options: AnonEdgeCacheOptions): AnonEdgeCache {
  const { seconds, header, cachedAtHeader } = options;

  async function get(request: Request): Promise<Response | null> {
    if (typeof caches === 'undefined') return null;
    try {
      const cached = await caches.default.match(request);
      if (!cached) return null;
      const cachedAt = Number(cached.headers.get(cachedAtHeader) || 0);
      if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > seconds * 1000) return null;
      const headers = new Headers(cached.headers);
      headers.delete(cachedAtHeader);
      // 与边缘缓存 TTL 对齐：慢设备上主题 JS 执行较久时，预加载的响应也还在新鲜期内。
      headers.set('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}`);
      headers.set(header, 'hit');
      headers.set('Server-Timing', 'edge-cache;desc="hit";dur=0');
      return new Response(cached.body, { status: cached.status, headers });
    } catch {
      return null;
    }
  }

  function put(
    waitUntil: ((task: Promise<unknown>) => void) | undefined,
    request: Request,
    response: Response,
  ): void {
    response.headers.set(header, 'miss');
    if (typeof caches === 'undefined') return;
    try {
      const copy = response.clone();
      const headers = new Headers(copy.headers);
      headers.set(cachedAtHeader, String(Date.now()));
      headers.set('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}`);
      headers.set(header, 'stored');
      const stored = caches.default.put(
        request,
        new Response(copy.body, { status: copy.status, headers }),
      );
      const task = stored.catch(() => undefined);
      if (waitUntil) waitUntil(task);
      else void task;
    } catch {
      // 边缘缓存只是省一次 DO/Supabase 往返，失败不影响响应正确性。
    }
  }

  return { get, put };
}
