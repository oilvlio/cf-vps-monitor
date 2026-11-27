import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

const migrations = new URL('../../supabase/migrations/', import.meta.url);

/**
 * Apply every bundled migration in version order. `before` maps a version to a
 * hook that runs immediately before that migration, which lets tests recreate
 * a legacy object that the current migration is expected to replace.
 */
export async function applyApplicationMigrations(database, { before = {} } = {}) {
  const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (before[version]) await before[version]();
    const sql = await readFile(new URL(file, migrations), 'utf8');
    await database.exec(`begin;\n${sql}\ncommit;`);
  }
}

/** Add only the dated partitions required by explicit historical test fixtures. */
export async function ensureHistoryFixturePartitions(database, times) {
  const dates = [...new Set(times.map(value => new Date(value).toISOString().slice(0, 10)))];
  for (const table of ['records', 'ping_snapshots']) {
    for (const day of dates) {
      const next = new Date(`${day}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const end = next.toISOString().slice(0, 10);
      const name = `${table}_${day.replaceAll('-', '')}`;
      await database.exec(`create table if not exists public."${name}" partition of public.${table}
        for values from ('${day} 00:00:00+00') to ('${end} 00:00:00+00')`);
    }
  }
}

/**
 * Apply one named migration by itself. `/db-init` tracks a checksum per
 * version, so a real replay re-runs only migrations whose SQL changed. Used by
 * tests that need to prove the latest layout migration is idempotent without
 * re-running the legacy baseline (which intentionally conflicts with the v2
 * layout).
 */
export async function applyMigration(database, version) {
  const sql = await readFile(new URL(`${version}.sql`, migrations), 'utf8');
  await database.exec(`begin;\n${sql}\ncommit;`);
}

export async function createTestDatabase({ migrate = true } = {}) {
  const database = new PGlite();
  try {
    await database.exec(`
      set timezone = 'UTC';
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to service_role;
      alter default privileges in schema public grant all on sequences to service_role;
    `);
    if (migrate) await applyApplicationMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function rpc(database, name, args = {}) {
  if (!/^cfm_[a-z0-9_]+$/.test(name)) throw new Error('Unexpected test RPC name');
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  for (const [key] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error('Unexpected test argument name');
  }
  const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value);
  const result = await database.query(`select public.${name}(${parameters}) as result`, values);
  return result.rows[0].result;
}
