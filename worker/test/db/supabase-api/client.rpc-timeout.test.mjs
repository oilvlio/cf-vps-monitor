import assert from 'node:assert/strict';
import test from 'node:test';

const {
  callSupabaseRpc,
  SupabaseApiError,
  SupabaseRpcTimeoutError,
} = await import('../../../src/db/supabase-api/client.ts');
const { DEFAULT_SUPABASE_RPC_TIMEOUT_MS } = await import('../../../src/db/supabase-api/rpc-policy.ts');

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_key',
};

function hangingFetcher(calls) {
  return (_url, init) => new Promise((_resolve, reject) => {
    calls.push(init);
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

test('every ordinary RPC attempt carries a default application-level timeout', () => {
  assert.ok(Number.isFinite(DEFAULT_SUPABASE_RPC_TIMEOUT_MS) && DEFAULT_SUPABASE_RPC_TIMEOUT_MS > 0);
});

test('the default timeout applies when the caller does not override it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const pending = callSupabaseRpc(env, 'cfm_set_settings', {}, hangingFetcher(calls));
  const settled = assert.rejects(
    pending,
    error => error instanceof SupabaseRpcTimeoutError && error.timeoutMs === DEFAULT_SUPABASE_RPC_TIMEOUT_MS,
  );
  t.mock.timers.tick(DEFAULT_SUPABASE_RPC_TIMEOUT_MS);
  await settled;
  assert.equal(calls.length, 1);
});

test('a hung read RPC aborts on the timeout and retries exactly once', async () => {
  const calls = [];
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_public_settings', {}, hangingFetcher(calls), { timeoutMs: 20 }),
    error => error instanceof SupabaseRpcTimeoutError
      && error.functionName === 'cfm_public_settings'
      && error.timeoutMs === 20,
  );
  assert.equal(calls.length, 2, 'idempotent reads may retry a timed-out attempt');
});

test('a hung write RPC times out without replaying the request', async () => {
  const calls = [];
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_set_settings', {}, hangingFetcher(calls), { timeoutMs: 20 }),
    error => error instanceof SupabaseRpcTimeoutError,
  );
  assert.equal(calls.length, 1, 'a write may already be committed, so it must not be retried');
});

test('a caller AbortSignal cancels the RPC without retrying or waiting for the timeout', async () => {
  const calls = [];
  const controller = new AbortController();
  const pending = callSupabaseRpc(env, 'cfm_public_settings', {}, hangingFetcher(calls), {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.equal(calls.length, 1);
});

test('already-cancelled callers never reach the network', async () => {
  const calls = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_public_settings', {}, hangingFetcher(calls), { signal: controller.signal }),
    error => error?.name === 'AbortError',
  );
  assert.equal(calls.length, 0);
});

test('reads retry transient HTTP failures and return the later success', async () => {
  let calls = 0;
  const result = await callSupabaseRpc(env, 'cfm_public_settings', {}, async () => {
    calls += 1;
    return calls === 1 ? new Response('busy', { status: 503 }) : Response.json({ site_title: 'ok' });
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { site_title: 'ok' });
});

test('reads retry connection failures', async () => {
  let calls = 0;
  const result = await callSupabaseRpc(env, 'cfm_public_settings', {}, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('network connection lost');
    return Response.json({ site_title: 'ok' });
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { site_title: 'ok' });
});

test('reads do not retry non-transient HTTP failures', async () => {
  let calls = 0;
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_public_settings', {}, async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }),
    error => error instanceof SupabaseApiError && error.status === 401,
  );
  assert.equal(calls, 1);
});

test('writes fail fast on transient HTTP failures and connection errors', async () => {
  let httpCalls = 0;
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_set_settings', {}, async () => {
      httpCalls += 1;
      return new Response('busy', { status: 503 });
    }),
    error => error instanceof SupabaseApiError && error.status === 503,
  );
  assert.equal(httpCalls, 1);

  let networkCalls = 0;
  await assert.rejects(
    () => callSupabaseRpc(env, 'cfm_set_settings', {}, async () => {
      networkCalls += 1;
      throw new TypeError('network connection lost');
    }),
    error => error instanceof TypeError,
  );
  assert.equal(networkCalls, 1);
});

test('RPCs with mutating verbs are classified as writes', async () => {
  const { supabaseRpcMode } = await import('../../../src/db/supabase-api/rpc-policy.ts');
  for (const name of [
    'cfm_set_settings', 'cfm_update_client', 'cfm_create_ping_task', 'cfm_delete_clients',
    'cfm_mark_offline_notification_sent', 'cfm_traffic_apply_samples', 'cfm_traffic_import',
    'cfm_partition_maintain', 'cfm_build_rollup', 'cfm_claim_notification_delivery',
  ]) {
    assert.equal(supabaseRpcMode(name), 'write', `${name} must never be retried`);
  }
  for (const name of [
    'cfm_public_settings', 'cfm_admin_clients', 'cfm_ping_rollup_range',
    'cfm_records_range_aggregated', 'cfm_traffic_totals', 'cfm_validate_admin_session',
  ]) {
    assert.equal(supabaseRpcMode(name), 'read', `${name} is an idempotent read`);
  }
});