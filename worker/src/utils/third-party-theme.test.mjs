import assert from 'node:assert/strict';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const {
  THIRD_PARTY_THEME_PREFIX,
  parseThirdPartyThemeSettings,
  parseThemeUrl,
  serializeThirdPartyThemeSettings,
  rewriteThemeAssetPaths,
  transformThemeHtml,
} = createWorkerLoader().load('worker/src/utils/third-party-theme.ts');

const options = {
  siteTitle: '站点名',
  favicon: '/logo.png',
  backgroundDesktop: '',
  backgroundMobile: '',
};

// --- generic setting plus a safe one-time import of legacy Monitor-format settings ---
{
  assert.equal(parseThemeUrl('https://github.com/o/r?tab=readme-ov-file').repository, true);
  assert.equal(parseThemeUrl('https://github.com/o/r.git#readme').repo, 'r');
  assert.equal(parseThemeUrl('https://github.com/o/r/tree/main/dist').repository, false);
  assert.equal(parseThirdPartyThemeSettings(null).enabled, false);
  assert.equal(parseThirdPartyThemeSettings(null).theme_url, '');
  const monitor = parseThirdPartyThemeSettings(JSON.stringify({
    enabled: true,
    theme_url: 'https://github.com/o/r/tree/main/dist',
    format: 'monitor',
  }), true);
  assert.equal(monitor.enabled, true);
  assert.equal(parseThirdPartyThemeSettings(JSON.stringify({
    enabled: true,
    theme_url: 'https://github.com/o/r/tree/main/dist',
  }), true).enabled, false, 'legacy CFSM settings are not activated as Monitor bundles');
  const serialized = JSON.parse(serializeThirdPartyThemeSettings(monitor));
  assert.deepEqual(serialized, { enabled: true, theme_url: 'https://github.com/o/r/tree/main/dist' });
}

// --- Monitor 资源路径改写 ---
{
  const css = 'body{background:url("/assets/bg.png")}@font-face{src:url(/fonts/x.woff2)}';
  assert.match(rewriteThemeAssetPaths(css), /\/mt\/assets\/bg\.png/);
  assert.match(rewriteThemeAssetPaths(css), /\/mt\/fonts\/x\.woff2/);

  const html = [
    '<script src="/assets/index.js"></script>',
    '<link rel="icon" href="/favicon.svg">',
    '<script src="/title-probe.js" async></script>',
    '<link rel="manifest" href="/site.webmanifest">',
    "fetch('/api/me')",
  ].join('');
  const monitor = rewriteThemeAssetPaths(html);
  assert.match(monitor, new RegExp(`src="${THIRD_PARTY_THEME_PREFIX}assets/index\\.js"`));
  assert.match(monitor, /src="\/mt\/title-probe\.js"/);
  assert.match(monitor, /href="\/mt\/site\.webmanifest"/);
  // `/api/*` 必须保持原样，主题的请求要打到本 Worker。
  assert.match(monitor, /fetch\('\/api\/me'\)/);
  const js = rewriteThemeAssetPaths('const deps=["/assets/charts-CnsZ1jie.css"];');
  assert.match(js, /\/mt\/assets\/charts-CnsZ1jie\.css/, 'JS 异步 chunk/CSS 引用也要改写');
  const preloadHelper = "const u=`modulepreload`,d=function(e){return`/`+e},f={},p=function(e,t,n){}";
  assert.match(
    rewriteThemeAssetPaths(preloadHelper),
    /return`\/mt\/`\+e/,
    'Vite/Rolldown runtime-generated preload paths must stay under /mt/',
  );

  const luminaStore = 'var Sa=2e3,Ca=3e4,wa=8e3,Ta=160;function Ao(){};'
    + 'var ao={failureStreak:0,hydrated:!1,nodeInfoError:!1};'
    + 'function run(){setInterval(()=>{Ao().catch(()=>{})},Ca)}';
  assert.match(rewriteThemeAssetPaths(luminaStore), /Sa=2e3,Ca=3e4,wa=8e3,Ta=160/);
  const unrelatedStore = 'var Sa=2e3,Ca=3e4,wa=8e3,Ta=160;function run(){Ao().catch(()=>{})}';
  assert.match(rewriteThemeAssetPaths(unrelatedStore), /Sa=2e3,Ca=3e4,wa=8e3,Ta=160/);
}

// --- HTML 注入：Monitor 不注入 base / 桥接脚本 ---
{
  const html = '<!doctype html><html><head><title>旧标题</title></head><body></body></html>';
  const monitor = transformThemeHtml(html, options);
  assert.doesNotMatch(monitor, /<base /);
  assert.doesNotMatch(monitor, /bridge/);
  assert.match(monitor, /<title>站点名<\/title>/);
  // 首屏 /api/nodes preload：主题 fetch 用 credentials: 'include'，凭据模式必须匹配。
  assert.match(monitor, /<link rel="preload" as="fetch" href="\/api\/nodes" crossorigin="use-credentials">/);
  assert.equal((monitor.match(/href="\/api\/nodes"/g) || []).length, 1, 'preload 不应重复注入');
  // 已经有主题自己写的 preload 时保持原样。
  const already = '<head><link rel="preload" as="fetch" href="/api/nodes"></head>';
  assert.equal(
    (transformThemeHtml(already, options).match(/preload/g) || []).length,
    1,
    '重复执行也不应叠加 preload',
  );
}

console.log('third-party-theme utils tests passed');
