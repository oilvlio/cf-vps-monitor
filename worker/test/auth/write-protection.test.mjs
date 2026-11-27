import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const { verifyAdminWriteRequest } = createWorkerLoader().load('worker/src/auth/session.ts');

test('theme writes require strict same-origin provenance without a CSRF header', async () => {
  const app = new Hono();
  app.put('/', c => c.json({ allowed: verifyAdminWriteRequest(c, false) }));
  for (const [headers, allowed] of [
    [{}, false],
    [{ Origin: 'https://monitor.example' }, true],
    [{ Referer: 'https://monitor.example/manage' }, true],
    [{ Origin: 'null' }, false],
    [{ Origin: 'https://monitor.example.evil' }, false],
    [{ Origin: 'http://monitor.example' }, false],
    [{ Origin: 'https://monitor.example:444' }, false],
    [{ Origin: 'https://evil.example', Referer: 'https://monitor.example/manage' }, false],
  ]) {
    const response = await app.request('https://monitor.example/', { method: 'PUT', headers });
    assert.equal((await response.json()).allowed, allowed, JSON.stringify(headers));
  }
});

test('dashboard writes retain token validation and reject cross-origin requests even with a token', async () => {
  const app = new Hono();
  app.post('/', c => c.json({ allowed: verifyAdminWriteRequest(c) }));
  const token = 'a'.repeat(43);
  const headers = { Cookie: `cf_monitor_csrf=${token}`, 'X-CSRF-Token': token };
  for (const [extra, allowed] of [
    [{}, true],
    [{ Origin: 'https://monitor.example' }, true],
    [{ Origin: 'https://evil.example' }, false],
    [{ 'X-CSRF-Token': 'b'.repeat(43) }, false],
  ]) {
    const response = await app.request('https://monitor.example/', { method: 'POST', headers: { ...headers, ...extra } });
    assert.equal((await response.json()).allowed, allowed);
  }
});
