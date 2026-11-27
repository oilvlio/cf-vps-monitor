import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const file of ['chart-theme-regressions.mjs', 'node-state-regressions.mjs', 'reaudit-regressions.mjs', 'dashboard-recovery-regressions.mjs']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
