import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const THEME_URL = 'https://github.com/o/r/tree/main/dist';
const RAW = 'https://raw.githubusercontent.com/o/r/main/dist';
const THEME_HTML = [
  '<!doctype html><html lang="zh-CN"><head>',
  '<title>Theme</title>',
  '<link rel="icon" href="/favicon.svg">',
  '<script src="/title-probe.js" async></script>',
  '<script type="module" src="/assets/index.js"></script>',
  '</head><body><div id="app"></div></body></html>',
].join('');

const files = new Map([
  [`${RAW}/index.html`, THEME_HTML],
  [`${RAW}/assets/index.js`, 'console.log("theme")'],
  [`${RAW}/assets/chunk.js`, 'const u=`modulepreload`,d=function(e){return`/`+e},f={},p=function(e,t,n){};import("/assets/charts-CnsZ1jie.css")'],
  [`${RAW}/assets/index.css`, 'body{background:url(/images/bg.png)}'],
  [`${RAW}/assets/app-abcdefgh.js`, 'console.log("hashed")'],
  [`${RAW}/fonts/x.woff2`, 'font-bytes'],
  [`${RAW}/images/logo/os-x.svg`, '<svg></svg>'],
  [`${RAW}/style.css`, '.x{color:red}'],
]);

function tarEntry(name, value) {
  const data = Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  header[156] = 48;
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}
const releaseArchive = gzipSync(Buffer.concat([
  tarEntry('dist/index.html', '<!doctype html><html><head><title>Release theme</title><link href="/style.css"></head><body></body></html>'),
  tarEntry('dist/style.css', 'body{color:red}'),
  Buffer.alloc(1024),
]));

const fetched = [];
const fetchStub = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  fetched.push(url);
  if (url === 'https://github.com/o/r/releases/latest/download/theme.tar.gz') {
    return new Response(releaseArchive, { status: 200 });
  }
  const body = files.get(url);
  if (body === undefined) return new Response('not found', { status: 404 });
  return new Response(body, { status: 200 });
};

let settingsRaw = JSON.stringify({ enabled: true, theme_url: THEME_URL });
let legacySettingsRaw = null;

const loader = createWorkerLoader({
  db: {
    getSetting: async (_database, key) => key === 'third_party_theme' ? settingsRaw : legacySettingsRaw,
    getSettingsByKeys: async () => ({}),
  },
  overrides: {
    'worker/src/routes/public.ts': {
      getPublicSettings: async () => ({ site_title: '站点名', site_logo_url: '' }),
    },
  },
  globals: { fetch: fetchStub },
});

const { thirdPartyThemeRoutes, invalidateThirdPartyThemeCache } = loader.load('worker/src/routes/third-party-theme.ts');

const BUILTIN_HTML = '<!doctype html><html><body>builtin</body></html>';
const env = {
  ASSETS: {
    fetch: async (request) => {
      const url = new URL(typeof request === 'string' ? request : request.url);
      if (url.pathname === '/index.html') {
        return new Response(BUILTIN_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=0' },
        });
      }
      return new Response('asset not found', { status: 404 });
    },
  },
};

const get = (path, headers) => thirdPartyThemeRoutes.request(path, { method: 'GET', headers }, env);
const getHtml = (path) => get(path, { Accept: 'text/html,application/xhtml+xml' });

function setSettings(value) {
  settingsRaw = JSON.stringify(value);
  legacySettingsRaw = null;
  invalidateThirdPartyThemeCache();
}

// --- monitor 格式：首页与资源 ---
setSettings({ enabled: true, theme_url: THEME_URL });
{
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'upstream');
  assert.match(res.headers.get('Content-Security-Policy') || '', /script-src/);
  const html = await res.text();
  assert.match(html, /src="\/mt\/assets\/index\.js"/, '资源应挪到 /mt/ 下');
  assert.match(html, /src="\/mt\/title-probe\.js"/);
  assert.doesNotMatch(html, /<base /);
  assert.match(html, /<title>站点名<\/title>/);
}

{
  const res = await get('/mt/assets/index.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /javascript/);
  assert.equal(await res.text(), 'console.log("theme")');
  // 未哈希的文件仍按分支主题的短缓存，改完主题能及时生效。
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');

  const hashed = await get('/mt/assets/app-abcdefgh.js');
  assert.equal(hashed.status, 200);
  assert.equal(
    hashed.headers.get('Cache-Control'),
    'public, max-age=31536000, immutable',
    '带内容哈希的构建产物可以长缓存',
  );

  const chunk = await get('/mt/assets/chunk.js');
  assert.equal(chunk.status, 200);
  const chunkJs = await chunk.text();
  assert.match(chunkJs, /\/mt\/assets\/charts-CnsZ1jie\.css/, 'JS 动态导入里的绝对资源路径也要改写');
  assert.match(chunkJs, /return`\/mt\/`\+e/, 'module-preload helper must not escape the theme asset prefix');

  const css = await get('/mt/assets/index.css');
  assert.equal(css.status, 200);
  assert.match(await css.text(), /url\(\/mt\/images\/bg\.png\)/, 'CSS 里的绝对路径也要挪走');

  assert.equal((await get('/fonts/x.woff2')).status, 200);
  assert.equal((await get('/images/logo/os-x.svg')).status, 200);
  // 手写主题的根路径文件（crt 就是 /style.css + /app.js），枚举不出来，由兜底路由取上游。
  const rootCss = await get('/style.css');
  assert.equal(rootCss.status, 200);
  assert.equal(await rootCss.text(), '.x{color:red}');
  assert.equal((await get('/mt/evil.exe')).status, 404, '非白名单扩展名不代理');
}

// --- monitor 格式：客户端路由刷新回到主题 index ---
for (const path of ['/nodes', '/node/12', '/me', '/traffic', '/instance/abc', '/404']) {
  const res = await getHtml(path);
  assert.equal(res.status, 200, `${path} 应返回主题页面`);
  assert.match(await res.text(), /\/mt\/assets\/index\.js/, `${path} 应返回主题 index.html`);
}

// --- 内置路径不被主题接管 ---
{
  const res = await getHtml('/admin');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BUILTIN_HTML);
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'builtin');
}

// --- 仓库根地址：按 Monitor 原版约定读取最新 Release 的 theme.tar.gz ---
setSettings({ enabled: true, theme_url: 'https://github.com/o/r' });
{
  const res = await get('/');
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'upstream');
  const html = await res.text();
  assert.match(html, /<title>站点名<\/title>/);
  assert.match(html, /href="\/style\.css"/);
  assert.ok(fetched.includes('https://github.com/o/r/releases/latest/download/theme.tar.gz'));
  const css = await get('/style.css');
  assert.equal(css.status, 200);
  assert.equal(await css.text(), 'body{color:red}');
  assert.match(css.headers.get('Server-Timing') || '', /desc="memory"/, '第二个文件应复用解压后的归档索引');
  const archiveFetches = fetched.filter(url => url === 'https://github.com/o/r/releases/latest/download/theme.tar.gz');
  assert.equal(archiveFetches.length, 1, '同一归档只应下载并解压一次');
}

// --- 停用：首页回落内置 SPA，且不能被边缘缓存 ---
setSettings({ enabled: false, theme_url: THEME_URL });
{
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'disabled');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(await res.text(), BUILTIN_HTML);
}

// --- 旧 CFSM 格式配置不再接管首页 ---
settingsRaw = null;
legacySettingsRaw = JSON.stringify({ enabled: true, theme_url: THEME_URL, format: 'cfsm' });
invalidateThirdPartyThemeCache();
{
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'disabled');
  assert.equal(await res.text(), BUILTIN_HTML);
}

// --- 上游 index.html 404：回落到内置并标注原因 ---
setSettings({ enabled: true, theme_url: THEME_URL });
{
  const saved = files.get(`${RAW}/index.html`);
  files.delete(`${RAW}/index.html`);
  try {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Third-Party-Theme'), 'upstream-404');
    assert.equal(await res.text(), BUILTIN_HTML);
  } finally {
    files.set(`${RAW}/index.html`, saved);
  }
}

// --- 地址非法：解析时启用标记会被丢掉，仍回落内置 ---
setSettings({ enabled: true, theme_url: 'https://example.com/not-github' });
{
  const res = await get('/');
  assert.equal(res.headers.get('X-Third-Party-Theme'), 'disabled');
  assert.equal(await res.text(), BUILTIN_HTML);
}

// --- 没有 ASSETS 绑定时不要抛 500 ---
{
  const res = await thirdPartyThemeRoutes.request('/', { method: 'GET' }, {});
  assert.equal(res.status, 503);
}

console.log('third-party-theme route tests passed');
