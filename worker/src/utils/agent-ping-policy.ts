import type { PingTask, PingTaskClientTimeout } from '../db/types';

/** Both transports send the same final per-node task configuration. */
export function agentPingTasksForClient(
  tasks: PingTask[],
  timeouts: PingTaskClientTimeout[],
  uuid: string,
  intervalSec: number,
): PingTask[] {
  const overrides = new Map(timeouts.filter(row => row.client === uuid).map(row => [row.task_id, row.timeout_ms]));
  return tasks.filter(task => task.all_clients || task.clients.includes(uuid)).map(task => ({
    ...task,
    interval_sec: intervalSec,
    timeout_ms: (typeof task.id === 'number' ? overrides.get(task.id) : undefined) ?? task.timeout_ms,
  }));
}

export async function pingPolicyVersion(tasks: PingTask[], intervalSec: number): Promise<string> {
  const digestInput = JSON.stringify({
    interval_sec: intervalSec,
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      target: task.target,
      interval_sec: task.interval_sec,
      timeout_ms: task.timeout_ms,
      all_clients: task.all_clients,
      clients: [...task.clients].sort(),
    })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digestInput));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
