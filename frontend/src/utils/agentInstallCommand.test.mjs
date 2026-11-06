import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = await mkdtemp(join(tmpdir(), 'cf-monitor-agent-command-'));
const projectLinksSource = await readFile(new URL('./projectLinks.ts', import.meta.url), 'utf8');
const commandSource = await readFile(new URL('./agentInstallCommand.ts', import.meta.url), 'utf8');
await writeFile(join(tmp, 'projectLinks.ts'), projectLinksSource);
await writeFile(join(tmp, 'agentInstallCommand.ts'), commandSource.replace("from './projectLinks'", "from './projectLinks.ts'"));

const { buildAgentInstallCommand, buildAgentUninstallAllCommand, defaultAgentInstallOptions } = await import(pathToFileURL(join(tmp, 'agentInstallCommand.ts')).href);
const { CF_MONITOR_AGENT_REPOSITORY } = await import(pathToFileURL(join(tmp, 'projectLinks.ts')).href);
const CF_MONITOR_REPOSITORY = CF_MONITOR_AGENT_REPOSITORY;

const base = {
  serverUrl: 'https://panel.example',
  token: 'token123',
  options: { ...defaultAgentInstallOptions },
  instanceId: '33bc95df-513d-41be-8d98-30979fb17029',
  nodeName: 'node-123',
};

assert.equal(
  buildAgentInstallCommand({ platform: 'unix', ...base }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029'`,
);

assert.equal(
  buildAgentInstallCommand({
    platform: 'unix',
    ...base,
    options: { ...defaultAgentInstallOptions, downloadProxy: '127.0.0.1:10808' },
  }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--proxy' 'http://127.0.0.1:10808'`,
);

assert.equal(
  buildAgentInstallCommand({
    platform: 'unix',
    ...base,
    options: { ...defaultAgentInstallOptions, installMode: 'user' },
  }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--install-mode' 'user'`,
);

assert.equal(
  buildAgentUninstallAllCommand({ platform: 'unix' }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install.sh' | sh -s -- '--uninstall-all' '--yes'`,
);

// 默认值：宿主机负载开、GPU 关、日志 info，命令里不带任何对应参数；流量重置日不再出现在命令里。
const defaultCommand = buildAgentInstallCommand({ platform: 'unix', ...base });
assert.ok(!/host-load|enable-gpu|log-level|'-r'|traffic-reset/.test(defaultCommand), defaultCommand);

const noHostLoad = buildAgentInstallCommand({ platform: 'unix', ...base, options: { ...defaultAgentInstallOptions, allowHostLoad: false, hostCpuCores: '64' } });
assert.ok(noHostLoad.endsWith("'--no-host-load'"), noHostLoad);
assert.ok(!noHostLoad.includes('host-cpu-cores'), 'cores without host load must not leak into the command');
const scaledHostLoad = buildAgentInstallCommand({ platform: 'unix', ...base, options: { ...defaultAgentInstallOptions, hostCpuCores: '64' } });
assert.ok(scaledHostLoad.endsWith("'--host-cpu-cores' '64'"), scaledHostLoad);
assert.ok(!/host-load|host-cpu-cores/i.test(buildAgentInstallCommand({
  platform: 'windows',
  ...base,
  options: { ...defaultAgentInstallOptions, allowHostLoad: false, hostCpuCores: '64' },
})), 'Windows installer has no host-load option');

assert.ok(buildAgentInstallCommand({ platform: 'unix', ...base, options: { ...defaultAgentInstallOptions, logLevel: 'debug' } }).endsWith("'--log-level' 'debug'"));
assert.ok(!buildAgentInstallCommand({ platform: 'unix', ...base, options: { ...defaultAgentInstallOptions, logLevel: 'bogus' } }).includes('log-level'), 'unknown levels fall back to the default');

await rm(tmp, { recursive: true, force: true });
