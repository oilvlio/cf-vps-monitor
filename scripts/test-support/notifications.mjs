import * as notificationDispatch from '../../worker/src/utils/notification-dispatch.ts';
import * as offline from '../../worker/src/utils/offline-notification.ts';
import { rotateScheduledItems, scheduledItems } from '../../worker/src/utils/scheduled-budget.ts';
import { loadTypeScriptFunctions } from './typescript.mjs';
import { rpc } from './postgres.mjs';

export async function notificationHarness(database, transport, databaseOverrides = {}) {
  const state = { now: new Date('2026-09-06T00:00:00Z'), online: false, channel: 'email' };
  const message = kind => input => ({ subject: `${kind}:${input.nodeName || input.name}`, body: kind });
  const clients = [
    { uuid: 'node-a', name: 'A', created_at: '2026-01-01T00:00:00Z', expired_at: '2026-09-10T00:00:00Z' },
    { uuid: 'node-b', name: 'B', created_at: '2026-01-01T00:00:00Z', expired_at: '2026-09-10T00:00:00Z' },
  ];
  const methods = {
    listOfflineNotifications: () => rpc(database, 'cfm_offline_notifications'),
    listExpiryNotifications: () => rpc(database, 'cfm_expiry_notifications'),
    listLoadNotifications: () => rpc(database, 'cfm_load_notifications'),
    getLatestRecordTimesForClients: async () => clients.map(client => ({ client: client.uuid, last_time: '2026-09-05T00:00:00Z' })),
    markOfflineNotificationSent: (_db, client, time, token) => rpc(database, 'cfm_mark_offline_notification_sent', { input_client: client, input_time: time, input_token: token }),
    markExpiryNotificationSent: (_db, client, time, token) => rpc(database, 'cfm_mark_expiry_notification_sent', { input_client: client, input_time: time, input_token: token }),
    markLoadNotificationSent: (_db, id, client, time, token) => rpc(database, 'cfm_mark_load_notification_sent', {
      input_id: id, input_client: client, input_time: time, input_token: token,
    }),
    updateLoadNotification: (_db, id, patch) => rpc(database, 'cfm_update_load_notification', { input_id: id, input_patch: patch }),
    getLoadMetricWindowStatsForClients: async () => new Map(clients.map(client => [client.uuid, { samples: 2, exceeded: 2, avg_value: 99 }])),
    insertAuditLog: async () => {},
    claimNotificationDelivery: (_db, key, eventId, now, repeatMs) => rpc(database, 'cfm_claim_notification_delivery', {
      input_key: key, input_event_id: eventId, input_now: now, input_repeat_ms: repeatMs,
    }),
    completeNotificationDelivery: (_db, key, eventId, token, success, now, repeatMs) => rpc(database, 'cfm_complete_notification_delivery', {
      input_key: key, input_event_id: eventId, input_token: token, input_success: success, input_now: now, input_repeat_ms: repeatMs,
    }),
  };
  const functions = await loadTypeScriptFunctions(new URL('../../worker/src/index.ts', import.meta.url), [
    'sendNotification', 'runOfflineCheck', 'shouldSendExpiryNotification', 'runExpiryCheck', 'runLoadCheck',
  ], {
    ...offline,
    rotateScheduledItems, scheduledItems,
    db: { ...methods, ...databaseOverrides },
    deliverNotification: notificationDispatch.deliverNotification,
    dispatchNotification: async (_db, settings, value) => settings.notification_method === 'none' ? false : transport(value.subject),
    bestEffortRecordHealthEvent: async () => {},
    fetchOfflineLiveness: async () => Object.fromEntries(clients.map(client => [client.uuid, {
      lastSeen: state.online ? state.now.getTime() - 1000 : Date.parse('2026-09-05T00:00:00Z'),
      offline: !state.online, streak: state.online ? 0 : 3,
    }])),
    buildOfflineNotification: message('offline'), buildNodeRecoveryNotification: message('recovery'),
    buildExpiryNotification: message('expiry'), buildLoadNotification: message('load'),
  });
  const context = {
    database: {}, env: {}, getClients: async () => clients,
    getAdminSettings: async () => ({ notification_method: state.channel, offline_confirm_rounds: '1' }),
  };
  return { state, run: async (name, minute) => {
    state.now = new Date(Date.parse('2026-09-06T00:00:00Z') + minute * 60_000);
    return functions[name](context, state.now);
  } };
}
