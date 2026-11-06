import assert from 'node:assert/strict';
import test from 'node:test';
import { productionModule } from './helpers/production-module.mjs';

const { buildAgentInstallCommand, defaultAgentInstallOptions } = productionModule('src/utils/agentInstallCommand.ts');

function build(platform, enableGpu, logLevel = 'info') {
  return buildAgentInstallCommand({
    platform,
    serverUrl: 'https://synthetic.invalid',
    token: 'synthetic-token',
    instanceId: 'synthetic-node',
    options: { ...defaultAgentInstallOptions, enableGpu, logLevel },
  });
}

function encodedPowerShell(command) {
  const match = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, 'Windows command uses an encoded PowerShell payload');
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

test('GPU collection is off by default and can be enabled for Unix installs', () => {
  assert.equal(build('unix', false).includes('--enable-gpu'), false);
  assert.match(build('unix', true), / '--enable-gpu'/);
});

test('GPU collection can be enabled for Windows installs with an unquoted switch', () => {
  assert.equal(encodedPowerShell(build('windows', false)).includes('-EnableGpu'), false);
  const script = encodedPowerShell(build('windows', true));
  assert.match(script, /(?:^|\s)-EnableGpu(?:$|\s)/);
  assert.equal(script.includes("'-EnableGpu'"), false);
});

test('log level is passed to both installers only when it differs from the default', () => {
  assert.equal(build('unix', false).includes('--log-level'), false);
  assert.match(build('unix', false, 'debug'), / '--log-level' 'debug'/);
  assert.equal(encodedPowerShell(build('windows', false)).includes('-LogLevel'), false);
  const script = encodedPowerShell(build('windows', true, 'warn'));
  assert.match(script, /(?:^|\s)-LogLevel 'warn'(?:\s)/);
  assert.match(script, /(?:^|\s)-EnableGpu(?:$|\s)/);
});
