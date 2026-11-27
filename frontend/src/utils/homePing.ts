import { fetchWithBootstrapRetry } from './api.ts';

// 对应 worker 的 GET /api/ping/home。每个节点只带「首页探测点」那一个任务最新的 N 次原始采样（不聚合）。
export interface HomePingPoint {
  /** 采样时间，毫秒时间戳 */
  t: number;
  /** 该次采样的延迟；丢包 / 超时为 null */
  latency_ms: number | null;
}

export interface HomePingNode {
  task_id: number;
  task_name: string;
  updated_at: string | null;
  /** 按时间升序，最后一个是最新采样 */
  points: HomePingPoint[];
}

export interface HomePingSummary {
  /** 每个节点最多返回的采样数，也是前端色块的总格数 */
  sample_count: number;
  generated_at: string;
  nodes: Record<string, HomePingNode>;
}

/** lost：丢包 / 超时（灰色）；none：还没有这格的数据（占位）。 */
export type HomePingLevel = 'good' | 'ok' | 'warn' | 'bad' | 'lost' | 'none';

export const DEFAULT_HOME_PING_SAMPLE_COUNT = 24;

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
      updated_at: typeof node.updated_at === 'string' ? node.updated_at : null,
      points: Array.isArray(node.points)
        ? node.points.map((point) => {
          const p = (point && typeof point === 'object' ? point : {}) as Record<string, unknown>;
          return {
            t: Number(p.t) || 0,
            latency_ms: finiteOrNull(p.latency_ms),
          };
        })
        : [],
    };
  }
  return {
    sample_count: Number(raw.sample_count) > 0 ? Math.floor(Number(raw.sample_count)) : DEFAULT_HOME_PING_SAMPLE_COUNT,
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
// 丢包 / 超时（null）不算「很差」，统一用灰色表示。
export function latencyLevel(latencyMs: number | null): HomePingLevel {
  if (latencyMs === null) return 'lost';
  if (latencyMs < 100) return 'good';
  if (latencyMs < 200) return 'ok';
  if (latencyMs < 300) return 'warn';
  return 'bad';
}

export function formatHomeLatency(latencyMs: number | null): string {
  return latencyMs === null ? '--' : `${Math.round(latencyMs)}`;
}

/** 色块序列：固定 sampleCount 格，最新采样在最右；不足的部分在左侧用 null 占位。 */
export function homePingSlots(points: HomePingPoint[], sampleCount: number): (HomePingPoint | null)[] {
  const recent = sampleCount > 0 ? points.slice(-sampleCount) : [];
  const padding = Math.max(0, sampleCount - recent.length);
  return [...Array<null>(padding).fill(null), ...recent];
}

export interface HomePingHead {
  /** 数字区显示的文字：最新一格的延迟、「超时」或「--」 */
  text: string;
  /** 只有最新一格是有效延迟时才带 ms 单位 */
  showUnit: boolean;
  level: HomePingLevel;
}

/** 数字区只反映最新一格：有值显示 ms，超时显示「超时」，还没有采样显示「--」。 */
export function homePingHead(points: HomePingPoint[]): HomePingHead {
  const latest = points.length > 0 ? points[points.length - 1] : null;
  if (!latest) return { text: '--', showUnit: false, level: 'none' };
  if (latest.latency_ms === null) return { text: '超时', showUnit: false, level: 'lost' };
  return { text: formatHomeLatency(latest.latency_ms), showUnit: true, level: latencyLevel(latest.latency_ms) };
}
