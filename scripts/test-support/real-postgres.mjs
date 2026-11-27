import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;

const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);

/**
 * 真实 Postgres 测试夹具。
 *
 * 每个调用创建一个独立数据库（名字带 pid + 随机后缀），跑完整迁移，测试结束
 * `with (force)` 删除。这样不同的 `*.test.mjs` 可以并行跑，也不会污染 CI 的
 * 主库。并发用例再通过 `connect()` 拿同一数据库的额外连接。
 *
 * 没有 DATABASE_URL 时不要 import 这个模块的建库函数；测试文件应先用
 * `hasRealPostgres()` 判断并 skip。
 */

export function hasRealPostgres() {
  return typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.trim() !== '';
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// 角色是 cluster 级的，只需要建一次；schema 授权和默认权限是 database 级的，
// 必须在新建的测试库里再执行一遍。
async function ensureClusterRoles(client) {
  await client.query(`
    do $$
    begin
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      exception when duplicate_object then null;
      end;
      begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      exception when duplicate_object then null;
      end;
      begin
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      exception when duplicate_object then null;
      end;
    end $$;
  `);
}

async function ensureDatabaseGrants(client) {
  await client.query(`
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
  `);
}

export async function applyApplicationMigrations(client) {
  const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  }
}

/** Add only the dated partitions required by explicit historical test fixtures. */
export async function ensureHistoryFixturePartitions(client, times) {
  const dates = [...new Set(times.map(value => new Date(value).toISOString().slice(0, 10)))];
  for (const table of ['records', 'ping_snapshots']) {
    for (const day of dates) {
      const next = new Date(`${day}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const end = next.toISOString().slice(0, 10);
      const name = `${table}_${day.replaceAll('-', '')}`;
      await client.query(`create table if not exists public."${name}" partition of public.${table}
        for values from ('${day} 00:00:00+00') to ('${end} 00:00:00+00')`);
    }
  }
}

/** Apply one migration by version. Mirrors `/db-init` re-running a changed file. */
export async function applyMigration(client, version) {
  const sql = await readFile(new URL(`${version}.sql`, migrationsDir), 'utf8');
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw new Error(`${version}.sql: ${error.message}`, { cause: error });
  }
}

/**
 * 与 scripts/test-support/postgres.mjs 的 `rpc` 同签名，真实 pg.Client 也能用。
 */
export async function rpc(client, name, args = {}) {
  if (!/^cfm_[a-z0-9_]+$/.test(name)) throw new Error('Unexpected test RPC name');
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  for (const [key] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error('Unexpected test argument name');
  }
  const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
  const values = entries.map(([, value]) => (value && typeof value === 'object' ? JSON.stringify(value) : value));
  const result = await client.query(`select public.${name}(${parameters}) as result`, values);
  return result.rows[0].result;
}

/**
 * 创建一个隔离的真实 Postgres 数据库。
 *
 * @returns {Promise<{
 *   connectionString: string,
 *   client: pg.Client,
 *   query: Function,
 *   connect: () => Promise<pg.Client>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function createRealPostgresDatabase({ migrate = true } = {}) {
  if (!hasRealPostgres()) throw new Error('DATABASE_URL is required for real Postgres tests');

  const baseConnectionString = process.env.DATABASE_URL.trim();
  const databaseName = `cfm_test_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const admin = new Client({ connectionString: baseConnectionString });
  await admin.connect();

  const extraClients = [];
  let databaseCreated = false;
  try {
    await ensureClusterRoles(admin);
    await admin.query(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
  } finally {
    await admin.end().catch(() => {});
  }

  const connectionString = withDatabase(baseConnectionString, databaseName);
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("set search_path = public");
    await client.query("set timezone = 'UTC'");
    await ensureDatabaseGrants(client);
    if (migrate) await applyApplicationMigrations(client);
  } catch (error) {
    await client.end().catch(() => {});
    await dropDatabase(baseConnectionString, databaseName).catch(() => {});
    throw error;
  }

  let closed = false;
  return {
    connectionString,
    client,
    query: (...args) => client.query(...args),
    async connect() {
      const extra = new Client({ connectionString });
      await extra.connect();
      await extra.query('set search_path = public');
      await extra.query("set timezone = 'UTC'");
      extraClients.push(extra);
      return extra;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(extraClients.map(extra => extra.end().catch(() => {})));
      await client.end().catch(() => {});
      await dropDatabase(baseConnectionString, databaseName).catch(() => {});
    },
  };
}

async function dropDatabase(baseConnectionString, databaseName) {
  const admin = new Client({ connectionString: baseConnectionString });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end().catch(() => {});
  }
}
