import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScriptFunctions } from '../../../scripts/test-support/typescript.mjs';

class AuthConfigurationError extends Error {}
const user = { uuid: 'admin', totp_enabled_at: '2026-01-01T00:00:00Z', totp_secret_enc: 'encrypted' };

async function helper(consumeRecoveryCode, hashRecoveryCode = async code => `hash:${code}`) {
  return (await loadTypeScriptFunctions(new URL('../../src/routes/admin.ts', import.meta.url), ['verifyUserMfaFactor'], {
    db: { consumeRecoveryCode }, hashRecoveryCode, AuthConfigurationError,
  })).verifyUserMfaFactor;
}

test('recovery-code verification catches asynchronous database rejection', async () => {
  const verify = await helper(async () => { throw new Error('database unavailable'); });
  assert.equal(await verify({}, user, 'recovery_code', 'one-time-code', {}), false);
});

test('recovery-code verification preserves valid and invalid outcomes', async () => {
  for (const outcome of [true, false]) {
    const verify = await helper(async (_database, uuid, hash) => {
      assert.equal(uuid, user.uuid);
      assert.equal(hash, 'hash:one-time-code');
      return outcome;
    });
    assert.equal(await verify({}, user, 'recovery_code', 'one-time-code', {}), outcome);
  }
});

test('recovery-code configuration errors still propagate to the explicit configuration response', async () => {
  const verify = await helper(async () => true, async () => { throw new AuthConfigurationError('missing secret'); });
  await assert.rejects(verify({}, user, 'recovery_code', 'one-time-code', {}), AuthConfigurationError);
});
