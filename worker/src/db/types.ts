export interface Client {
  uuid: string;
  token: string;
  token_hash: string;
  token_last_used_at: string | null;
  token_last_used_ip: string;
  token_rotated_at: string | null;
  name: string;
  cpu_name: string;
  virtualization: string;
  arch: string;
  cpu_cores: number;
  os: string;
  kernel_version: string;
  gpu_name: string;
  ipv4: string;
  ipv6: string;
  region: string;
  remark: string;
  public_remark: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  version: string;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  expired_at: string | null;
  group: string;
  tags: string;
  hidden: boolean;
  /** 流量配额（字节），具体口径见 traffic_limit_type。 */
  traffic_limit: number;
  traffic_limit_type: string;
  // 每月流量重置日（1~31）。服务端据此计算聚合周期，并经 agent policy 下发。
  traffic_reset_day: number;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

/** cfm_public_clients 的显式投影；新增管理字段不会自动扩散到公开模型。 */
export type PublicClientRow = Pick<Client,
  | 'uuid' | 'name' | 'cpu_name' | 'virtualization' | 'arch' | 'cpu_cores' | 'os'
  | 'kernel_version' | 'gpu_name' | 'ipv4' | 'ipv6' | 'region' | 'public_remark'
  | 'mem_total' | 'swap_total' | 'disk_total' | 'version' | 'price' | 'billing_cycle'
  | 'auto_renewal' | 'currency' | 'expired_at' | 'group' | 'tags' | 'hidden'
  | 'traffic_limit' | 'traffic_limit_type' | 'traffic_reset_day' | 'sort_order'
  | 'created_at' | 'updated_at'
>;

export type ScheduledClientRow = Pick<Client, 'uuid' | 'name' | 'created_at' | 'expired_at'>;
export type ClientTokenMeta = Pick<Client, 'uuid' | 'token' | 'token_hash' | 'name'>;
export type ClientIdentity = Pick<Client, 'uuid' | 'token' | 'token_last_used_ip' | 'token_rotated_at' | 'created_at' | 'name' | 'hidden'>;

export interface ClientCapacityCounts {
  clients: number;
  gpu_clients: number;
}

export interface MonitorRecord {
  id?: number;
  client: string;
  time: string;
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  // null = 本机负载不可取信（容器内 /proc/loadavg 透传宿主机），不是 0。
  load: number | null;
  // load5/load15 与 load 同语义：显式 null = 不可用，缺字段 = 0（老探针兼容）。
  load5: number | null;
  load15: number | null;
  temp: number | null;
  disk: number | null;
  disk_total: number | null;
  /** 网络速率为字节/秒；net_total_* 为当前计费周期累计字节。 */
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number | null;
}

/**
 * `cfm_records_range_aggregated` 的一个分桶：桶内所有记录一起聚合，
 * `samples` 是桶内记录数，`minutes` 是按落库间隔折算出的分钟数。
 */
export interface MonitorMetricsBucket {
  ts: number;
  samples: number;
  minutes: number;
  cpu: number;
  cpu_max: number;
  mem_used: number;
  disk_used: number | null;
  net_rx: number;
  net_tx: number;
  net_rx_max: number;
  net_tx_max: number;
  swap_used: number;
  tcp: number;
  udp: number;
  procs: number;
}

/** `cfm_traffic_totals` 给单个节点的当日 / 累计流量（字节）。 */
export interface MonitorTrafficTotals {
  day_rx: number;
  day_tx: number;
  total_rx: number;
  total_tx: number;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  next_cursor?: string;
}

export type LoadNotificationMetric = 'cpu' | 'ram' | 'load' | 'disk' | 'temp';

export interface LoadMetricWindowStats {
  samples: number;
  exceeded: number;
  avg_value: number;
}

export type DeleteOldRowsOptions = {
  maxBatches?: number;
};

export type HistoryMaintenanceResult = {
  created: number;
  dropped: number;
  dropped_by_parent?: Record<string, number>;
  pending: number;
  skipped: number;
  locked: boolean;
};

export type HistoryDeleteCounts = {
  records: number;
  ping_snapshots: number;
  ping_rollup: number;
  host_rollup: number;
};

export type DeleteClientsResult = {
  removed: number;
  deleted_records: Pick<HistoryDeleteCounts, 'host_rollup' | 'ping_rollup'> & { rollup_dirty: number };
};

export interface GPUInfo {
  device_index: number;
  device_name: string;
  mem_total: number;
  mem_used: number;
  utilization: number;
  temperature: number;
}


export interface User {
  uuid: string;
  username: string;
  passwd: string;
  session_version: number;
  password_changed_at: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_used_step: number;
  recovery_code_hashes: string[];
  created_at: string;
  updated_at: string;
}

export interface LoginRateLimit {
  bucket: string;
  failure_revision: string;
  failures: number;
  first_failed_at: string;
  last_failed_at: string;
  locked_until: string | null;
}

export interface AuditLogEntry {
  id?: number;
  time: string;
  user: string;
  action: string;
  detail: string;
  level: string;
}

export interface AuditLogsPage {
  logs: AuditLogEntry[];
  total: number;
  has_more: boolean;
  /** 全表出现过的动作类型（不受当前筛选影响），供前端下拉框使用。 */
  actions?: string[];
}

export interface AuditLogsFilter {
  /** 精确匹配动作；空值表示不过滤。 */
  action?: string;
  /** 在 ID / 用户 / 动作 / 详情中做不区分大小写的子串匹配；空值表示不过滤。 */
  search?: string;
}

export interface Theme {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview_path: string;
  style_path: string;
  manifest_json: string;
  config_json: string;
  custom_css: string;
  created_at: string;
  updated_at: string;
}

export interface ThemeAsset {
  theme_short: string;
  path: string;
  content_type: string;
  content_base64: string;
  size_bytes: number;
  created_at: string;
}

export type ThemeUpsertInput = Omit<Theme, 'created_at' | 'updated_at'>;
export type ThemeAssetUpsertInput = Omit<ThemeAsset, 'theme_short' | 'created_at'>;

export interface PingTask {
  id?: number;
  name: string;
  clients: string[];
  all_clients: boolean;
  type: string;
  target: string;
  interval_sec: number;
  /** 任务默认探测硬期限（毫秒），超过即按丢包记录。 */
  timeout_ms: number;
  /**
   * 仅管理端列表使用：client uuid -> 该节点上的超时覆盖。
   * Agent 下发前会被解析成最终生效的 timeout_ms，不会原样下发。
   */
  client_timeouts?: Record<string, number>;
  sort_order?: number;
}

/** 节点—任务级超时覆盖。 */
export interface PingTaskClientTimeout {
  task_id: number;
  client: string;
  timeout_ms: number;
}

export type ClientPingAssignmentResult =
  | { ok: true; tasks: PingTask[]; timeouts: number }
  | { ok: false; status: 400 | 404; error: string };

export type PingTaskEstimateRow = Pick<PingTask, 'id' | 'name' | 'clients' | 'all_clients' | 'interval_sec'>;

export interface PingHistoryRecord {
  id?: number;
  client: string;
  task_id: number;
  time: string;
  /** 原始点为整数 ms；分桶点为桶内中位数（不取整），桶内全部丢包时为 -1。 */
  value: number;
  /** 以下仅分桶结果带有。 */
  sample_count?: number;
  success_count?: number;
  loss_count?: number;
  avg_latency?: number | null;
  min_latency?: number | null;
  max_latency?: number | null;
  p50_latency?: number | null;
  p75_latency?: number | null;
}

/** 整个时间窗口的 Ping 统计（cfm_ping_stats_for_tasks_range）；没有成功样本时延迟类字段为 null。 */
export interface PingTaskStats {
  samples: number;
  success_count: number;
  loss_count: number;
  loss_rate: number | null;
  avg_latency: number | null;
  min_latency: number | null;
  max_latency: number | null;
  p50_latency: number | null;
  p75_latency: number | null;
  /** 成功样本延迟的样本标准差（ms），不足 2 个样本时为 null。 */
  jitter: number | null;
}

export interface PingSnapshotInput {
  taskId: number;
  value: number;
}

export interface PingTaskHistoryRequest {
  taskId: number;
  limit?: number;
  intervalSec?: number;
}

export interface NotificationDeliveryClaim {
  claimed: boolean;
  delivered: boolean;
  token: string | null;
}

export interface NotificationDeliveryCleanupResult {
  notification_delivery_state: number;
  has_more: boolean;
}

export interface NotificationDeliveryCleanupOptions {
  batchSize?: number;
  maxBatches?: number;
}

export interface OfflineNotificationUpdate {
  client: string;
  enable: boolean;
  grace_period: number;
}

export interface OfflineNotification extends OfflineNotificationUpdate {
  last_notified: string | null;
  /** 本次离线起点（断线前最后一次上报；从未上报时为创建时间）。 */
  offline_since: string | null;
  /** 本月累计离线所属月份，北京时间 `YYYY-MM`。 */
  month_key: string | null;
  /** 本月已完成离线累计毫秒。PostgREST 可能把 bigint 序列化为字符串。 */
  month_offline_ms: number | string | null;
}

export interface OfflineTransition {
  phase: 'offline' | 'recovery';
  time?: string | null;
  since?: string | null;
  monthKey?: string | null;
  monthOfflineMs?: number | null;
  token: string;
}

export interface IpChangeNotification {
  client: string;
  enable: boolean;
}

export interface ExpiryNotificationUpdate {
  client: string;
  enable: boolean;
  advance_days: number;
}

export interface ExpiryNotification extends ExpiryNotificationUpdate {
  last_notified: string | null;
}

export interface LoadNotification {
  id?: number;
  name: string;
  clients: string[];
  metric: LoadNotificationMetric;
  threshold: number;
  ratio: number;
  interval_min: number;
  last_notified: string | null;
}

export interface LoadNotificationInput {
  id?: unknown;
  name?: unknown;
  clients?: unknown;
  metric?: unknown;
  threshold?: unknown;
  ratio?: unknown;
  interval_min?: unknown;
  last_notified?: unknown;
  [key: string]: unknown;
}

export interface ClientReferenceCleanupResult {
  ping_tasks_updated: number;
  load_notifications_updated: number;
  load_notifications_deleted: number;
  expiry_notifications_deleted: number;
}

export interface OrphanClientDataCleanupResult extends ClientReferenceCleanupResult {
  offline_notifications_deleted: number;
  host_rollup_deleted: number;
  ping_rollup_deleted: number;
  rollup_dirty_deleted: number;
}

// Historical storage is measured from actual partition-tree allocation.
export interface HistoryTableByteSizes {
  records: number;
  ping_snapshots: number;
  host_rollup: number;
  ping_rollup: number;
  total: number;
  allocated_bytes: number;
}

export interface HistoryStorageUsage extends HistoryTableByteSizes {
  allocated_bytes: number;
  measurement: 'partition-tree-bytes';
}

export interface HistoryMaintenanceStatus {
  checked_at: string;
  rollups: Record<'host' | 'ping', {
    watermark: string | null;
    lag_seconds: number | null;
    dirty_buckets: number;
    oldest_dirty_at: string | null;
    oldest_dirty_age_seconds: number | null;
  }>;
  partitions: Record<string, {
    min_start: string | null;
    max_end: string | null;
    runway_seconds: number | null;
    gate_family: string | null;
    gate_watermark: string | null;
    gate_clearance_seconds: number | null;
  }>;
  partition_maintenance: {
    updated_at: string | null;
    pending_partitions: number;
    lock_timeouts: number;
  };
}
