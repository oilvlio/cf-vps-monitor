import * as db from '../db/queries';
import { buildAdminSettings } from '../settings/schema';
import { isPublicIpAddress } from './request-ip';
import { buildIpChangeNotification } from './notification-templates';
import { NOTIFICATION_DISPATCH_SETTING_KEYS, dispatchNotification } from './notification-dispatch';
import { bestEffortRecordHealthEvent } from './observability';

export async function notifyReportedIpChange(
  database: db.QueryDatabase, uuid: string, name: string,
  previous: Record<string, unknown>, reported: Record<string, unknown>,
): Promise<void> {
  const parts: string[] = [];
  for (const field of ['ipv4', 'ipv6'] as const) {
    const before = String(previous[field] || '').trim();
    const after = String(reported[field] || '').trim();
    if (isPublicIpAddress(before) && isPublicIpAddress(after) && before !== after) {
      parts.push(field === 'ipv4' ? `IPv4: ${before} → ${after}` : `IPv6: ${before.slice(0, 10)}… → ${after.slice(0, 10)}…`);
    }
  }
  if (!parts.length || !await db.isIpChangeNotificationEnabled(database, uuid).catch(() => false)) return;
  const settings = await db.getSettingsByKeys(database, ['enable_ip_change_notification', ...NOTIFICATION_DISPATCH_SETTING_KEYS]);
  if (settings.enable_ip_change_notification !== 'true') return;
  await dispatchNotification(database, buildAdminSettings(settings), buildIpChangeNotification({ nodeName: name, parts }), {
    deps: { recordHealth: bestEffortRecordHealthEvent },
  });
  await db.insertAuditLog(database, 'system', 'ip_change', `IP 变更: ${name} ${parts.join(', ')}`);
}
