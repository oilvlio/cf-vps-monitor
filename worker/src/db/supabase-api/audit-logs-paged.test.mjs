import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc, applyApplicationMigrations } from '../../../../scripts/test-support/postgres.mjs';

const { listSupabaseAuditLogsPaged } = await import('./client.ts');

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_secret_key',
};

async function seed(database) {
  // 80 条 offline_notify 与 70 条 settings_edit 交错写入，
  // 用来验证「筛选后每页都被匹配记录填满」，而不是只在某一页里剩几条。
  for (let i = 0; i < 150; i += 1) {
    const offline = i % 2 === 0 || i < 20;
    await database.query(
      `insert into audit_logs (time, "user", action, detail) values ($1::timestamptz, $2, $3, $4)`,
      [
        new Date(Date.UTC(2026, 10, 1) + i * 60000).toISOString(),
        offline ? 'system' : 'admin',
        offline ? 'offline_notify' : 'settings_edit',
        offline ? `已发送离线告警: Node${i}，离线 ${i} 分钟` : `修改系统设置: key_${i}`,
      ],
    );
  }
}

test('cfm_audit_logs_paged 按动作筛选：每一页都由匹配记录填满', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);
    const total = (await database.query(`select count(*)::int as n from audit_logs where action = 'offline_notify'`)).rows[0].n;
    assert.ok(total > 50, '测试数据需要超过一页');

    const first = await rpc(database, 'cfm_audit_logs_paged', {
      input_page: 1, input_limit: 50, input_action: 'offline_notify',
    });
    assert.equal(first.logs.length, 50);
    assert.ok(first.logs.every((log) => log.action === 'offline_notify'));
    assert.equal(first.has_more, true);

    const second = await rpc(database, 'cfm_audit_logs_paged', {
      input_page: 2, input_limit: 50, input_action: 'offline_notify',
    });
    assert.equal(second.logs.length, total - 50);
    assert.equal(second.has_more, false);
    assert.equal(second.total, total);
    // 两页之间不重复、按时间倒序衔接。
    const ids = new Set([...first.logs, ...second.logs].map((log) => log.id));
    assert.equal(ids.size, total);
    assert.ok(first.logs[first.logs.length - 1].time >= second.logs[0].time);
  } finally {
    await database.close();
  }
});

test('cfm_audit_logs_paged 关键词在 ID / 用户 / 动作 / 详情中不区分大小写匹配，并与动作筛选叠加', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);
    const byDetail = await rpc(database, 'cfm_audit_logs_paged', { input_search: 'NODE12' });
    assert.ok(byDetail.logs.length > 0);
    assert.ok(byDetail.logs.every((log) => /node12/i.test(log.detail)));

    const byUser = await rpc(database, 'cfm_audit_logs_paged', { input_search: 'ADMIN', input_limit: 500 });
    assert.ok(byUser.logs.every((log) => log.user === 'admin'));

    const byAction = await rpc(database, 'cfm_audit_logs_paged', { input_search: 'settings_', input_limit: 500 });
    assert.ok(byAction.logs.every((log) => log.action === 'settings_edit'));

    const firstId = byAction.logs[0].id;
    const byId = await rpc(database, 'cfm_audit_logs_paged', { input_search: String(firstId), input_limit: 500 });
    assert.ok(byId.logs.some((log) => log.id === firstId));

    const combined = await rpc(database, 'cfm_audit_logs_paged', {
      input_action: 'offline_notify', input_search: 'admin', input_limit: 500,
    });
    assert.equal(combined.logs.length, 0);
    assert.equal(combined.has_more, false);
    assert.equal(combined.total, 0);
  } finally {
    await database.close();
  }
});

test('cfm_audit_logs_paged 把关键词当字面量：通配符不会命中所有行', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);
    await database.query(`insert into audit_logs ("user", action, detail) values ('admin', 'x', '100% done'), ('admin', 'x', 'a\\b')`);

    const percent = await rpc(database, 'cfm_audit_logs_paged', { input_search: '%', input_limit: 500 });
    assert.deepEqual(percent.logs.map((log) => log.detail), ['100% done']);

    const backslash = await rpc(database, 'cfm_audit_logs_paged', { input_search: '\\', input_limit: 500 });
    assert.deepEqual(backslash.logs.map((log) => log.detail), ['a\\b']);

    // 数据里的 key_<n> 才含下划线；单独的 "_" 只应命中含下划线的行，而不是任意单字符。
    const underscore = await rpc(database, 'cfm_audit_logs_paged', { input_search: '_', input_limit: 500 });
    assert.ok(underscore.logs.length > 0);
    assert.ok(underscore.logs.every((log) => `${log.user}${log.action}${log.detail}`.includes('_')));
  } finally {
    await database.close();
  }
});

test('cfm_audit_logs_paged 返回全表动作列表，且不随筛选条件变化', async () => {
  const database = await createTestDatabase();
  try {
    await seed(database);
    await database.query(`insert into audit_logs ("user", action, detail) values ('system', '', 'no action')`);
    const filtered = await rpc(database, 'cfm_audit_logs_paged', { input_action: 'offline_notify', input_search: 'zzz-no-match' });
    assert.deepEqual(filtered.actions, ['offline_notify', 'settings_edit']);
    assert.equal(filtered.logs.length, 0);
  } finally {
    await database.close();
  }
});

test('升级：旧签名 (integer, integer) 会被移除，新函数不产生重载歧义', async () => {
  const database = await createTestDatabase();
  try {
    // 模拟已部署的旧库：先装回旧版两参数函数，再重新应用当前迁移（Setup 在 checksum 变化时会这样做）。
    await database.exec(`
      create function public.cfm_audit_logs_paged(input_page integer default 1, input_limit integer default 50)
      returns jsonb language sql as $$ select '{"legacy":true}'::jsonb $$;
    `);
    await applyApplicationMigrations(database);
    const { rows } = await database.query(
      `select pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'cfm_audit_logs_paged'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].args, /input_action text/);
    // 只传旧的两个命名参数仍然可以调用（沿用默认值）。
    const legacy = await rpc(database, 'cfm_audit_logs_paged', { input_page: 1, input_limit: 5 });
    assert.deepEqual(legacy.logs, []);
  } finally {
    await database.close();
  }
});

test('listSupabaseAuditLogsPaged 把筛选条件映射成 RPC 参数，空值传 null', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || 'null') });
    return Response.json({ logs: [], total: 0, has_more: false, actions: [] });
  };
  try {
    await listSupabaseAuditLogsPaged(ENV, 2, 50, { action: 'offline_notify', search: 'Low' });
    await listSupabaseAuditLogsPaged(ENV, 1, 20);
  } finally {
    globalThis.fetch = original;
  }
  assert.match(calls[0].url, /rpc\/cfm_audit_logs_paged$/);
  assert.deepEqual(calls[0].body, { input_page: 2, input_limit: 50, input_action: 'offline_notify', input_search: 'Low' });
  assert.deepEqual(calls[1].body, { input_page: 1, input_limit: 20, input_action: null, input_search: null });
});
