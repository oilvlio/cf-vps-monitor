import assert from 'node:assert/strict';
import {
  beijingMonthKey,
  beijingMonthStartMs,
  buildNodeRecoveryNotification,
  buildOfflineNotification,
  formatOfflineDuration,
} from '../../src/utils/notification-templates.ts';

const notification = buildNodeRecoveryNotification({
  nodeName: '首尔节点',
  recoveredAt: '2026-07-12T04:09:00.000Z',
  offlineMinutes: 12,
  monthOfflineMs: (3 * 60 + 25) * 60_000,
  eventTime: '2026-07-12T04:10:00.000Z',
});

assert.equal(notification.event, '恢复上线');
assert.equal(notification.clients, '首尔节点');
assert.match(notification.body, /离线 12 分钟后恢复上线，本月累计离线 3 小时 25 分钟/);
assert.match(notification.body, /最新上报 2026-07-12 12:09:00/);

const offline = buildOfflineNotification({
  nodeName: '首尔节点',
  offlineMinutes: 5,
  lastSeen: '2026-07-12T04:04:00.000Z',
  eventTime: '2026-07-12T04:10:00.000Z',
});
assert.match(offline.body, /消息: 离线 5 分钟\n最后上报 2026-07-12 12:04:00/);

assert.equal(formatOfflineDuration(0), '0 分钟');
assert.equal(formatOfflineDuration(59_000), '1 分钟');
assert.equal(formatOfflineDuration(3_600_000), '1 小时');
assert.equal(formatOfflineDuration(3 * 3_600_000 + 25 * 60_000), '3 小时 25 分钟');
assert.equal(formatOfflineDuration(26 * 3_600_000), '1 天 2 小时');

assert.equal(beijingMonthKey('2026-07-31T16:00:00.000Z'), '2026-08');
assert.equal(beijingMonthStartMs('2026-08-15T00:00:00.000Z'), Date.parse('2026-07-31T16:00:00.000Z'));
