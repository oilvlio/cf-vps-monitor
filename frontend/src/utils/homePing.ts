import { fetchWithBootstrapRetry } from './api.ts';

// 对应 worker 的 GET /api/ping/home。每个节点只带「首页探测点」那一个任务的分桶数据。
export interface HomePingPoint {
  /** 桶起点，毫秒时间戳 */
  t: number;
  latency_ms: number | null;
  loss_percent: number | null;
}

export interface HomePingNode {
  task_id: number;
  task_name: string;
  latency_ms: number | null;
  latency_avg_ms: number | null;
  loss_percent: number | null;
  updated_at: string | null;
  points: HomePingPoint[];
}

export interface HomePingSummary {
  bucket_sec: number;
  bucket_count: number;
  generated_at: string;
  nodes: Record<string, HomePingNode>;
}

export type HomePingLevel = 'good' | 'ok' | 'warn' | 'bad' | 'none';

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeHomePingSummary(input: unknown): HomePingSummary {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const rawNodes = (raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {}) as Record<string, unknown>;
  const nodes: Record<string, HomePingNode> = {};
  for (const [uuid, value] of Object.entries(rawNodes)) {
    if (!value || typeof value !== 'object') continue;
    const node = value as Record<string, unknown>;
    const taskId = Number(node.task_id);
    if (!Number.isInteger(taskId) || taskId <= 0) continue;
    nodes[uuid] = {
      task_id: taskId,
      task_name: typeof node.task_name === 'string' ? node.task_name : '',
      latency_ms: finiteOrNull(node.latency_ms),
      latency_avg_ms: finiteOrNull(node.latency_avg_ms),
      loss_percent: finiteOrNull(node.loss_percent),
      updated_at: typeof node.updated_at === 'string' ? node.updated_at : null,
      points: Array.isArray(node.points)
        ? node.points.map((point) => {
          const p = (point && typeof point === 'object' ? point : {}) as Record<string, unknown>;
          return {
            t: Number(p.t) || 0,
            latency_ms: finiteOrNull(p.latency_ms),
            loss_percent: finiteOrNull(p.loss_percent),
          };
        })
        : [],
    };
  }
  return {
    bucket_sec: Number(raw.bucket_sec) > 0 ? Number(raw.bucket_sec) : 300,
    bucket_count: Number(raw.bucket_count) > 0 ? Number(raw.bucket_count) : 24,
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
    nodes,
  };
}

export async function fetchHomePingSummary(
  { includeHidden = false, signal }: { includeHidden?: boolean; signal?: AbortSignal } = {},
): Promise<HomePingSummary> {
  const query = includeHidden ? '?include_hidden=1' : '';
  const response = await fetchWithBootstrapRetry(`/api/ping/home${query}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeHomePingSummary(await response.json());
}

// 阈值按「国内到海外 VPS」的常见体感定：<100 很好，<200 可用，<300 偏高，其余很差。
export function latencyLevel(latencyMs: number | null, lossPercent: number | null = null): HomePingLevel {
  if (latencyMs === null) return lossPercent !== null && lossPercent > 0 ? 'bad' : 'none';
  if (latencyMs < 100) return 'good';
  if (latencyMs < 200) return 'ok';
  if (latencyMs < 300) return 'warn';
  return 'bad';
}

export function lossLevel(lossPercent: number | null): HomePingLevel {
  if (lossPercent === null) return 'none';
  if (lossPercent <= 0) return 'good';
  if (lossPercent < 5) return 'ok';
  if (lossPercent < 20) return 'warn';
  return 'bad';
}

export function formatHomeLatency(latencyMs: number | null): string {
  return latencyMs === null ? '--' : `${Math.round(latencyMs)}`;
}

export function formatHomeLoss(lossPercent: number | null): string {
  if (lossPercent === null) return '--';
  if (lossPercent <= 0) return '0.0';
  return lossPercent.toFixed(lossPercent < 10 ? 1 : 0);
}
