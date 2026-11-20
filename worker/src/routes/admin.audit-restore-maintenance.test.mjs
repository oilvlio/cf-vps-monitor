import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';
import { encryptBackup } from '../utils/backup.ts';

test('AUD-06/R-D05: restoring a configuration backup refreshes agent policies after the data is restored', async () => {
  const messages = [];
  const jobs = [];
  let restored = false;
  const db = {
    getBackupConfigurationSnapshot: async () => ({ clients: [], settings: {}, ping_tasks: [],
      offline_notifications: [], expiry_notifications: [], load_notifications: [] }),
    listClients: async () => [], getAllSettings: async () => ({}),
    listPingTasks: async () => [],
    listOfflineNotifications: async () => [], listExpiryNotifications: async () => [], listLoadNotifications: async () => [],
    restoreBackupData: async () => { restored = true; },
    cleanupOrphanClientData: async () => ({}), insertAuditLog: async () => {},
  };
  const env = { LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: async request => {
    messages.push({ path: new URL(request.url).pathname, body: await request.json().catch(() => null), restored });
    return Response.json({ success: true });
  } }) } };
  const { adminRoutes } = createWorkerLoader({ db }).load('worker/src/routes/admin.ts');
  const encrypted = await encryptBackup({
    schema: 'cf-monitor.backup', version: '2.0.0', scope: 'configuration',
    timestamp: '2026-09-06T00:00:00.000Z',
    clients: [{ uuid: 'node-a', name: 'Synthetic A' }, { uuid: 'node-b', name: 'Synthetic B' }],
  }, 'synthetic-backup-password');
  assert.equal(encrypted.ok, true);
  const response = await adminRoutes.fetch(new Request('https://panel.example.test/upload/backup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      backup: encrypted.encryptedBackup, backup_password: 'synthetic-backup-password',
      confirm_restore: true, acknowledge_overwrite: true,
    }),
  }), env, { waitUntil: job => jobs.push(job), passThroughOnException() {} });
  assert.equal(response.status, 200, await response.text());
  while (jobs.length) await Promise.all(jobs.splice(0));
  assert.ok(messages.some(item => item.restored && item.path === '/policy-refresh'), 'policies refresh only after the restore committed');
});

test('AUD-07: manual maintenance preserves unfinished batches from every history cleanup', async () => {
  let rawPingBefore;
  let pingRollupBefore;
  const db = {
    getSettingsByKeys: async () => ({ ping_record_preserve_time: '168', ping_rollup_preserve_time: '4320' }),
    getExpiredRowCounts: async () => ({ records: 25000, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0, ping_rollup: 0, audit_logs: 0 }),
    buildHistoryRollup: async () => ({}),
    buildPingRollup: async () => ({}),
    deleteOldRecords: async () => ({ records: 100, gpu_records: 0, gpu_snapshots: 0, has_more: true }),
    deleteOldPingRecords: async (_database, before) => { rawPingBefore = before; return { ping_records: 0, ping_snapshots: 0, has_more: false }; },
    deleteOldPingRollup: async (_database, before) => { pingRollupBefore = before; return { ping_rollup: 0, has_more: false }; },
    deleteOldAuditLogs: async () => ({ audit_logs: 0, has_more: false }),
    cleanupOrphanClientData: async () => ({}), insertAuditLog: async () => {},
  };
  const { runMaintenanceCleanup } = createWorkerLoader({ db, expose: {
    'worker/src/routes/admin.ts': ['runMaintenanceCleanup'],
  } }).load('worker/src/routes/admin.ts');
  const now = new Date('2026-09-06T12:00:00.000Z');
  const result = await runMaintenanceCleanup({}, 'synthetic-admin', now);
  assert.equal(result.has_more, true);
  assert.ok(Object.values(result.deleted).every(value => typeof value === 'number'));
  assert.equal(result.deleted.records, 100);
  assert.equal(rawPingBefore, new Date(now.getTime() - 168 * 60 * 60 * 1000).toISOString());
  assert.equal(pingRollupBefore, new Date(now.getTime() - 4320 * 60 * 60 * 1000).toISOString());
});
