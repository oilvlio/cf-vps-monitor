import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScriptFunctions } from '../../scripts/test-support/typescript.mjs';

test('database startup exemptions include current assets and exclude obsolete icon roots', async () => {
  const { canServeWithoutDatabaseStartup } = await loadTypeScriptFunctions(new URL('../src/index.ts', import.meta.url), ['canServeWithoutDatabaseStartup'], {});
  for (const path of ['/assets/flags/us.svg', '/assets/logo/linux.svg', '/api/theme/assets/custom/logo.svg']) {
    assert.equal(canServeWithoutDatabaseStartup(path), true, path);
  }
  for (const path of ['/flags/us.svg', '/os-icons/linux.svg']) {
    assert.equal(canServeWithoutDatabaseStartup(path), false, path);
  }
});
