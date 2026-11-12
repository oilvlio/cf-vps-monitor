/**
 * Monitor 第三方主题托管：首页换页 + 主题静态资源反代。
 *
 * 同一时间只有一份 Monitor 主题接管 `/`：
 * 读取 GitHub 仓库最新 Release 的 `theme.tar.gz`（Monitor 原版发布格式），
 * 从 `dist/` 提取 SPA 资源；资源走 `/mt/*`（`/assets`、`/fonts`、`/images`、
 * `/icons` 都挪进去），直连真实的 `/api/ws`。
 *
 * `/admin` 始终是 cf-vps-monitor 自己的 React 应用。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import {
  LEGACY_CFSM_THEME_SETTING_KEY,
  THIRD_PARTY_THEME_BRANCH_ASSET_CACHE_SECONDS,
  THIRD_PARTY_THEME_COMMIT_ASSET_CACHE_SECONDS,
  THIRD_PARTY_THEME_HTML_CACHE_SECONDS,
  THIRD_PARTY_THEME_PREFIX,
  THIRD_PARTY_THEME_SETTING_KEY,
  fetchThemeFile,
  fetchPublishedThemeFile,
  isImmutableThemeAsset,
  normalizeThemeAssetPath,
  parseThirdPartyThemeSettings,
  parseThemeUrl,
  readThemeVersion,
  rewriteThemeAssetPaths,
  themeContentType,
  themeHtmlResponse,
  type ThirdPartyThemeSettings,
  type ParsedTheme,
} from '../utils/third-party-theme';
import { getPublicSettings } from './public';

type ThemeContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const THEME_SETTINGS_CACHE_MS = 20_000;

/**
 * 内置站点自己的路径：这些永远走 cf-vps-monitor 的 React 应用，不能被第三方主题接管。
 * 其余路径（含主题自己的任意静态文件名与其客户端路由）由主题处理，取不到时再回落内置。
 */
const BUILTIN_PATH_PREFIXES = ['/admin', '/login', '/db-init', '/theme-previews', '/agent', '/assets', '/ping'];

function isBuiltinPath(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return true;
  return BUILTIN_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

let themeSettingsCache: { value: ThirdPartyThemeSettings; expiresAt: number } | null = null;

async function readThemeSettings(c: ThemeContext): Promise<ThirdPartyThemeSettings> {
  if (themeSettingsCache && themeSettingsCache.expiresAt > Date.now()) return themeSettingsCache.value;
  let value: ThirdPartyThemeSettings = { enabled: false, theme_url: '' };
  try {
    const database = getDatabase(c.env);
    const current = await db.getSetting(database, THIRD_PARTY_THEME_SETTING_KEY);
    if (current !== null && current !== undefined) {
      value = parseThirdPartyThemeSettings(current);
    } else {
      const legacy = await db.getSetting(database, LEGACY_CFSM_THEME_SETTING_KEY);
      value = parseThirdPartyThemeSettings(legacy, true);
    }
  } catch {
    // 数据库临时不可用时不把首页换成 500：按未启用主题处理，回落内置前端。
    value = { enabled: false, theme_url: '' };
  }
  themeSettingsCache = { value, expiresAt: Date.now() + THEME_SETTINGS_CACHE_MS };
  return value;
}

/** 后台保存主题后调用，让下一个请求立刻看到新配置。 */
export function invalidateThirdPartyThemeCache(): void {
  themeSettingsCache = null;
}

type ActiveTheme = { theme: ParsedTheme };

function activeTheme(settings: ThirdPartyThemeSettings): ActiveTheme | null {
  if (!settings.enabled) return null;
  const theme = parseThemeUrl(settings.theme_url);
  if (!theme) return null;
  return { theme };
}

/** `[assets] binding = "ASSETS"` 缺失时（例如绕过 wrangler 配置部署）不要直接抛 500。 */
function assetsBinding(c: ThemeContext): Fetcher | null {
  const assets = c.env.ASSETS;
  return assets && typeof assets.fetch === 'function' ? assets : null;
}

function themeAssetCacheSeconds(theme: ParsedTheme): number {
  return theme.isCommit ? THIRD_PARTY_THEME_COMMIT_ASSET_CACHE_SECONDS : THIRD_PARTY_THEME_BRANCH_ASSET_CACHE_SECONDS;
}

/**
 * 带内容哈希的构建产物（`assets/index-CP_ec1xO.js`）可以长缓存；分支主题的
 * 未哈希文件仍按短缓存，保证主题更新能及时生效。
 */
function themeAssetCachePolicy(theme: ParsedTheme, relativePath: string): { seconds: number; immutable: boolean } {
  if (isImmutableThemeAsset(relativePath)) {
    return { seconds: THIRD_PARTY_THEME_COMMIT_ASSET_CACHE_SECONDS, immutable: true };
  }
  return { seconds: themeAssetCacheSeconds(theme), immutable: false };
}

/** 按主题上游取一个静态文件；上游 404 时回 null，由调用方决定回落还是透传。 */
async function themeAssetResponse(
  active: ActiveTheme,
  relativePath: string,
): Promise<Response | null> {
  const normalized = normalizeThemeAssetPath(relativePath);
  if (!normalized) return null;

  const { theme } = active;
  const contentType = themeContentType(normalized);
  const cachePolicy = themeAssetCachePolicy(theme, normalized);
  if (theme.repository) {
    return fetchPublishedThemeFile(
      theme,
      normalized,
      contentType,
      cachePolicy.seconds,
      contentType.startsWith('text/css') || contentType.startsWith('application/javascript')
        ? rewriteThemeAssetPaths
        : undefined,
      cachePolicy.immutable,
    );
  }
  const response = await fetchThemeFile(
    `${theme.rawBase}/${normalized}`,
    `${theme.cacheBase}/${normalized}`,
    contentType,
    cachePolicy.seconds,
    contentType.startsWith('text/css') || contentType.startsWith('application/javascript')
      ? rewriteThemeAssetPaths
      : undefined,
    '1',
    cachePolicy.immutable,
  );
  return response.status === 404 ? null : response;
}

async function serveThemeAsset(
  c: ThemeContext,
  relativePath: string,
): Promise<Response> {
  const settings = await readThemeSettings(c);
  const active = activeTheme(settings);
  if (!active) return c.text('Not Found', 404);
  return await themeAssetResponse(active, relativePath) ?? c.text('Not Found', 404);
}

/**
 * 回落内置 SPA。这里必须剥掉静态资源自带的缓存头：
 * `/` 一旦被边缘缓存住，之后无论是启用主题还是改地址，都要等缓存过期才生效，
 * 表现出来就是「保存了、启用了、无痕刷新也没用」。
 * 同时回一个 `X-Third-Party-Theme` 头，方便一条 curl 判断实际分支。
 */
async function fallbackToBuiltIn(c: ThemeContext, reason: string): Promise<Response> {
  const assets = assetsBinding(c);
  if (!assets) return c.text('ASSETS binding is not configured', 503);
  let response = await assets.fetch(c.req.raw);
  // 客户端路由（如 /instance/:uuid）在静态资源层可能直接 404，显式补一次内置 index。
  if (response.status === 404 && c.req.method === 'GET') {
    response = await assets.fetch(new Request(new URL('/index.html', c.req.url).toString(), {
      method: 'GET',
      headers: c.req.raw.headers,
    }));
  }
  const headers = new Headers(response.headers);
  headers.delete('Cache-Control');
  headers.delete('CDN-Cache-Control');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Third-Party-Theme', reason);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveRoot(c: ThemeContext, settingsOverride?: ThirdPartyThemeSettings): Promise<Response> {
  const settings = settingsOverride ?? await readThemeSettings(c);
  const active = activeTheme(settings);
  if (!active) return fallbackToBuiltIn(c, settings.enabled ? 'invalid-url' : 'disabled');
  const { theme } = active;

  const upstream = theme.repository
    ? await fetchPublishedThemeFile(theme, 'index.html', 'text/html;charset=UTF-8', THIRD_PARTY_THEME_HTML_CACHE_SECONDS)
    : await fetchThemeFile(
    `${theme.rawBase}/index.html`,
    `${theme.cacheBase}/index.html`,
    'text/html;charset=UTF-8',
    THIRD_PARTY_THEME_HTML_CACHE_SECONDS,
    );
  if (!upstream.ok) {
    // 静默回落会把「地址填错」伪装成「配置没生效」，所以在日志里留一条可追溯的痕迹。
    console.warn(
      `[third-party-theme] 上游 ${theme.rawBase}/index.html 返回 ${upstream.status}，本次回落内置主题`,
    );
    return fallbackToBuiltIn(c, `upstream-${upstream.status}`);
  }

  const html = await upstream.text();
  const publicSettings = await getPublicSettings(getDatabase(c.env)).catch(() => null);
  const title = typeof publicSettings?.site_title === 'string' && publicSettings.site_title
    ? publicSettings.site_title
    : 'CF VPS Monitor';
  const favicon = typeof publicSettings?.site_logo_url === 'string' ? publicSettings.site_logo_url : '';
  const backgroundDesktop = publicSettings?.theme_settings?.backgroundImageUrlDesktop || '';
  const backgroundMobile = publicSettings?.theme_settings?.backgroundImageUrlMobile || '';

  const response = await themeHtmlResponse(html, {
    siteTitle: title,
    favicon,
    backgroundDesktop,
    backgroundMobile,
  }, THIRD_PARTY_THEME_HTML_CACHE_SECONDS);
  const version = await readThemeVersion(html);
  if (version) response.headers.set('X-Third-Party-Theme-Version', version);
  response.headers.set('X-Third-Party-Theme', 'upstream');
  return response;
}

export const thirdPartyThemeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

thirdPartyThemeRoutes.get('/', async (c) => serveRoot(c));

thirdPartyThemeRoutes.get('/mt', (c) => c.redirect('/', 302));

thirdPartyThemeRoutes.get('/mt/*', async (c) => {
  const path = c.req.path;
  const relative = path.startsWith(THIRD_PARTY_THEME_PREFIX) ? path.slice(THIRD_PARTY_THEME_PREFIX.length) : '';
  return serveThemeAsset(c, relative);
});

/**
 * 兜底路由（配合 wrangler 的 `run_worker_first = ["/*", "!/assets/*"]`）。
 *
 * 主题产物的静态文件名完全由上游决定，枚举不过来：Vite 主题是 `/assets/...`，
 * 手写主题可能是 `/style.css`、`/app.js`、`/fonts/...`。所以除了内置站点自己的
 * 路径，一律先按主题上游取文件，取不到再看这是不是页面导航（`Accept: text/html`），
 * 是就回主题 index（客户端路由刷新），不是才交给内置静态资源层。
 */
thirdPartyThemeRoutes.get('*', async (c) => {
  const path = c.req.path;
  if (path === '/api' || path.startsWith('/api/')) return c.json({ error: 'Not Found' }, 404);
  if (isBuiltinPath(path)) return fallbackToBuiltIn(c, 'builtin');

  const settings = await readThemeSettings(c);
  const active = activeTheme(settings);
  if (!active) return fallbackToBuiltIn(c, 'disabled');

  // 最后一段没有扩展名的当客户端路由处理（`/node/12`、`/servers`），有扩展名的
  // 才当静态文件去上游取。只看 Accept 不够稳：直接 curl / fetch 导航不会带 text/html。
  const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
  const looksLikeRoute = !/\.[a-z0-9]{1,8}$/i.test(lastSegment);
  const wantsHtml = looksLikeRoute || (c.req.header('Accept') ?? '').includes('text/html');
  if (!wantsHtml) {
    const asset = await themeAssetResponse(active, path.replace(/^\/+/, ''));
    if (asset) return asset;
    return fallbackToBuiltIn(c, 'asset-missing');
  }
  return serveRoot(c, settings);
});
