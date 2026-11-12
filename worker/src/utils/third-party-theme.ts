/**
 * 第三方 Monitor 主题托管工具：GitHub 仓库/release 解析、静态文件缓存、HTML 注入与 CSP。
 *
 * 与 CF-Server-Monitor 的 frontend handler 保持同一套做法（反代 raw.githubusercontent.com），
 * 主题资源挂在 `/mt/` 下，避免与 cf-vps-monitor 自己的 `/assets/*` 冲突。
 */

import { gunzipSync } from 'fflate';

export const THIRD_PARTY_THEME_SETTING_KEY = 'third_party_theme';
/** Legacy Monitor-format settings are read only when no generic setting exists; legacy CFSM stays disabled. */
export const LEGACY_CFSM_THEME_SETTING_KEY = 'cfsm_theme';
/** monitor 主题的静态资源前缀（`/assets`、`/fonts`、`/images`…都被挪到这里）。 */
export const THIRD_PARTY_THEME_PREFIX = '/mt/';
export const THIRD_PARTY_THEME_HTML_CACHE_SECONDS = 60;
export const THIRD_PARTY_THEME_BRANCH_ASSET_CACHE_SECONDS = 300;
export const THIRD_PARTY_THEME_COMMIT_ASSET_CACHE_SECONDS = 31_536_000;

export type ThirdPartyThemeSettings = {
  enabled: boolean;
  theme_url: string;
};

const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;
const THEME_FETCH_TIMEOUT_MS = 15_000;

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.json', '.map', '.txt', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.ogg',
]);

/** Rewrite root-relative Monitor theme asset paths; `/api/*` remains same-origin. */
export function rewriteThemeAssetPaths(text: string): string {
  let rewritten = text
    .replace(/(["'(])\/assets\//g, `$1${THIRD_PARTY_THEME_PREFIX}assets/`)
    .replace(/(["'(])\/(fonts|images|icons)\//g, `$1${THIRD_PARTY_THEME_PREFIX}$2/`)
    .replace(
      /(["'(])\/(title-probe\.js|manifest\.json|site\.webmanifest|background\.svg)\b/g,
      `$1${THIRD_PARTY_THEME_PREFIX}$2`,
    );

  // Vite/Rolldown's module-preload helper turns dependency names such as
  // "assets/charts-....css" into "/assets/charts-....css" at runtime. That
  // string is assembled from a slash prefix, so the literal-path replacements
  // above cannot see it. Keep these generated preload URLs inside the theme
  // namespace while leaving SPA routes and API URLs rooted at `/`.
  return rewritten.replace(
    /(["'`]modulepreload["'`][,;]\s*[\w$]+\s*=\s*function\s*\(\s*([\w$]+)\s*\)\s*\{\s*return\s*)(["'`])\/(?:\3)\s*\+\s*\2/g,
    (_match, prefix: string, argument: string, quote: string) => `${prefix}${quote}${THIRD_PARTY_THEME_PREFIX}${quote}+${argument}`,
  );
}

export type ParsedTheme = {
  themeUrl: string;
  ref: string;
  isCommit: boolean;
  rawBase: string;
  cacheBase: string;
  repository: boolean;
  owner: string;
  repo: string;
};

export function normalizeThemeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (url.username || url.password) return '';

    const parts = url.pathname.split('/').filter(Boolean);
    const repo = (parts[1] || '').replace(/\.git$/i, '');
    if (!parts[0] || !repo || !/^[A-Za-z0-9._-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(repo)) return '';
    if (parts.some(part => part === '.' || part === '..' || /[%\\]/.test(part))) return '';
    if (parts.length > 2 && parts[2] === 'tree') {
      if (parts.length < 4 || !/^[A-Za-z0-9._-]+$/.test(parts[3] || '')) return '';
      return `https://github.com/${parts[0]}/${repo}/${parts.slice(2).join('/')}`;
    }
    // Like Monitor hub's github_repo(), ignore branch/file paths and browser query/fragment.
    return `https://github.com/${parts[0]}/${repo}`;
  } catch {
    return '';
  }
}

export function parseThemeUrl(value: unknown): ParsedTheme | null {
  const normalized = normalizeThemeUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0]!;
  const repo = parts[1]!;
  const repository = parts.length === 2;
  const ref = repository ? 'latest' : parts[3]!;
  const themePathParts = repository ? [] : parts.slice(4);
  const encoded = [owner, repo, ref, ...themePathParts].map(part => encodeURIComponent(part)).join('/');
  return {
    themeUrl: normalized,
    ref,
    isCommit: /^[a-f0-9]{40}$/i.test(ref),
    rawBase: repository
      ? `https://github.com/${owner}/${repo}/releases/latest/download/theme.tar.gz`
      : `https://raw.githubusercontent.com/${encoded}`,
    cacheBase: `https://third-party-theme-cache.local/${encoded}`,
    repository,
    owner,
    repo,
  };
}

export function parseThirdPartyThemeSettings(
  raw: string | null | undefined,
  isLegacySetting = false,
): ThirdPartyThemeSettings {
  const fallback: ThirdPartyThemeSettings = { enabled: false, theme_url: '' };
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const record = parsed as Record<string, unknown>;
  const themeUrl = normalizeThemeUrl(record.theme_url);
  return {
    enabled: record.enabled === true && Boolean(themeUrl)
      && (!isLegacySetting || record.format === 'monitor'),
    theme_url: themeUrl,
  };
}

export function serializeThirdPartyThemeSettings(settings: ThirdPartyThemeSettings): string {
  return JSON.stringify({
    enabled: settings.enabled === true,
    theme_url: normalizeThemeUrl(settings.theme_url),
  });
}

export function themeContentType(path: string): string {
  const clean = path.split('?')[0]!.toLowerCase();
  if (clean.endsWith('.html')) return 'text/html;charset=UTF-8';
  if (clean.endsWith('.js') || clean.endsWith('.mjs')) return 'application/javascript;charset=UTF-8';
  if (clean.endsWith('.css')) return 'text/css;charset=UTF-8';
  if (clean.endsWith('.json') || clean.endsWith('.map')) return 'application/json;charset=UTF-8';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.ico')) return 'image/x-icon';
  if (clean.endsWith('.avif')) return 'image/avif';
  if (clean.endsWith('.woff2')) return 'font/woff2';
  if (clean.endsWith('.woff')) return 'font/woff';
  if (clean.endsWith('.ttf')) return 'font/ttf';
  if (clean.endsWith('.otf')) return 'font/otf';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

/**
 * Vite/Rolldown 的构建产物在文件名里带内容哈希（`index-CP_ec1xO.js`），内容变了
 * 文件名就会变，可以放心长缓存；手写主题的 `/style.css`、`/assets/index.js` 之类
 * 没有哈希，必须继续用短缓存，否则改完主题要等很久才能生效。
 */
export function isImmutableThemeAsset(path: string): boolean {
  if (!path.startsWith('assets/')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(base);
}

/** Normalize a hosted theme asset path; reject traversal, backslashes and long paths. */
export function normalizeThemeAssetPath(path: string): string {
  const raw = String(path || '').replace(/^\/+/, '');
  if (!raw || raw.length > 512) return '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '';
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return '';
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return '';
  const extension = `.${parts[parts.length - 1]!.split('.').pop()!.toLowerCase()}`;
  if (!ALLOWED_EXTENSIONS.has(extension)) return '';
  return parts.map(part => encodeURIComponent(part)).join('/');
}

/** 带 Cache API 的上游抓取；错误响应不缓存。`transform` 用于改写文本资源（CSS 里的绝对路径）。 */
export async function fetchThemeFile(
  rawUrl: string,
  cacheUrl: string,
  contentType: string,
  cacheSeconds: number,
  transform?: (text: string) => string,
  /** 同一份文件按格式改写时会产出不同字节，缓存键要分开。 */
  cacheVariant = '1',
  immutable = false,
): Promise<Response> {
  // 改写后的内容单独占一个缓存键，避免与历史缓存的正文字节混淆。
  const cacheKey = new Request(transform ? `${cacheUrl}?rewritten=${cacheVariant}` : cacheUrl, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey).catch(() => undefined);
    if (cached) return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THEME_FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(rawUrl, {
      headers: { 'User-Agent': 'cf-vps-monitor-third-party-theme' },
      signal: controller.signal,
    });
  } catch {
    return new Response('Theme file unavailable', {
      status: 502,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    return new Response('Theme file not found', {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  }

  const declaredLength = Number(upstream.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_THEME_FILE_BYTES) {
    return new Response('Theme file too large', {
      status: 413,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  }

  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > MAX_THEME_FILE_BYTES) {
    return new Response('Theme file too large', {
      status: 413,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  }

  // 只有纯文本资源才做改写；二进制（字体/图片/视频）原样透传。
  let body: ArrayBuffer | string = bytes;
  if (transform) {
    const text = new TextDecoder().decode(bytes);
    const rewritten = transform(text);
    body = rewritten;
    if (rewritten !== text) contentType = contentType.replace(/;charset=UTF-8$/i, '') + ';charset=UTF-8';
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${cacheSeconds}${immutable ? ', immutable' : ''}`,
    'X-Content-Type-Options': 'nosniff',
  });
  const etag = upstream.headers.get('ETag');
  if (etag) headers.set('ETag', etag);
  const response = new Response(body, { status: 200, headers });

  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => undefined);
  }
  return response;
}

/** 解压后的归档索引：同一 isolate 内复用，避免每个静态文件都 gunzip + 全量扫描 tar。 */
type ThemeArchiveIndex = {
  bytes: Uint8Array;
  files: Map<string, { offset: number; size: number }>;
};

/** 内存索引只保留很短的时间，避免与 `releases/latest` 的更新窗口脱节。 */
const ARCHIVE_INDEX_TTL_MS = 60_000;
/** 单个归档解压后的内存上限；超过就退回逐文件解压，保护 isolate 内存。 */
const ARCHIVE_INDEX_MAX_BYTES = 8 * 1024 * 1024;
const ARCHIVE_INDEX_MAX_ENTRIES = 2;
const archiveIndexCache = new Map<string, { expiresAt: number; index: ThemeArchiveIndex }>();

function parseThemeArchive(bytes: Uint8Array): ThemeArchiveIndex {
  const files = new Map<string, { offset: number; size: number }>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const readString = (start: number, length: number) => new TextDecoder().decode(header.subarray(start, start + length)).replace(/\0.*$/, '').trim();
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = `${prefix ? `${prefix}/` : ''}${name}`;
    const sizeText = readString(124, 12).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) break;
    const normalized = fullName.replace(/^\.\//, '').replace(/^dist\//, '');
    if (normalized && (header[156] === 0 || header[156] === 48)) {
      files.set(normalized, { offset: offset + 512, size });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { bytes, files };
}

function cachedArchiveIndex(key: string): ThemeArchiveIndex | null {
  const hit = archiveIndexCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    archiveIndexCache.delete(key);
    return null;
  }
  return hit.index;
}

function rememberArchiveIndex(key: string, index: ThemeArchiveIndex): void {
  if (index.bytes.byteLength > ARCHIVE_INDEX_MAX_BYTES) return;
  if (!archiveIndexCache.has(key) && archiveIndexCache.size >= ARCHIVE_INDEX_MAX_ENTRIES) {
    const oldest = archiveIndexCache.keys().next().value;
    if (oldest !== undefined) archiveIndexCache.delete(oldest);
  }
  archiveIndexCache.set(key, { expiresAt: Date.now() + ARCHIVE_INDEX_TTL_MS, index });
}

/** Read a published Monitor theme bundle from a repository URL, matching the hub's
 * install contract: latest GitHub release asset `theme.tar.gz`, with site files
 * under `dist/`. The archive and extracted responses are cached independently. */
export async function fetchPublishedThemeFile(
  theme: ParsedTheme,
  relativePath: string,
  contentType: string,
  cacheSeconds: number,
  transform?: (text: string) => string,
  immutable = false,
): Promise<Response> {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://third-party-theme-cache.local/repo/${theme.owner}/${theme.repo}/${relativePath}${transform ? '?rewritten=2' : ''}`);
  const cachedFile = await cache?.match(key).catch(() => undefined);
  if (cachedFile) return cachedFile;

  const archiveIndexKey = `${theme.owner}/${theme.repo}@${theme.ref}`;
  let index = cachedArchiveIndex(archiveIndexKey);
  let decompressMs = 0;
  if (!index) {
    const archiveKey = new Request(`https://third-party-theme-cache.local/archive/${theme.owner}/${theme.repo}`);
    let archive = await cache?.match(archiveKey).catch(() => undefined);
    if (!archive) {
      let upstream: Response;
      try {
        upstream = await fetch(`https://github.com/${theme.owner}/${theme.repo}/releases/latest/download/theme.tar.gz`, {
          headers: { 'User-Agent': 'cf-vps-monitor-monitor-theme' },
          signal: AbortSignal.timeout(THEME_FETCH_TIMEOUT_MS),
        });
      } catch {
        return new Response('Theme release unavailable', { status: 502 });
      }
      if (!upstream.ok) return new Response('Theme release unavailable', { status: upstream.status });
      const bytes = await upstream.arrayBuffer();
      if (bytes.byteLength > 16 * 1024 * 1024) return new Response('Theme archive too large', { status: 413 });
      archive = new Response(bytes, { headers: { 'Cache-Control': `public, max-age=${cacheSeconds}` } });
      await cache?.put(archiveKey, archive.clone()).catch(() => undefined);
    }

    const startedAt = Date.now();
    let bytes: Uint8Array;
    try {
      bytes = gunzipSync(new Uint8Array(await archive.arrayBuffer()));
    } catch {
      return new Response('Theme archive is invalid', { status: 502 });
    }
    if (bytes.byteLength > 32 * 1024 * 1024) return new Response('Theme archive too large', { status: 413 });
    index = parseThemeArchive(bytes);
    decompressMs = Date.now() - startedAt;
    rememberArchiveIndex(archiveIndexKey, index);
  }

  const entry = index.files.get(relativePath);
  if (!entry) return new Response('Theme file not found', { status: 404 });
  if (entry.size > 4 * 1024 * 1024) return new Response('Theme file too large', { status: 413 });
  const result = index.bytes.slice(entry.offset, entry.offset + entry.size);
  let body: Uint8Array | string = result;
  if (transform && (contentType.startsWith('text/') || contentType.startsWith('application/javascript'))) {
    const text = new TextDecoder().decode(result);
    body = transform(text);
  }
  const response = new Response(body, { headers: {
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${cacheSeconds}${immutable ? ', immutable' : ''}`,
    'X-Content-Type-Options': 'nosniff',
    'Server-Timing': `theme-archive;dur=${decompressMs};desc="${decompressMs > 0 ? 'decompress' : 'memory'}"`,
  } });
  await cache?.put(key, response.clone()).catch(() => undefined);
  return response;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function insertBeforeHeadClose(html: string, content: string): string {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${content}\n</head>`);
  return `${content}\n${html}`;
}

function injectTitle(html: string, title: string): string {
  const safeTitle = escapeHtml(title);
  if (/<title>.*?<\/title>/is.test(html)) return html.replace(/<title>.*?<\/title>/is, `<title>${safeTitle}</title>`);
  return insertBeforeHeadClose(html, `<title>${safeTitle}</title>`);
}

function injectFavicon(html: string, favicon: string): string {
  const value = favicon.trim();
  if (!value) return html;
  const safe = escapeHtml(value);
  const iconTag = `<link rel="icon" href="${safe}">`;
  const touchTag = `<link rel="apple-touch-icon" href="${safe}">`;
  let hasIcon = false;
  let hasTouch = false;
  let result = html.replace(/<link\b[^>]*>/gi, tag => {
    const relMatch = tag.match(/(?:^|\s)rel\s*=\s*["']([^"']*)["']/i);
    if (!relMatch) return tag;
    const rel = relMatch[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
    if (rel === 'icon' || rel === 'shortcut icon') {
      if (hasIcon) return '';
      hasIcon = true;
      return iconTag;
    }
    if (rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed') {
      if (hasTouch) return '';
      hasTouch = true;
      return touchTag;
    }
    return tag;
  });
  const missing: string[] = [];
  if (!hasIcon) missing.push(iconTag);
  if (!hasTouch) missing.push(touchTag);
  return missing.length ? insertBeforeHeadClose(result, missing.join('\n')) : result;
}

function injectApiBase(html: string): string {
  const tag = '<meta name="apiBase" content="">';
  if (/<meta\b[^>]*name\s*=\s*["']apiBase["'][^>]*>/i.test(html)) {
    return html.replace(/<meta\b[^>]*name\s*=\s*["']apiBase["'][^>]*>/gi, tag);
  }
  return insertBeforeHeadClose(html, tag);
}

/**
 * 首页的 `/api/nodes` 要等主题 JS 执行、并且 `/api/me`、主题配置都返回后才发起，
 * 首屏会多等一个串行的 200–300ms。提前在 HTML 里 preload，让它和 JS 下载并行。
 *
 * 主题的 fetch 用 `credentials: 'include'`，所以这里必须用 `use-credentials`；
 * 否则凭据模式不匹配，预加载的响应不会被复用（Network 面板会出现
 * "preloaded but not used"），等于白打一次请求。
 */
function injectApiPreload(html: string): string {
  if (/<link\b[^>]*rel\s*=\s*["']preload["'][^>]*\/api\/nodes/i.test(html)
    || /<link\b[^>]*\/api\/nodes[^>]*rel\s*=\s*["']preload["']/i.test(html)) {
    return html;
  }
  return insertBeforeHeadClose(
    html,
    '<link rel="preload" as="fetch" href="/api/nodes" crossorigin="use-credentials">',
  );
}

function injectBackground(html: string, desktop: string, mobile: string): string {
  const desktopUrl = desktop.trim();
  const mobileUrl = mobile.trim();
  if (!desktopUrl && !mobileUrl) return html;
  const escapeCssUrl = (value: string) => value.replace(/["'()\\\n\r]/g, ch => `\\${ch}`);
  const rules: string[] = ['html,body{background-size:cover;background-position:center;background-attachment:fixed;background-repeat:no-repeat;}'];
  if (desktopUrl) rules.push(`html,body{background-image:url("${escapeCssUrl(desktopUrl)}");}`);
  if (mobileUrl) rules.push(`@media (max-width: 768px){html,body{background-image:url("${escapeCssUrl(mobileUrl)}");}}`);
  return insertBeforeHeadClose(html, `<style>${rules.join('')}</style>`);
}

function stripCspMeta(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
}

export type TransformThemeHtmlOptions = {
  siteTitle: string;
  favicon: string;
  backgroundDesktop: string;
  backgroundMobile: string;
};

/**
 * 给 Monitor 主题 index.html 注入同源运行所需的最小改动：
 * - 将会撞车的绝对静态路径改写到 `/mt/`
 * - 不注入 `<base>` 或 WS 桥接，保留根路径路由并直连 `/api/ws`
 * - 站点标题 / 图标 / 背景图由后台设置下发
 */
export function transformThemeHtml(html: string, options: TransformThemeHtmlOptions): string {
  let output = rewriteThemeAssetPaths(stripCspMeta(html));
  output = injectTitle(output, options.siteTitle);
  output = injectFavicon(output, options.favicon);
  output = injectApiBase(output);
  output = injectApiPreload(output);
  output = injectBackground(output, options.backgroundDesktop, options.backgroundMobile);
  return output;
}

async function sha256Base64(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let binary = '';
  const view = new Uint8Array(digest);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 收集内联 `<script>` 的 sha256，用于放行主题自带的启动脚本。 */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const body = match[2] || '';
    if (!body.trim()) continue;
    hashes.push(`'sha256-${await sha256Base64(body)}'`);
  }
  return hashes;
}

export function buildThemeCsp(scriptHashes: readonly string[]): string {
  const scripts = ["'self'", ...scriptHashes].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "style-src 'self'",
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `script-src ${scripts}`,
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
  ].join('; ');
}

export async function themeHtmlResponse(
  html: string,
  options: TransformThemeHtmlOptions,
  cacheSeconds: number,
): Promise<Response> {
  const transformed = transformThemeHtml(html, options);
  const hashes = await inlineScriptHashes(transformed);
  return new Response(transformed, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': `public, max-age=${cacheSeconds}`,
      'Content-Security-Policy': buildThemeCsp(hashes),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function readThemeVersion(html: string): Promise<string> {
  const match = html.match(/<meta\b[^>]*name\s*=\s*["']theme-version["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return match?.[1]?.trim() || '';
}

const THEME_PROBE_TIMEOUT_MS = 10_000;

export type ThemeProbeResult = {
  ok: boolean;
  /** 上游 HTTP 状态；0 表示请求没有发出去或超时。 */
  status: number;
  version: string;
  error: string;
};

/**
 * 后台保存/刷新时校验主题地址是不是真能取到 index.html。
 *
 * 主题不可达时首页会静默回落到内置 SPA，用户很难意识到地址填错了，
 * 所以这里主动探一次上游并把失败原因回传到后台。
 */
export async function probeTheme(themeUrl: string): Promise<ThemeProbeResult> {
  const theme = parseThemeUrl(themeUrl);
  if (!theme) {
    return { ok: false, status: 0, version: '', error: '主题地址无效（请填写 GitHub 仓库地址）' };
  }

  if (theme.repository) {
    try {
      const response = await fetchPublishedThemeFile(theme, 'index.html', 'text/html;charset=UTF-8', 0);
      if (!response.ok) return {
        ok: false,
        status: response.status,
        version: '',
        error: response.status === 404
          ? '最新 release 未提供 theme.tar.gz 或包内没有 dist/index.html'
          : `GitHub 返回 HTTP ${response.status}`,
      };
      const html = await response.text();
      if (!/<html[\s>]/i.test(html)) return { ok: false, status: response.status, version: '', error: 'dist/index.html 内容不是 HTML' };
      return { ok: true, status: response.status, version: await readThemeVersion(html), error: '' };
    } catch {
      return { ok: false, status: 0, version: '', error: '无法访问 GitHub（超时或网络错误）' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THEME_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${theme.rawBase}/index.html`, {
      headers: { 'User-Agent': 'cf-vps-monitor-third-party-theme' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        version: '',
        error: response.status === 404
          ? '该分支/目录下没有 index.html，请检查分支名与路径'
          : `GitHub 返回 HTTP ${response.status}`,
      };
    }
    const html = await response.text();
    if (!/<html[\s>]/i.test(html)) {
      return { ok: false, status: response.status, version: '', error: 'index.html 内容不是 HTML' };
    }
    return { ok: true, status: response.status, version: await readThemeVersion(html), error: '' };
  } catch {
    return { ok: false, status: 0, version: '', error: '无法访问 GitHub（超时或网络错误）' };
  } finally {
    clearTimeout(timer);
  }
}
