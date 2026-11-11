import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 部署读的是仓库根目录的 wrangler.toml（scripts/deploy-cloudflare.mjs 的 sourceConfig），
// 而 wrangler dev / wrangler types 用的是 worker/wrangler.toml。
// 两份配置漂移过一次：只改了 worker/ 那份，线上 run_worker_first 一直是旧值，
// 首页被静态资源层直接接走，第三方主题怎么配置都不生效。这里把两者钉在一起。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deployConfigPath = join(root, 'wrangler.toml');
const workerConfigPath = join(root, 'worker', 'wrangler.toml');

/** 取出 `[assets]` 段落（到下一个表头为止）。 */
function assetsSection(toml) {
  const match = toml.match(/\[assets\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/);
  assert.ok(match, 'wrangler 配置必须声明 [assets] 段');
  return match[1];
}

function stringValue(section, key) {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function stringList(section, key) {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!match) return null;
  return match[1]
    .split(',')
    .map(item => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

const [deployToml, workerToml] = await Promise.all([
  readFile(deployConfigPath, 'utf8'),
  readFile(workerConfigPath, 'utf8'),
]);

const deployAssets = assetsSection(deployToml);
const workerAssets = assetsSection(workerToml);

test('root and worker wrangler configs agree on static asset hosting', () => {
  assert.equal(
    stringValue(deployAssets, 'binding'),
    'ASSETS',
    '根 wrangler.toml 必须声明 binding = "ASSETS"，否则运行时 c.env.ASSETS 是 undefined',
  );
  assert.equal(stringValue(workerAssets, 'binding'), 'ASSETS');
  assert.equal(
    stringValue(deployAssets, 'not_found_handling'),
    stringValue(workerAssets, 'not_found_handling'),
  );

  const deployFirst = stringList(deployAssets, 'run_worker_first');
  const workerFirst = stringList(workerAssets, 'run_worker_first');
  assert.ok(deployFirst, '根 wrangler.toml 必须声明 run_worker_first');
  assert.ok(workerFirst, 'worker/wrangler.toml 必须声明 run_worker_first');
  assert.deepEqual(
    [...deployFirst].sort(),
    [...workerFirst].sort(),
    '根配置与 worker/ 配置的 run_worker_first 必须一致，否则线上路由与本地 dev 行为不同',
  );
});

test('run_worker_first routes third-party Monitor themes to the worker', () => {
  const routes = stringList(assetsSection(deployToml), 'run_worker_first');
  assert.ok(routes.includes('/*'), 'run_worker_first 需要 /*');
  assert.ok(routes.includes('!/assets/*'), 'run_worker_first 需要排除内置资源目录');
});

test('run_worker_first sends unknown theme paths to the worker but keeps built-in assets static', () => {
  const routes = stringList(assetsSection(deployToml), 'run_worker_first');
  // 第三方主题的静态文件名由上游决定（/assets、/style.css、/fonts/... 都可能），
  // 只能整体交给 worker；内置站点的 /assets/* 仍然直接由静态资源层返回。
  assert.ok(routes.includes('/*'), 'run_worker_first 需要 /*');
  assert.ok(routes.includes('!/assets/*'), 'run_worker_first 需要用 !/assets/* 排除内置资源目录');
  for (const required of ['/mt', '/mt/*', '/fonts/*', '/images/*', '/nodes', '/node/*', '/me', '/traffic', '/instance/*', '/404']) {
    // 这些现在被 /* 覆盖，不必逐条出现，但配置里也不能反向排除它们。
    assert.ok(!routes.some(rule => rule.startsWith('!') && rule !== '!/assets/*' && rule.includes(required.replace('/*', ''))),
      `run_worker_first 不应排除 ${required}`);
  }
});

test('deploy script keeps reading the root wrangler.toml', () => {
  // 部署脚本若改成读 worker/wrangler.toml，上面的一致性约束就失去意义了。
  return readFile(join(root, 'scripts', 'deploy-cloudflare.mjs'), 'utf8').then(source => {
    assert.match(
      source,
      /const sourceConfig = join\(root, 'wrangler\.toml'\)/,
      'deploy-cloudflare.mjs 的 sourceConfig 应指向仓库根 wrangler.toml',
    );
  });
});
