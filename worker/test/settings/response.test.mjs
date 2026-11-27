import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

test('full and every scoped settings response redact all schema-sensitive fields, including cached responses', async () => {
  const stored = {
    telegram_bot_token: '123456:PRIVATE_BOT_TOKEN', telegram_chat_id: '-1234567890123',
    email_smtp_username: 'private-account@example.com', email_smtp_password: 'PRIVATE_SMTP_PASSWORD',
    webhook_url: 'https://hooks.example.com/PRIVATE_PATH?token=PRIVATE_QUERY',
    webhook_secret: 'PRIVATE_WEBHOOK_SECRET', webhook_password: 'PRIVATE_WEBHOOK_PASSWORD',
    webhook_headers_json: '{"Authorization":"Bearer PRIVATE_HEADER"}', site_logo_data: 'PRIVATE_BINARY',
  };
  const loader = createWorkerLoader({ db: {
    getAllSettings: async () => stored,
    getSettingsByKeys: async (_db, keys) => Object.fromEntries(keys.map(key => [key, stored[key]]).filter(([, value]) => value !== undefined)),
    getHistoryStorageBytes: async () => null, listClientIds: async () => [],
  }, expose: { 'worker/src/routes/admin.ts': ['SETTINGS_SCOPE_KEYS'] } });
  const { adminRoutes, SETTINGS_SCOPE_KEYS } = loader.load('worker/src/routes/admin.ts');
  const { SETTING_SCHEMA } = loader.load('worker/src/settings/schema.ts');
  const { redactAdminSettings } = loader.load('worker/src/settings/response.ts');
  const projected = redactAdminSettings(stored);
  assert.equal(projected.webhook_url_host, 'hooks.example.com');
  assert.equal(projected.webhook_headers_set, 'true');
  assert.equal(projected.email_smtp_username_set, 'true');
  assert.ok(projected.email_smtp_username_preview.includes('********'));
  assert.equal(stored.email_smtp_password, 'PRIVATE_SMTP_PASSWORD', 'internal settings remain raw');
  for (const query of ['', '?refresh=1', ...Object.keys(SETTINGS_SCOPE_KEYS).flatMap(scope => [`?scope=${scope}`, `?scope=${scope}`])]) {
    const response = await adminRoutes.request(`https://monitor.example/settings${query}`, {}, {});
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    for (const [key, definition] of Object.entries(SETTING_SCHEMA)) {
      if (definition.sensitive) assert.equal(Object.hasOwn(body, key), false, `${query}: ${key}`);
    }
    for (const value of Object.values(stored)) assert.ok(!JSON.stringify(body).includes(value), query);
  }
});

test('saving redacted settings back preserves stored secrets and accepts a new SMTP username', async () => {
  const stored = { email_smtp_username: 'saved@example.com', email_smtp_password: 'saved-password-value', telegram_bot_token: 'saved-token-value' };
  const writes = [];
  const loader = createWorkerLoader({ db: {
    getSettingsByKeys: async () => stored,
    setSettings: async (_db, patch) => { writes.push(patch); },
    insertAuditLog: async () => {},
  } });
  const { redactAdminSettings } = loader.load('worker/src/settings/response.ts');
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');
  const response = await adminRoutes.request('https://monitor.example/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...redactAdminSettings(stored), email_smtp_username: '' }),
  }, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).noop, true);
  assert.equal(writes.length, 0);
  const jobs = [];
  const updated = await adminRoutes.fetch(new Request('https://monitor.example/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_smtp_username: 'new@example.com' }),
  }), {}, { waitUntil: job => jobs.push(job) });
  assert.equal(updated.status, 200);
  await Promise.all(jobs);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].email_smtp_username, 'new@example.com');
  assert.equal(Object.hasOwn(writes[0], 'email_smtp_password'), false);
});

test('fresh session validation bypasses warm successful authorization cache after revocation', async () => {
  let version = 1;
  let reads = 0;
  const loader = createWorkerLoader({ db: { getUserByUuid: async () => {
    reads++;
    return { uuid: 'admin', username: 'fixture', session_version: version };
  } } });
  const { validateAdminSession } = loader.load('worker/src/auth/admin-session.ts');
  const payload = { userId: 'admin', username: 'fixture', sessionVersion: 1 };
  assert.ok(await validateAdminSession(loader.database, payload));
  version = 2;
  assert.equal(await validateAdminSession(loader.database, payload, { fresh: true }), null);
  assert.equal(reads, 2);
});
