import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { validateWebhookUrl } = loader.load('worker/src/utils/webhook.ts');
const { validatePingTaskInput } = loader.load('worker/src/utils/ping-task.ts');

function outcomes(host) {
  const authority = host.includes(':') ? `[${host}]` : host;
  const task = { name: 'Synthetic target', all_clients: true, interval_sec: 120 };
  return {
    webhook: validateWebhookUrl(`https://${authority}/hook`).ok,
    icmp: validatePingTaskInput({ ...task, type: 'icmp', target: host }).ok,
    tcp: validatePingTaskInput({ ...task, type: 'tcp', target: `${authority}:443` }).ok,
    http: validatePingTaskInput({ ...task, type: 'http', target: `https://${authority}` }).ok,
  };
}

// Hosts that every target validator (webhook and all three Ping types) must accept.
const ordinaryHosts = [
  'example.com', 'fda.gov', 'fc.example.com', 'fe80.example.com', 'ffmpeg.org', 'fe90.example.com',
  '2606:4700:4700::1111', '2606:4700:0000:0000:0000:0000:0000:1111',
];

// Addresses that only the application-level guard - not the platform resolver -
// must reject consistently, including special-purpose IPv6 literals.
const unsafeHosts = [
  'fc00::1', 'fd00::1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', '::1',
  '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000',
  '::ffff:127.0.0.1', '0000:0000:0000:0000:0000:ffff:7f00:1',
  '127.0.0.1', '10.0.0.1', '169.254.1.1', '2130706433', '0x7f000001',
];

test('R-D01 ordinary DNS names and public IPv6 are usable in every target format', () => {
  for (const host of ordinaryHosts) {
    assert.deepEqual(outcomes(host), { webhook: true, icmp: true, tcp: true, http: true }, host);
  }
});

test('R-D01 unsafe literals remain rejected by every target validator', () => {
  for (const host of unsafeHosts) {
    assert.deepEqual(outcomes(host), { webhook: false, icmp: false, tcp: false, http: false }, host);
  }
});
