import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const service = createWorkerLoader().load('worker/src/services/read/live.ts');

function liveEnv(handler) {
  const requests = [];
  return {
    requests,
    env: {
      LIVE_DATA: {
        idFromName: () => 'live-data-id',
        get: () => ({
          fetch: async request => {
            requests.push(request);
            return handler(request);
          },
        }),
      },
    },
  };
}

test('live read: parsed snapshot carries metadata and honours include_hidden', async () => {
  const f = liveEnv(() => Response.json({
    online: ['a'],
    count: 1,
    data: { a: { cpu: 12 } },
    timestamp: 1700000000000,
    metadata_version: '7',
  }));
  const snapshot = await service.loadLiveSnapshot(f.env, false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    online: ['a'],
    data: { a: { cpu: 12 } },
    count: 1,
    timestamp: 1700000000000,
    metadata_version: '7',
  });
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url).searchParams.get('include_hidden'), null);

  const admin = liveEnv(() => Response.json({ online: ['h'], count: 1 }));
  await service.loadLiveSnapshot(admin.env, true);
  assert.equal(new URL(admin.requests[0].url).searchParams.get('include_hidden'), '1');
});

test('live read: DO errors and malformed payloads reject instead of fabricating offline state', async () => {
  for (const handler of [
    () => { throw new Error('DO unavailable'); },
    () => Response.json({ online: 'not-an-array', count: 1 }),
    () => new Response('not json', { status: 500 }),
    () => Response.json({ online: [], count: 0 }, { status: 503 }),
  ]) {
    await assert.rejects(service.loadLiveSnapshot(liveEnv(handler).env, false), { name: 'ReadUnavailableError' });
  }
});

test('live read: proxy request only rewrites include_hidden', () => {
  const anonymous = service.liveSnapshotProxyRequest(
    new Request('https://panel.test/api/live?include_hidden=1&r=42'),
    false,
  );
  const anonUrl = new URL(anonymous.url);
  assert.equal(anonUrl.searchParams.get('include_hidden'), null);
  assert.equal(anonUrl.searchParams.get('r'), '42');

  const admin = service.liveSnapshotProxyRequest(
    new Request('https://panel.test/api/live?r=42'),
    true,
  );
  assert.equal(new URL(admin.url).searchParams.get('include_hidden'), '1');
});

test('live read: entry and number helpers keep online/offline precedence', () => {
  const live = {
    online: ['a'],
    count: 2,
    data: { a: { cpu: 1 } },
    last_known: { a: { cpu: 99 }, b: { cpu: 2 } },
  };
  assert.equal(service.liveEntryFor(live, 'a').cpu, 1, '在线条目优先于 last_known');
  assert.equal(service.liveEntryFor(live, 'b').cpu, 2);
  assert.equal(service.liveEntryFor(live, 'missing'), null);
  assert.equal(service.liveNumber({ value: 3 }, 'value'), 3);
  assert.equal(service.liveNumber({ value: '4.5' }, 'value'), 4.5);
  assert.equal(service.liveNumber({ value: 'nope' }, 'value'), 0);
  assert.equal(service.liveNumber(null, 'value'), 0);
});

test('live read: every realtime/native path uses the shared reader', () => {
  const files = [
    'worker/src/routes/public.ts',
    'worker/src/routes/websocket.ts',
    'worker/src/monitor/services/nodes.ts',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.ok(
      !source.includes('https://do/live'),
      `${file} 不应自己拼 DO /live 请求，统一走 services/read/live`,
    );
  }
});
