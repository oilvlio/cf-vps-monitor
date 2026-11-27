import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTypeScriptFunctions } from '../../../scripts/test-support/typescript.mjs';
import { createTestDatabase } from '../../../scripts/test-support/postgres.mjs';

test('history reset preflight detects the same layouts as the destructive schema guard', async () => {
  const database = await createTestDatabase();
  try {
    const { historyResetRequired } = await loadTypeScriptFunctions(new URL('../../src/routes/setup.ts', import.meta.url), ['historyResetRequired'], {
      runSupabaseQuery: async (_project, _token, sql) => (await database.query(sql)).rows,
      extractQueryRows: rows => rows,
    });
    assert.equal(await historyResetRequired('project', 'token'), false);
    await database.exec('create table public.gpu_records (client text)');
    assert.equal(await historyResetRequired('project', 'token'), true);
    await database.exec('drop table public.gpu_records');
    await database.exec('alter table public.ping_snapshots add column batch_hash text');
    assert.equal(await historyResetRequired('project', 'token'), true);
    const source = await readFile(new URL('../../src/routes/setup.ts', import.meta.url), 'utf8');
    assert.ok(source.indexOf('await historyResetRequired(projectRef, accessToken)') < source.indexOf('const result = await applyBundledMigrations'));
    assert.match(source, /resetRequired && payload\.confirmHistoryReset !== true/);
  } finally {
    await database.close();
  }
});

test('invalid preflight results fail closed', async () => {
  const { historyResetRequired } = await loadTypeScriptFunctions(new URL('../../src/routes/setup.ts', import.meta.url), ['historyResetRequired'], {
    runSupabaseQuery: async () => [], extractQueryRows: rows => rows,
  });
  await assert.rejects(historyResetRequired('project', 'token'), /no migrations were executed/);
});
