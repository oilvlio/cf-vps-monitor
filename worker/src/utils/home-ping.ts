// 首页节点卡片的延迟色块。
//
// 和详情页 4h / 12h 档一致：不做分桶聚合，直接取该节点「首页探测点」最新的 N 次采样，
// 每次采样一个色块（最右边是最新）。ping_snapshots 按落库间隔全量保存采样
// （live-data.ts 里没有值没变不落库的压缩），所以最新 N 行就是最新 N 次采样。
// 丢包 / 超时的采样落库值为 -1，这里统一输出 latency_ms = null。

export const HOME_PING_SAMPLE_COUNT = 24;
// 落库间隔最长 3600 秒，24 个采样最多跨 24 小时；超过这个时间没有新采样的节点视为没有数据。
export const HOME_PING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface HomePingRow {
  time: string;
  value: number;
}

export interface HomePingSource {
  task_id: number;
  name: string;
  rows: HomePingRow[];
}

export interface HomePingPoint {
  /** 采样时间，毫秒时间戳 */
  t: number;
  /** 该次采样的延迟；丢包 / 超时为 null */
  latency_ms: number | null;
}

export interface HomePingNode {
  task_id: number;
  task_name: string;
  /** 最新一次采样的时间 */
  updated_at: string | null;
  /** 按时间升序，最后一个是最新采样 */
  points: HomePingPoint[];
}

export interface HomePingSummary {
  sample_count: number;
  generated_at: string;
  nodes: Record<string, HomePingNode>;
}

export function buildHomePingNode(
  source: HomePingSource,
  sampleCount = HOME_PING_SAMPLE_COUNT,
): HomePingNode {
  const samples = source.rows
    .map((row) => ({ time: Date.parse(row.time), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.time) && Number.isFinite(row.value))
    .sort((a, b) => a.time - b.time)
    .slice(-sampleCount);

  return {
    task_id: source.task_id,
    task_name: source.name,
    updated_at: samples.length > 0 ? new Date(samples[samples.length - 1].time).toISOString() : null,
    points: samples.map((sample) => ({
      t: sample.time,
      latency_ms: sample.value >= 0 ? Math.round(sample.value) : null,
    })),
  };
}

export function buildHomePingSummary(
  sources: Record<string, HomePingSource>,
  nowMs: number,
  sampleCount = HOME_PING_SAMPLE_COUNT,
): HomePingSummary {
  const nodes: Record<string, HomePingNode> = {};
  for (const [uuid, source] of Object.entries(sources)) {
    nodes[uuid] = buildHomePingNode(source, sampleCount);
  }
  return {
    sample_count: sampleCount,
    generated_at: new Date(nowMs).toISOString(),
    nodes,
  };
}

/** 查询窗口 [start, end]：只在这段时间内取每个节点最新的 N 行。 */
export function homePingQueryRange(nowMs: number) {
  return {
    start: new Date(nowMs - HOME_PING_LOOKBACK_MS).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}
