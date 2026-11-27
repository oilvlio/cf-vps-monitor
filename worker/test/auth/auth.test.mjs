import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthConfigurationError, generateToken, verifyAdminToken } from '../../src/auth/jwt.ts';
import { base32Decode, base32Encode, buildTotpUri, generateTotpCode, verifyTotpCode } from '../../src/auth/totp.ts';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '../../src/auth/mfa.ts';
import { generateMfaSetupToken, generateMfaToken, verifyMfaSetupToken, verifyMfaToken } from '../../src/auth/mfa-token.ts';
import { hashPassword, needsPasswordRehash, validateAdminPasswordStrength, verifyPassword } from '../../src/auth/password.ts';
import { isMfaStepUpProtectedRequest } from '../../src/auth/mfa-policy.ts';
import { readFileSync } from 'node:fs';
import { sign } from 'hono/jwt';

// --- jwt.isolation ---
{
  const env = { JWT_SECRET: 'audit-synthetic-key-at-least-32-bytes' };
  const identity = { userId: 'synthetic-admin', username: 'audit-owner', sessionVersion: 1 };

  test('AUD-01: temporary MFA credentials cannot authenticate an administrator session', async () => {
    const session = await generateToken(identity.userId, identity.username, identity.sessionVersion, env);
    assert.deepEqual(await verifyAdminToken(session, env), identity);
    assert.equal(await verifyMfaToken(session, 'mfa-login', env), null);

    const tokens = [
      await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env),
      await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, env),
      await generateMfaSetupToken({ ...identity, encryptedSecret: 'synthetic-enrollment' }, env),
    ];
    for (const token of tokens) {
      assert.equal(await verifyAdminToken(token, env), null, 'An unfinished MFA credential must never grant a full session');
    }
  });

  test('AUD-01: legacy untyped JWTs require login again', async () => {
    const now = Math.floor(Date.now() / 1000);
    const legacy = await sign({ ...identity, iat: now, exp: now + 300 }, env.JWT_SECRET, 'HS256');
    assert.equal(await verifyAdminToken(legacy, env), null);
  });

  test('AUD-01: signature, expiry and session-version checks remain effective', async () => {
    const token = await generateToken(identity.userId, identity.username, 1, env);
    const [header, payload, signature] = token.split('.');
    const corrupted = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    await assert.rejects(() => verifyAdminToken(corrupted, env));
    const expired = await sign({
      ...identity, kind: 'cf-monitor-session', purpose: 'admin-session', iat: 1, exp: 2,
    }, env.JWT_SECRET, 'HS256');
    await assert.rejects(() => verifyAdminToken(expired, env));
    const invalidVersion = await generateToken(identity.userId, identity.username, 0, env);
    assert.equal(await verifyAdminToken(invalidVersion, env), null);
  });
}

// --- mfa-policy ---
{
  const protectedRequests = [
    ['POST', '/api/admin/account/username'],
    ['POST', '/api/admin/account/chpasswd'],
    ['POST', '/api/admin/clients/node-1/remove'],
    ['POST', '/api/admin/clients/batch-remove'],
    ['POST', '/api/admin/clients/node-1/token'],
    ['POST', '/api/admin/clients/node-1/token/install'],
    ['POST', '/api/admin/clients/node-1/token/rotate'],
    ['POST', '/api/admin/account/mfa/setup'],
    ['POST', '/api/admin/account/mfa/enable'],
    ['POST', '/api/admin/account/mfa/recovery-codes'],
    ['POST', '/api/admin/account/mfa/disable'],
  ];

  for (const [method, path] of protectedRequests) {
    test(`protects ${method} ${path}`, () => {
      assert.equal(isMfaStepUpProtectedRequest(method, path), true);
    });
}

test('does not recursively protect the step-up endpoint or ordinary edits', () => {
  assert.equal(isMfaStepUpProtectedRequest('POST', '/api/admin/account/mfa/step-up'), false);
  assert.equal(isMfaStepUpProtectedRequest('GET', '/api/admin/account/mfa'), false);
  assert.equal(isMfaStepUpProtectedRequest('POST', '/api/admin/clients/reorder'), false);
  assert.equal(isMfaStepUpProtectedRequest('GET', '/api/admin/clients/node-1/token'), false);
});
}

// --- mfa-token ---
{
const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };
const identity = {
  userId: 'user-1',
  username: 'admin',
  sessionVersion: 3,
};

test('keeps login challenges and step-up tokens purpose-isolated', async () => {
  const token = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env);
  assert.deepEqual(await verifyMfaToken(token, 'mfa-login', env), {
    ...identity,
    purpose: 'mfa-login',
  });
  assert.equal(await verifyMfaToken(token, 'mfa-step-up', env), null);
});

test('rejects expired and tampered MFA tokens', async () => {
  const expired = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env, 1_700_000_000_000);
  assert.equal(await verifyMfaToken(expired, 'mfa-login', env), null);

  const current = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env);
  const [header, payload, signature] = current.split('.');
  const tampered = `${header}.${payload}.${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;
  assert.equal(await verifyMfaToken(tampered, 'mfa-login', env), null);
});

test('exposes the session version required for database validation', async () => {
  const token = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, env);
  const payload = await verifyMfaToken(token, 'mfa-step-up', env);
  assert.equal(payload?.sessionVersion, 3);
  assert.notEqual(payload?.sessionVersion, 4);
});
test('preserves JWT configuration errors for a clear server response', async () => {
  await assert.rejects(
    () => verifyMfaToken('invalid', 'mfa-login', { JWT_SECRET: 'short' }),
    AuthConfigurationError,
  );
});
test('binds the encrypted enrollment secret to a short-lived setup token', async () => {
  const token = await generateMfaSetupToken({ ...identity, encryptedSecret: 'v1.iv.ciphertext' }, env);
  assert.deepEqual(await verifyMfaSetupToken(token, env), {
    ...identity,
    encryptedSecret: 'v1.iv.ciphertext',
  });
  assert.equal(await verifyMfaToken(token, 'mfa-login', env), null);
});
}

// --- mfa ---
{
const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };

test('encrypts TOTP secrets with random IV and user-bound authentication', async () => {
  const first = await encryptTotpSecret('JBSWY3DPEHPK3PXP', 'user-a', env);
  const second = await encryptTotpSecret('JBSWY3DPEHPK3PXP', 'user-a', env);

  assert.notEqual(first, second);
  assert.equal(await decryptTotpSecret(first, 'user-a', env), 'JBSWY3DPEHPK3PXP');
  await assert.rejects(() => decryptTotpSecret(first, 'user-b', env));
  const [version, iv, data] = first.split('.');
  const tamperedData = `${data.startsWith('A') ? 'B' : 'A'}${data.slice(1)}`;
  await assert.rejects(() => decryptTotpSecret(`${version}.${iv}.${tamperedData}`, 'user-a', env));
  await assert.rejects(() => decryptTotpSecret(first, 'user-a', { JWT_SECRET: 'abcdef0123456789abcdef0123456789' }));
});

test('generates eight unique 120-bit recovery codes and stable hashes', async () => {
  const result = await generateRecoveryCodes(env);
  assert.equal(result.codes.length, 8);
  assert.equal(result.hashes.length, 8);
  assert.equal(new Set(result.codes).size, 8);
  assert.equal(new Set(result.hashes).size, 8);
  for (const code of result.codes) {
    assert.match(code, /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
  }

  const normalized = normalizeRecoveryCode(` ${result.codes[0].toLowerCase()} `);
  assert.equal(normalized, result.codes[0].replaceAll('-', ''));
  assert.equal(await hashRecoveryCode(result.codes[0], env), result.hashes[0]);
  assert.equal(await hashRecoveryCode(normalized, env), result.hashes[0]);
});

test('rejects malformed recovery codes', () => {
  assert.throws(() => normalizeRecoveryCode('short'), /恢复码/);
  assert.throws(() => normalizeRecoveryCode('ABCD-EFGH-IJKL-MNOP-QRST-UVWX!'), /恢复码/);
});
}

// --- password ---
{
const source = readFileSync(new URL('../../src/auth/password.ts', import.meta.url), 'utf8');

const PASSWORD = 'correct horse battery staple';

function passwordHashFor(iterations) {
  const salt = new Uint8Array(16).fill(7);
  const hash = pbkdf2Sync(PASSWORD, salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${Buffer.from(salt).toString('base64')}$${hash.toString('base64')}`;
}

test('PBKDF2 iterations sit at the Workers production cap (100,000)', () => {
  const iterations = Number(/const PBKDF2_ITERATIONS = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(iterations), '缺少 PBKDF2_ITERATIONS 常量');
  // 生产 Workers 超过 100,000 会抛 NotSupportedError，本地 workerd 不拦，必须靠这里兜住。
  assert.ok(iterations <= 100000, `PBKDF2 迭代次数 ${iterations} 超过 Workers 上限 100,000`);
  assert.equal(iterations, 100000, '应使用平台允许的最高迭代次数');
});

test('admin password minimum length is at least 10 characters', () => {
  const minLength = Number(/const MIN_ADMIN_PASSWORD_LENGTH = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(minLength), '缺少 MIN_ADMIN_PASSWORD_LENGTH 常量');
  assert.ok(minLength >= 10, `最小密码长度 ${minLength} 仍偏短`);
  assert.notEqual(validateAdminPasswordStrength('a'.repeat(minLength - 1)), null);
  assert.equal(validateAdminPasswordStrength('a'.repeat(minLength)), null);
});

test('hash/verify round-trip uses the current iteration count', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^pbkdf2_sha256\$100000\$/);
  assert.equal(needsPasswordRehash(hash), false);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword(`${PASSWORD}!`, hash), false);
});

test('legacy low-iteration PBKDF2 hashes still verify and are rehashed on login', async () => {
  const legacy = passwordHashFor(10000);
  assert.equal(needsPasswordRehash(legacy), true);
  assert.equal(await verifyPassword(PASSWORD, legacy), true);
  assert.equal(await verifyPassword('wrong password', legacy), false);
});

test('legacy SHA-256 hashes still verify and are rehashed on login', async () => {
  const legacy = createHash('sha256').update(`${PASSWORD}cf-monitor-salt`).digest('hex');
  assert.equal(needsPasswordRehash(legacy), true);
  assert.equal(await verifyPassword(PASSWORD, legacy), true);
  assert.equal(await verifyPassword('wrong password', legacy), false);
});
}

// --- totp ---
{
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const vectors = [
  [59_000, '287082'],
  [1_111_111_109_000, '081804'],
  [1_111_111_111_000, '050471'],
  [1_234_567_890_000, '005924'],
  [2_000_000_000_000, '279037'],
  [20_000_000_000_000, '353130'],
];

test('generates RFC 6238 SHA-1 codes truncated to six digits', async () => {
  for (const [timestamp, expected] of vectors) {
    assert.equal(await generateTotpCode(RFC_SECRET, Number(timestamp)), expected);
  }
});

test('base32 round-trips bytes and rejects invalid characters', () => {
  const bytes = new TextEncoder().encode('12345678901234567890');
  assert.equal(base32Encode(bytes), RFC_SECRET);
  assert.deepEqual(base32Decode(RFC_SECRET.toLowerCase()), bytes);
  assert.throws(() => base32Decode('INVALID!'), /Base32/);
});

test('verifies current, previous and next time steps only', async () => {
  const timestamp = 1_700_000_000_000;
  const current = await generateTotpCode(RFC_SECRET, timestamp);
  const previous = await generateTotpCode(RFC_SECRET, timestamp - 30_000);
  const next = await generateTotpCode(RFC_SECRET, timestamp + 30_000);
  const old = await generateTotpCode(RFC_SECRET, timestamp - 60_000);

  assert.equal((await verifyTotpCode(RFC_SECRET, current, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, previous, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, next, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, old, timestamp)).valid, false);
  assert.equal((await verifyTotpCode(RFC_SECRET, '12345', timestamp)).valid, false);
});

test('builds a compatible otpauth URI with matching issuer fields', () => {
  const uri = new URL(buildTotpUri({ secret: RFC_SECRET, username: 'admin name' }));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.hostname, 'totp');
  assert.equal(uri.searchParams.get('secret'), RFC_SECRET);
  assert.equal(uri.searchParams.get('issuer'), 'CF VPS Monitor');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.match(decodeURIComponent(uri.pathname), /CF VPS Monitor:admin name/);
});
}

// --- viewer-token ---
{
const { normalizeIpForBinding, createViewerToken, verifyViewerToken } = await import('../../src/auth/viewer-token.ts');

const SECRET = 'test-secret-that-is-at-least-32-bytes-long!!';

// --- IPv4 → /24 ---
assert.equal(normalizeIpForBinding('1.2.3.4'), '1.2.3.0/24');
assert.equal(normalizeIpForBinding('203.0.113.255'), '203.0.113.0/24');
assert.equal(
  normalizeIpForBinding('1.2.3.4'),
  normalizeIpForBinding('1.2.3.200'),
  '同 /24 内不同主机位必须归一到同一网段',
);
assert.notEqual(
  normalizeIpForBinding('1.2.3.4'),
  normalizeIpForBinding('1.2.4.4'),
  '不同 /24 必须区分开',
);

// --- IPv6 → /64，必须正确展开 `::` ---
assert.equal(normalizeIpForBinding('2a01:4f8:c17:b8f::1'), '2a01:4f8:c17:b8f::/64');
assert.equal(
  normalizeIpForBinding('2a01::1'),
  '2a01:0:0:0::/64',
  '`::` 必须先展开——朴素 split 会把这里误算成 2a01:0:1:0',
);
assert.equal(normalizeIpForBinding('::1'), '0:0:0:0::/64');
assert.equal(
  normalizeIpForBinding('2001:0db8:0000:0000:0000:0000:0000:0001'),
  '2001:db8:0:0::/64',
  '未压缩写法要归一到同一规范形式',
);
assert.equal(
  normalizeIpForBinding('2001:db8::1'),
  normalizeIpForBinding('2001:0db8:0000:0000:0000:0000:0000:0001'),
  '压缩与未压缩写法必须归一到同一结果',
);
assert.equal(
  normalizeIpForBinding('2A01:4F8:C17:B8F::1'),
  '2a01:4f8:c17:b8f::/64',
  '大小写不敏感',
);
assert.equal(normalizeIpForBinding('fe80::1%eth0'), 'fe80:0:0:0::/64', 'zone id 要剥掉');
assert.equal(normalizeIpForBinding('[2a01:4f8:c17:b8f::1]'), '2a01:4f8:c17:b8f::/64', '方括号要剥掉');
assert.equal(
  normalizeIpForBinding('2a01:4f8:c17:b8f::1'),
  normalizeIpForBinding('2a01:4f8:c17:b8f:aaaa:bbbb:cccc:dddd'),
  '同 /64 内不同接口标识必须归一到同一网段',
);
assert.notEqual(
  normalizeIpForBinding('2a01:4f8:c17:b8f::1'),
  normalizeIpForBinding('2a01:4f8:c17:b90::1'),
  '不同 /64 必须区分开',
);

// --- 退化输入 ---
assert.equal(normalizeIpForBinding(''), '');
assert.equal(normalizeIpForBinding('   '), '');
assert.equal(normalizeIpForBinding('unknown'), 'unknown', '非 IP 值原样返回，仍可精确比对');
assert.equal(normalizeIpForBinding('1.2.3'), '1.2.3', '残缺 IPv4 原样返回');

// --- 端到端：同网段放行，跨网段拒绝 ---
const { token } = await createViewerToken({ ip: '1.2.3.4', secret: SECRET, ttlMs: 60_000 });

assert.equal(
  await verifyViewerToken({ token, ip: '1.2.3.4', secret: SECRET }),
  true,
  '同一 IP 必须放行',
);
assert.equal(
  await verifyViewerToken({ token, ip: '1.2.3.99', secret: SECRET }),
  true,
  '同 /24 内换 IP 必须放行——这正是双栈/CGNAT 用户被误伤的场景',
);
assert.equal(
  await verifyViewerToken({ token, ip: '1.2.9.4', secret: SECRET }),
  false,
  '跨网段必须拒绝——防滥用能力要保留',
);
assert.equal(
  await verifyViewerToken({ token, ip: '1.2.3.4', secret: 'a-different-secret-of-sufficient-length!!' }),
  false,
  '签名不符必须拒绝',
);
assert.equal(
  await verifyViewerToken({ token, ip: '1.2.3.4', secret: SECRET, now: Date.now() + 120_000 }),
  false,
  '过期必须拒绝',
);

// --- 旧格式 token（明文 IP）应失败一次，前端重连即恢复 ---
const legacy = await createViewerToken({ ip: '1.2.3.4', secret: SECRET, ttlMs: 60_000 });
const legacyPayload = JSON.parse(
  Buffer.from(legacy.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
);
assert.equal(legacyPayload.ip, '1.2.3.0/24', '新签发的 token 内嵌的应是网段而非明文 IP');

console.log('viewer-token.test.mjs: all assertions passed');
}
