/**
 * WebSocket 请求的共享判定。
 *
 * 前端实时通道（`routes/websocket.ts`）与 Agent 上报通道（`routes/client.ts`）
 * 都需要判断 Upgrade 与 Origin，但两者的其它逻辑完全独立。把这两个纯函数放在
 * 这里，避免为了复用而让 Agent 路由 import 前端路由模块（或反过来）。
 */

/** 只需要 request 的 URL 与 header：任何 Hono Context 都能结构化匹配。 */
type WsRequestContext = {
  req: {
    url: string;
    header(name: string): string | undefined;
  };
};

/** `Upgrade: websocket` 才进入升级分支；普通 GET 由各路由自己决定响应。 */
export function isWebSocketUpgrade(c: WsRequestContext): boolean {
  return (c.req.header('Upgrade') || '').toLowerCase() === 'websocket';
}

/** Origin 缺失时放行（非浏览器客户端）；存在时必须与请求同源。 */
export function requestHasValidOrigin(c: WsRequestContext): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;

  try {
    const requestUrl = new URL(c.req.url);
    const originUrl = new URL(origin);
    return originUrl.protocol === requestUrl.protocol && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}
