import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../generated/supabase-migrations.ts';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

const migration = await readFile(new URL('../../../../supabase/migrations/2_functions.sql', import.meta.url), 'utf8');
const generated = BUNDLED_SUPABASE_MIGRATIONS.find(({ version }) => version === '2_functions')?.sql;
assert.ok(generated);

// 返回类型由 boolean 改为 jsonb，必须显式 drop 后再重建，否则重放迁移会失败。
for (const source of [migration, generated]) {
  assert.match(source, /drop function if exists public\.cfm_mark_client_token_used\(text, text\);/i);
  assert.match(source, /create or replace function public\.cfm_mark_client_token_used\(input_uuid text, input_ip text default ''\)\s*returns jsonb/i);
  assert.match(source, /'previous_ip', nullif\(previous_value, ''\)/i);
  assert.match(source, /revoke all on function public\.cfm_mark_client_token_used\(text, text\) from public, anon, authenticated;/i);
  assert.match(source, /grant execute on function public\.cfm_mark_client_token_used\(text, text\) to service_role/i);
}

test('mark client token used returns the authoritative previous IP and throttles', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`set role service_role;
      insert into clients(uuid, name, token_last_used_at, token_last_used_ip)
      values
        ('changed', 'Changed node', now() - interval '1 hour', '216.236.61.39'),
        ('initial', 'Initial node', null, null),
        ('throttled', 'Throttled node', now(), '203.0.113.9');`);

    // 首次上报时旧值即被替换：previous_ip 返回更新前的权威旧 IP。
    const first = await rpc(database, 'cfm_mark_client_token_used', {
      input_uuid: 'changed', input_ip: '216.236.60.167',
    });
    assert.deepEqual(first, { updated: true, previous_ip: '216.236.61.39' });

    // 15 分钟节流窗口内的第二次上报不再更新，也不返回旧 IP。
    const throttled = await rpc(database, 'cfm_mark_client_token_used', {
      input_uuid: 'changed', input_ip: '216.236.60.167',
    });
    assert.deepEqual(throttled, { updated: false, previous_ip: null });

    // 节流窗口内传入的 IP 不应覆盖已写入的值。
    const stored = (await database.query(
      "select token_last_used_ip from clients where uuid = 'changed'")).rows[0].token_last_used_ip;
    assert.equal(stored, '216.236.60.167');

    // 首次使用没有旧 IP：previous_ip 为 null，调用方据此跳过通知。
    const initial = await rpc(database, 'cfm_mark_client_token_used', {
      input_uuid: 'initial', input_ip: '198.51.100.4',
    });
    assert.deepEqual(initial, { updated: true, previous_ip: null });

    // 窗口未过期：即便 IP 变化也不更新、不误报。
    const fresh = await rpc(database, 'cfm_mark_client_token_used', {
      input_uuid: 'throttled', input_ip: '198.51.100.7',
    });
    assert.deepEqual(fresh, { updated: false, previous_ip: null });

    // 未知 uuid 不报错，返回 updated=false。
    const missing = await rpc(database, 'cfm_mark_client_token_used', {
      input_uuid: 'does-not-exist', input_ip: '198.51.100.9',
    });
    assert.deepEqual(missing, { updated: false, previous_ip: null });
  } finally {
    await database.close();
  }
});

test('mark client token used replays cleanly and stays service_role only', async () => {
  const database = await createTestDatabase();
  try {
    // 迁移可重复应用（setup 会重放全部迁移），且权限保持只授予 service_role。
    const { rows } = await database.query(`select
      has_function_privilege('anon', p.oid, 'execute') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
      has_function_privilege('service_role', p.oid, 'execute') as service_execute
      from pg_proc p
      where p.oid = to_regprocedure('public.cfm_mark_client_token_used(text,text)')`);
    assert.deepEqual(rows, [{ anon_execute: false, authenticated_execute: false, service_execute: true }]);

    for (const role of ['anon', 'authenticated']) {
      await database.exec(`set role ${role}`);
      try {
        await assert.rejects(rpc(database, 'cfm_mark_client_token_used', {
          input_uuid: 'any', input_ip: '198.51.100.1',
        }), { code: '42501' });
      } finally { await database.exec('reset role'); }
    }
  } finally {
    await database.close();
  }
});
