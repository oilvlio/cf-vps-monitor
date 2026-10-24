import assert from 'node:assert/strict';
import test from 'node:test';
import { productionModule } from './helpers/production-module.mjs';

const { buildAgentInstallCommand, defaultAgentInstallOptions } = productionModule('src/utils/agentInstallCommand.ts');

function build(platform, disableGpu) {
  return buildAgentInstallCommand({
    platform,
    serverUrl: 'https://synthetic.invalid',
    token: 'synthetic-token',
    instanceId: 'synthetic-node',
    options: { ...defaultAgentInstallOptions, disableGpu },
  });
}

function encodedPowerShell(command) {
  const match = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, 'Windows command uses an encoded PowerShell payload');
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

test('GPU collection stays enabled by default and can be disabled for Unix installs', () => {
  assert.equal(build('unix', false).includes('--disable-gpu'), false);
  assert.match(build('unix', true), / '--disable-gpu'/);
});

test('GPU collection can be disabled for Windows installs with an unquoted switch', () => {
  assert.equal(encodedPowerShell(build('windows', false)).includes('-DisableGpu'), false);
  const script = encodedPowerShell(build('windows', true));
  assert.match(script, /(?:^|\s)-DisableGpu(?:$|\s)/);
  assert.equal(script.includes("'-DisableGpu'"), false);
});
