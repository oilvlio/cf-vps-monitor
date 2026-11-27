import assert from 'node:assert/strict';

const {
  formatAuditLogDetailText,
  formatAuditLogRawDetailText,
  getAuditLogDetailText,
} = await import('./audit-log.ts');

assert.equal(
  formatAuditLogDetailText(JSON.stringify({ summary: '清理完成', deleted: 3 })),
  '清理完成',
);

assert.equal(
  formatAuditLogDetailText(JSON.stringify({ records: 3, has_more: false })),
  '{\n  "records": 3,\n  "has_more": false\n}',
);

assert.equal(
  formatAuditLogRawDetailText('清除记录: {"records":3,"has_more":false}'),
  '清除记录:\n{\n  "records": 3,\n  "has_more": false\n}',
);

assert.equal(
  formatAuditLogDetailText('prefix {"a":1} suffix'),
  'prefix\n{\n  "a": 1\n}\nsuffix',
);

// 非 JSON 的花括号保持原样，避免误伤普通日志文本。
assert.equal(
  formatAuditLogDetailText('客户端 {demo} 离线'),
  '客户端 {demo} 离线',
);

assert.equal(getAuditLogDetailText(''), '-');
