/** Strict same-origin guard for authenticated writes outside `/api/admin/*`. */
type OriginRequestContext = {
  req: {
    url: string;
    header(name: string): string | undefined;
  };
};

/**
 * Require an Origin or Referer that exactly matches the request origin.
 * Browsers send Origin for PUT/POST/DELETE; Referer is a fallback for clients
 * that omit Origin. Missing or malformed provenance is rejected for writes.
 */
export function requestHasSameOrigin(c: OriginRequestContext): boolean {
  try {
    const requestOrigin = new URL(c.req.url).origin;
    const source = c.req.header('Origin') || c.req.header('Referer');
    if (!source) return false;
    return new URL(source).origin === requestOrigin;
  } catch {
    return false;
  }
}
