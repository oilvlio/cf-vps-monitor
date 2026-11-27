export type HistoryRetentionHours = {
  record_preserve_time: number;
  ping_record_preserve_time: number;
  rollup_preserve_time: number;
};

export type HistoryStorageBytes = {
  records: number;
  ping_snapshots: number;
  host_rollup: number;
  ping_rollup: number;
  total: number;
};

export type HistoryRetentionEstimate = {
  current_bytes: number;
  projected_bytes: number;
  budget_bytes: number;
  budget_ratio: number;
  client_count: number;
  per_client_change_bytes: number | null;
  capacity_risk: boolean;
  components: { host_raw_bytes: number; ping_raw_bytes: number; rollup_bytes: number };
  current_retention: HistoryRetentionHours;
};

const RAW_HOST_TABLES = ['records'] as const;
const RAW_PING_TABLES = ['ping_snapshots'] as const;
const ROLLUP_TABLES = ['host_rollup', 'ping_rollup'] as const;

function validHours(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 168;
}

function scaledTableBytes(
  bytes: HistoryStorageBytes,
  tables: readonly string[],
  currentHours: number,
  targetHours: number,
): number {
  const sum = tables.reduce((total, name) => total + Math.max(0, Number(bytes[name as keyof HistoryStorageBytes]) || 0), 0);
  return sum * targetHours / currentHours;
}

/** Linear per-node estimate from allocated partition-tree bytes; not a quota guarantee. */
export function estimateHistoryRetention(
  bytes: HistoryStorageBytes,
  current: HistoryRetentionHours,
  target: HistoryRetentionHours,
  clientCount: number,
  budgetBytes: number,
): HistoryRetentionEstimate {
  const currentBytes = Math.max(0, Number(bytes.total) || 0);
  const components = {
    host_raw_bytes: RAW_HOST_TABLES.reduce((sum, name) => sum + Math.max(0, Number(bytes[name]) || 0), 0),
    ping_raw_bytes: RAW_PING_TABLES.reduce((sum, name) => sum + Math.max(0, Number(bytes[name]) || 0), 0),
    rollup_bytes: ROLLUP_TABLES.reduce((sum, name) => sum + Math.max(0, Number(bytes[name]) || 0), 0),
  };
  const projectedBytes = Math.round(
    scaledTableBytes(bytes, RAW_HOST_TABLES, validHours(current.record_preserve_time), validHours(target.record_preserve_time))
      + scaledTableBytes(bytes, RAW_PING_TABLES, validHours(current.ping_record_preserve_time), validHours(target.ping_record_preserve_time))
      + scaledTableBytes(bytes, ROLLUP_TABLES, validHours(current.rollup_preserve_time), validHours(target.rollup_preserve_time)),
  );
  const nodes = Number.isFinite(clientCount) ? Math.max(0, Math.floor(clientCount)) : 0;
  const safeBudget = Math.max(0, Number(budgetBytes) || 0);
  return {
    current_bytes: currentBytes,
    projected_bytes: projectedBytes,
    budget_bytes: safeBudget,
    budget_ratio: safeBudget > 0 ? projectedBytes / safeBudget : 0,
    client_count: nodes,
    per_client_change_bytes: nodes > 0 ? Math.round((projectedBytes - currentBytes) / nodes) : null,
    capacity_risk: safeBudget > 0 && projectedBytes >= safeBudget * 0.8,
    components,
    current_retention: {
      record_preserve_time: validHours(current.record_preserve_time),
      ping_record_preserve_time: validHours(current.ping_record_preserve_time),
      rollup_preserve_time: validHours(current.rollup_preserve_time),
    },
  };
}
