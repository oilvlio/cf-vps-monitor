import { execFileSync } from 'node:child_process';

export function repositoryFromRemote(value) {
  const path = String(value || '').trim()
    .replace(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i, '')
    .replace(/\.git$/, '');
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : '';
}

export function resolveAgentRepository(root, env = process.env) {
  const override = env.CF_MONITOR_AGENT_REPOSITORY || env.GITHUB_REPOSITORY;
  if (override) {
    const repository = repositoryFromRemote(override);
    if (!repository) throw new Error('Invalid Agent GitHub repository; expected owner/repo.');
    return repository;
  }
  try {
    const repository = repositoryFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (repository) return repository;
  } catch { /* Source archives may have no Git metadata. */ }
  return 'oilvlio/cf-vps-monitor';
}
