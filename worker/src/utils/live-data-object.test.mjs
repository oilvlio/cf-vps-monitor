import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('LIVE_DATA stub uses the v2 object name and an APAC location hint', () => {
  const calls = [];
  const namespace = {
    idFromName: name => ({ name, toString: () => name }),
    get: (id, options) => {
      calls.push({ name: id.name, options });
      return { id };
    },
  };
  const loader = createWorkerLoader();
  const { liveDataId, liveDataStub, LIVE_DATA_OBJECT_NAME, LIVE_DATA_LOCATION_HINT } =
    loader.load('worker/src/utils/live-data-object.ts');

  assert.equal(LIVE_DATA_OBJECT_NAME, 'global-v2');
  assert.equal(LIVE_DATA_LOCATION_HINT, 'apac-se');
  assert.equal(liveDataId(namespace).name, 'global-v2');
  liveDataStub(namespace);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'global-v2');
  assert.equal(calls[0].options.locationHint, 'apac-se');
});

test('no source file bypasses the shared LIVE_DATA object id', () => {
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes("idFromName('global')")) {
        offenders.push(full);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], 'LIVE_DATA 的 id 只能在 utils/live-data-object.ts 里拼');
});
