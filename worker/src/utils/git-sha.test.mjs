import assert from 'node:assert/strict';

const { shortGitSha } = await import('./git-sha.ts');

assert.equal(shortGitSha('77D873F2552638E38BEBF1D18BC38DB7721042F5'), '77d873f');
assert.equal(shortGitSha('77d873f'), '77d873f');
assert.equal(shortGitSha(undefined), '');
assert.equal(shortGitSha(''), '');
