import assert from 'node:assert/strict';
import test from 'node:test';
import { generateToken } from '../src/auth/jwt.ts';
import { generateMfaToken } from '../src/auth/mfa-token.ts';
import { createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';
import { rpc } from '../../scripts/test-support/postgres.mjs';

// 与 PostgreSQL percentile_cont 一致的线性插值分位数
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
};
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test('Ping stats are computed server-side and buckets keep an unrounded median', { timeout: 180000 }, async t => {
  const f = await createRuntimeFixture();
  t.after(() => f.close());
  await rpc(f.database, 'cfm_create_initial_admin', {
    p_uuid: 'stats-admin', p_username: 'stats-admin', p_password_hash: 'synthetic-unused-password-hash',
  });
  const user = (await f.database.query('select uuid, username, session_version from users')).rows[0];
  const identity = { userId: user.uuid, username: user.username, sessionVersion: user.session_version };
  const session = await generateToken(user.uuid, user.username, user.session_version, runtimeSecrets);
  const stepUp = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets);
  const csrf = 'b'.repeat(32);
  const headers = {
    'Content-Type': 'application/json', Origin: 'https://panel.example.test', 'CF-Connecting-IP': '1.1.1.1',
    Cookie: `cf_monitor_session=${session}; cf_monitor_csrf=${csrf}; cf_monitor_mfa_stepup=${stepUp}`, 'X-CSRF-Token': csrf,
  };
  await f.database.query("insert into clients(uuid,name,token) values ('node-s','Node S','synthetic-s')");

  let response = await f.fetch('/api/admin/ping/add', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'T', type: 'icmp', target: '1.1.1.1', all_clients: true, clients: [] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const taskId = (await response.json()).task.id;

  const insert = (timeMs, value) => f.database.query(
    `insert into ping_snapshots(client, time, values_json) values ('node-s', '${new Date(timeMs).toISOString()}', '{"${taskId}": ${value}}'::jsonb)`);

  const now = Date.now();
  // 数据集 A：最近 20 分钟、每分钟一个样本，含 1 个丢包(-1)和 1 个尖峰(40)
  const a = [3, 3, 3, 4, 2, 3, 3, 40, 3, 3, 3, 4, 3, 2, 3, 3, -1, 3, 3, 5];
  for (let i = 0; i < a.length; i++) await insert(now - (i + 1) * 60_000, a[i]);
  // 数据集 B：约 2 小时前、与 360s 桶对齐的一整桶 6 个样本，中位数 3.5（非整数）
  const bucketStart = (Math.floor(now / 360_000) - 20) * 360_000;
  const b = [2, 3, 4, 5, 50, 3];
  for (let i = 0; i < b.length; i++) await insert(bucketStart + i * 60_000, b[i]);

  const get = (path) => f.fetch(`/api/records/ping/${path}`, { headers });
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());

  // ---- 统计：只覆盖数据集 A 的窗口 ----
  response = await get(`stats?uuid=node-s&task_ids=${taskId},9999&start=${iso(now - 30 * 60_000)}&end=${iso(now)}&include_hidden=1`);
  assert.equal(response.status, 200, await response.clone().text());
  const stats = await response.json();
  assert.deepEqual(Object.keys(stats), [String(taskId)], '没有数据的任务不出现');
  const s = stats[taskId];
  const ok = a.filter(v => v >= 0);
  const mean = ok.reduce((x, y) => x + y, 0) / ok.length;
  assert.equal(s.samples, 20);
  assert.equal(s.success_count, 19);
  assert.equal(s.loss_count, 1);
  near(s.loss_rate, 5, 'loss_rate');
  near(s.avg_latency, mean, 'avg');
  assert.equal(s.min_latency, 2);
  assert.equal(s.max_latency, 40);
  near(s.p50_latency, pct(ok, 0.5), 'p50');
  near(s.p75_latency, pct(ok, 0.75), 'p75');
  near(s.jitter, Math.sqrt(ok.reduce((x, y) => x + (y - mean) ** 2, 0) / (ok.length - 1)), 'jitter(stddev_samp)');

  // 窗口外的数据不计入；参数校验
  response = await get(`stats?uuid=node-s&task_ids=${taskId}&start=${iso(now - 5 * 3600_000)}&end=${iso(now - 4 * 3600_000)}&include_hidden=1`);
  assert.deepEqual(await response.json(), {});
  assert.equal((await get(`stats?uuid=node-s&start=${iso(now - 60_000)}&end=${iso(now)}&include_hidden=1`)).status, 400, '缺 task_ids');
  assert.equal((await get(`stats?uuid=node-s&task_ids=${taskId}&start=${iso(now)}&end=${iso(now - 60_000)}&include_hidden=1`)).status, 400, '区间反了');

  // ---- 24h 窗口：按 360s 分桶，代表值是不取整的中位数 ----
  const batch = async (startMs, endMs) => {
    const r = await get(`batch?uuid=node-s&task_ids=${taskId}&limit=1000&start=${iso(startMs)}&end=${iso(endMs)}&include_hidden=1`);
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json())[taskId] ?? [];
  };
  const day = await batch(now - 24 * 3600_000, now);
  const bucket = day.find(r => Date.parse(r.time) === bucketStart);
  assert.ok(bucket, '应有对齐的 360s 桶');
  near(bucket.value, 3.5, 'bucket value = median');
  near(bucket.p50_latency, 3.5, 'p50_latency');
  near(bucket.avg_latency, b.reduce((x, y) => x + y, 0) / b.length, 'avg_latency');
  near(bucket.p75_latency, pct(b, 0.75), 'p75_latency');
  assert.equal(bucket.min_latency, 2);
  assert.equal(bucket.max_latency, 50);
  assert.equal(bucket.sample_count, 6);
  assert.equal(bucket.loss_count, 0);
  assert.ok(day.every(r => r.sample_count !== undefined), '24h 窗口整体是分桶结果');

  // ---- 12h 以内读原始；边界留余量，start/end 多出几毫秒也不会被当成分桶 ----
  const raw12 = await batch(now - 12 * 3600_000, now);
  assert.equal(raw12.length, a.length + b.length, '12h 内返回全部原始样本');
  assert.ok(raw12.every(r => r.sample_count === undefined && Number.isInteger(r.value)), '原始点是整数且没有分桶列');
  assert.ok(raw12.some(r => r.value === -1), '原始点里丢包仍是 -1');
  const rawSlack = await batch(now - 12 * 3600_000, now + 5);
  assert.equal(rawSlack.length, raw12.length);
  const bucketed13h = await batch(now - 13 * 3600_000, now);
  assert.ok(bucketed13h.length > 0 && bucketed13h.every(r => r.sample_count !== undefined), '超过 12h10m 才分桶');
});
