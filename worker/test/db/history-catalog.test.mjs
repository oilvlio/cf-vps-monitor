import { snapshot } from '../../../scripts/test-support/catalog-snapshot.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  applyMigration,
  createRealPostgresDatabase,
  hasRealPostgres,
} from '../../../scripts/test-support/real-postgres.mjs';

/**
 * v2 收敛闸门：终态目录必须与已审核的黄金快照一致。
 *
 * 全新安装：只跑新的 1_schema.sql + 2_functions.sql。
 * 比较的是系统目录，不是文本：函数定义/ACL、父表列与约束、索引、RLS policy、
 * 触发器。子分区是运行期产物（名字带日期），只比较父表的 partition key。
 */

async function applyNew(client) {
  await applyMigration(client, '1_schema');
  await applyMigration(client, '2_functions');
}

async function buildSnapshot(apply) {
  const database = await createRealPostgresDatabase({ migrate: false });
  try {
    await apply(database.client);
    return await snapshot(database.client);
  } finally {
    await database.close();
  }
}

test('only the two terminal migrations ship', async () => {
  const migrationFiles = await readdir(new URL('../../../supabase/migrations/', import.meta.url));
  assert.deepEqual(migrationFiles.sort(), ['1_schema.sql', '2_functions.sql']);
});

const golden = JSON.parse(await readFile(new URL('../../../scripts/test-support/terminal-catalog.json', import.meta.url), 'utf8'));

test('public client RPC preserves billing contract on fresh install and migration replay', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  const database = await createRealPostgresDatabase();
  try {
    await database.client.query(`insert into public.clients (uuid, name, traffic_reset_day, auto_renewal, expired_at)
      values ('contract-node', 'Contract', 23, 1, null)`);
    for (const replay of [false, true]) {
      if (replay) await applyNew(database.client);
      const result = await database.client.query('select public.cfm_public_clients() as clients');
      const client = result.rows[0].clients.find(row => row.uuid === 'contract-node');
      assert.equal(client.traffic_reset_day, 23);
      assert.equal(client.auto_renewal, 1);
      assert.equal(client.expired_at, null);
      for (const key of ['token', 'token_hash', 'remark']) assert.equal(Object.hasOwn(client, key), false);
    }
  } finally {
    await database.close();
  }
});

test('fresh install matches the reviewed terminal catalog snapshot', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  assert.deepEqual(await buildSnapshot(applyNew), golden);
});

test('replaying new 1/2 on an existing v2 database preserves history', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  const database = await createRealPostgresDatabase({ migrate: false });
  try {
    await applyNew(database.client);
    await database.client.query(`
      insert into public.clients (uuid, name) values ('replay-node', 'Replay');
      insert into public.records (client, time, cpu) values ('replay-node', now(), 1.5);
    `);
    await applyNew(database.client);
    const rows = await database.client.query('select count(*)::integer as n from public.records');
    assert.equal(rows.rows[0].n, 1, 're-applying 1/2 must not drop v2 history');
  } finally {
    await database.close();
  }
});

test('retiring hide_price replays over legacy RPCs and preserves clients and history', { skip: !hasRealPostgres() && 'DATABASE_URL is required' }, async () => {
  const database = await createRealPostgresDatabase({ migrate: false });
  try {
    await applyNew(database.client);
    // Previous releases used string-literal SQL/PLpgSQL bodies (no catalog column
    // dependency). Warm those plans before replaying the schema in its own transaction.
    await database.client.query(`
      alter table public.clients add column hide_price smallint not null default 0;
      insert into public.clients (uuid, name, price, hide_price) values ('upgrade', 'Preserved', 12.5, 1);
      insert into public.records (client, time, cpu) values ('upgrade', now(), 3.5);
      create or replace function public.cfm_public_clients() returns jsonb language sql stable set search_path to public
      as $body$ select jsonb_agg(jsonb_build_object('uuid', uuid, 'price', price, 'hide_price', hide_price)) from clients $body$;
      create or replace function public.cfm_admin_clients() returns jsonb language sql stable set search_path to public
      as $body$ select jsonb_agg(to_jsonb(t)) from (select uuid, price, hide_price from clients) t $body$;
      create or replace function public.cfm_update_client_returning(input_uuid text, input_patch jsonb) returns jsonb language plpgsql set search_path to public
      as $body$ declare row_data clients%rowtype; begin
        update clients set hide_price = coalesce((input_patch->>'hide_price')::smallint, hide_price)
        where uuid = input_uuid returning * into row_data; return to_jsonb(row_data);
      end $body$;
      select public.cfm_public_clients(), public.cfm_admin_clients(), public.cfm_update_client_returning('upgrade', '{}');
    `);
    await applyNew(database.client);
    await applyNew(database.client);
    const result = await database.client.query(`select
      public.cfm_public_clients() as public_clients,
      public.cfm_admin_clients() as admin_clients,
      public.cfm_update_client_returning('upgrade', '{"name":"Updated"}') as updated,
      (select count(*)::integer from public.records where client = 'upgrade') as history_count,
      (select count(*)::integer from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'hide_price') as retired_columns
    `);
    const row = result.rows[0];
    assert.equal(row.retired_columns, 0);
    assert.equal(row.history_count, 1);
    for (const client of [row.public_clients[0], row.admin_clients[0], row.updated]) {
      assert.equal(client.price, 12.5);
      assert.equal(client.uuid, 'upgrade');
      assert.equal(Object.hasOwn(client, 'hide_price'), false);
    }
    assert.equal(row.updated.name, 'Updated');
    assert.deepEqual(await snapshot(database.client), golden);
  } finally {
    await database.close();
  }
});
