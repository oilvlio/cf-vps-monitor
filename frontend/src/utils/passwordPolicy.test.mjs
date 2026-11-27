import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_ADMIN_PASSWORD_LENGTH, validateAdminPasswordLength } from './passwordPolicy.ts';

test('admin password policy requires at least 12 characters', () => {
  assert.ok(MIN_ADMIN_PASSWORD_LENGTH >= 12);
  assert.match(validateAdminPasswordLength('a'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1)) ?? '', /至少需要 \d+ 位/);
  assert.equal(validateAdminPasswordLength('a'.repeat(MIN_ADMIN_PASSWORD_LENGTH)), null);
});

test('admin password policy counts code points, matching the worker', () => {
  // 6 个 emoji 是 12 个 UTF-16 码元但只有 6 个字符，必须判为过短。
  assert.notEqual(validateAdminPasswordLength('😀'.repeat(6)), null);
  assert.equal(validateAdminPasswordLength('😀'.repeat(MIN_ADMIN_PASSWORD_LENGTH)), null);
});
