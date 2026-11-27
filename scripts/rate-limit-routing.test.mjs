import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 高频路径一旦退回 DO，每次请求都会产生一次 DO 请求 + 一次持久化写入，在免费额度
// 下会挤压业务 DO。这里把“只有敏感低频入口能 import 限流 DO”钉死，避免后续改动
// 悄悄把公开读或 Agent 正常上报改回去。
const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(path) {
  return readFile(join(root, 'worker', 'src', 'routes', path), 'utf8');
}

test('sensitive low-frequency routes are the only ones using the rate limit DO', async () => {
  const expectations = [
    ['public.ts', 'admin-recovery', 1],
    ['client.ts', 'agent-auth-failure', 1],
    // setup.ts 另一个 DO 调用是只读 /health 探针。
    ['setup.ts', 'setup-init', 2],
  ];

  for (const [file, bucket, calls] of expectations) {
    const text = await source(file);
    assert.equal(
      (text.match(/rateLimitStub\(/g) ?? []).length,
      calls,
      `${file}: 限流 DO 调用点数量不对（预期包含 ${bucket}）`,
    );
    assert.ok(text.includes(`'${bucket}'`), `${file}: 限流 DO 桶应是 ${bucket}`);
    assert.ok(text.includes('checkNativeRateLimit'), `${file}: 高频路径应使用原生限流绑定`);
  }
});

test('high-frequency routes do not import the rate limit DO helper', async () => {
  const websocket = await source('websocket.ts');
  assert.doesNotMatch(websocket, /rate-limit-object/, 'WebSocket 建连限流不应再走 DO');
  assert.match(websocket, /checkNativeRateLimit/, 'WebSocket 建连限流应使用原生绑定或本地降级');

  const setup = await source('setup.ts');
  assert.match(setup, /setupStatusRateLimit/, 'setup 状态查询应保留独立的高频限流入口');
  assert.match(setup, /setupInitRateLimit/, 'setup 初始化应保留 DO 限流');
});
