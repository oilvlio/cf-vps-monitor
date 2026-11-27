import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFromRemote, resolveAgentRepository } from './repository.mjs';

test('Fork repository identity is resolved from explicit build settings or origin', () => {
  for (const remote of ['fork/monitor', 'https://github.com/fork/monitor.git', 'git@github.com:fork/monitor.git', 'ssh://git@github.com/fork/monitor.git']) {
    assert.equal(repositoryFromRemote(remote), 'fork/monitor');
  }
  assert.equal(repositoryFromRemote('https://other.example/fork/monitor.git'), '');
  assert.equal(repositoryFromRemote('fork/../monitor'), '');
  assert.equal(resolveAgentRepository('/missing', { GITHUB_REPOSITORY: 'fork/monitor' }), 'fork/monitor');
  assert.equal(resolveAgentRepository('/missing', { CF_MONITOR_AGENT_REPOSITORY: 'custom/agent', GITHUB_REPOSITORY: 'fork/monitor' }), 'custom/agent');
  assert.throws(() => resolveAgentRepository('/missing', { CF_MONITOR_AGENT_REPOSITORY: 'invalid' }));
});
