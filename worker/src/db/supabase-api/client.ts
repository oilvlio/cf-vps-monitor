import type { AuditLogsFilter, AuditLogsPage, Client, ClientCapacityCounts, ClientIdentity, ClientReferenceCleanupResult, ClientTokenMeta, DeleteClientsResult, DeleteOldRowsOptions, ExpiryNotification, ExpiryNotificationUpdate, HistoryMaintenanceResult, HistoryMaintenanceStatus,
  HistoryTableByteSizes, IpChangeNotification, LoadMetricWindowStats, LoadNotification, LoadNotificationInput, LoadNotificationMetric, LoginRateLimit, MonitorMetricsBucket, MonitorRecord, MonitorTrafficTotals, OfflineNotification, OfflineNotificationUpdate, OfflineTransition, OrphanClientDataCleanupResult, PingHistoryRecord, PingSnapshotInput, PingTask, PingTaskClientTimeout, PingTaskEstimateRow, PingTaskHistoryRequest, PingTaskStats, PublicClientRow, ScheduledClientRow, Theme, ThemeAsset, ThemeAssetUpsertInput, ThemeUpsertInput, User } from '../types.ts';
import type { NotificationDeliveryClaim, NotificationDeliveryCleanupOptions, NotificationDeliveryCleanupResult } from '../types.ts';
import type { ClientPingAssignmentResult } from '../types.ts';
import { redactDatabaseSecrets } from '../../utils/setup-diagnostics.ts';
import { generateAgentToken, hashAgentToken } from '../../utils/client.ts';
import { ScheduledBudgetExceeded, scheduledFetch } from '../../utils/scheduled-budget.ts';
import {
  DEFAULT_SUPABASE_RPC_TIMEOUT_MS,
  LONG_RUNNING_SUPABASE_RPC_TIMEOUT_MS,
  SUPABASE_RPC_READ_ATTEMPTS,
  SUPABASE_RPC_RETRY_BASE_DELAY_MS,
  isRetryableReadStatus,
  supabaseRpcMode,
  type SupabaseRpcMode,
} from './rpc-policy.ts';

export type SupabaseApiEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export class SupabaseApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseApiConfigurationError';
  }
}

export class SupabaseApiError extends Error {
  readonly status: number;

  constructor(functionName: string, status: number, detail: string) {
    super(`Supabase RPC ${functionName} failed: ${status} ${detail}`.trim());
    this.name = 'SupabaseApiError';
    this.status = status;
  }
}

export class SupabaseRpcTimeoutError extends Error {
  readonly functionName: string;
  readonly timeoutMs: number;

  constructor(functionName: string, timeoutMs: number) {
    super(`Supabase RPC ${functionName} timed out after ${timeoutMs}ms`);
    this.name = 'SupabaseRpcTimeoutError';
    this.functionName = functionName;
    this.timeoutMs = timeoutMs;
  }
}

export interface SupabaseRpcOptions {
  /** 调用方取消信号；路由可传 request.signal。 */
  signal?: AbortSignal;
  /** 单次尝试的超时（毫秒）；传 0 或负数表示不设上限。 */
  timeoutMs?: number;
  /** 覆盖按 RPC 名称推断的读/写策略。 */
  mode?: SupabaseRpcMode;
}

export function isSupabaseApiConfigured(env: SupabaseApiEnv): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && resolveSupabaseApiKey(env));
}

export function resolveSupabaseApiKey(env: SupabaseApiEnv): string {
  return env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
}

function readSupabaseConfig(env: SupabaseApiEnv): { url: string; key: string } {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = resolveSupabaseApiKey(env);
  if (!url || !key) {
    throw new SupabaseApiConfigurationError('SUPABASE_URL and SUPABASE_SECRET_KEY are required for Supabase Data API mode.');
  }
  return { url, key };
}

function supabaseRpcHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function sanitizeSupabaseDetail(detail: string, key: string): string {
  return redactDatabaseSecrets(detail).replaceAll(key, '[REDACTED]').slice(0, 400);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableReadFailure(error: unknown): boolean {
  if (error instanceof SupabaseRpcTimeoutError) return true;
  if (error instanceof SupabaseApiError) return isRetryableReadStatus(error.status);
  // 进入下一次调度前预算已耗尽：重试只会立刻再失败。
  if (error instanceof ScheduledBudgetExceeded) return false;
  // fetch 的连接/DNS/TLS 失败统一抛 TypeError；读请求可安全重试。
  return error instanceof TypeError;
}

interface SupabaseRpcAttempt {
  url: string;
  functionName: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
}

/**
 * 单次 RPC 尝试：默认超时 + 调用方取消都会在应用层直接结束等待，
 * 不依赖底层 fetch 是否响应 AbortSignal。
 */
async function fetchSupabaseRpcAttempt(attempt: SupabaseRpcAttempt): Promise<Response> {
  const { url, functionName, body, headers, fetcher, signal, timeoutMs } = attempt;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (!(timeoutMs > 0)) return;
    timer = setTimeout(() => {
      timedOut = true;
      const error = new SupabaseRpcTimeoutError(functionName, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const callerAbortPromise = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([
      scheduledFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }, fetcher),
      timeoutPromise,
      callerAbortPromise,
    ]);
  } catch (error) {
    if (timedOut) {
      throw error instanceof SupabaseRpcTimeoutError ? error : new SupabaseRpcTimeoutError(functionName, timeoutMs);
    }
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

export async function callSupabaseRpc<T>(
  env: SupabaseApiEnv,
  functionName: string,
  body: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
  options: SupabaseRpcOptions = {},
): Promise<T> {
  const { url, key } = readSupabaseConfig(env);
  if (options.signal?.aborted) throw abortReason(options.signal);

  const mode = options.mode ?? supabaseRpcMode(functionName);
  const attempts = mode === 'read' ? SUPABASE_RPC_READ_ATTEMPTS : 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPABASE_RPC_TIMEOUT_MS;
  const headers = supabaseRpcHeaders(key);
  const rpcUrl = `${url}/rest/v1/rpc/${encodeURIComponent(functionName)}`;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchSupabaseRpcAttempt({
        url: rpcUrl,
        functionName,
        body,
        headers,
        fetcher,
        signal: options.signal,
        timeoutMs,
      });
      if (!response.ok) {
        const detail = sanitizeSupabaseDetail(await response.text().catch(() => ''), key);
        throw new SupabaseApiError(functionName, response.status, detail);
      }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      if (attempt >= attempts || !isRetryableReadFailure(error)) throw error;
      await sleep(SUPABASE_RPC_RETRY_BASE_DELAY_MS * attempt, options.signal);
    }
  }
}

function readRpcBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function normalizeClientBooleans<T extends { hidden?: unknown; auto_renewal?: unknown } | null>(client: T): T {
  if (!client || typeof client !== 'object') return client;
  const record = client as Record<string, unknown>;
  return {
    ...client,
    ...(Object.prototype.hasOwnProperty.call(record, 'hidden') ? { hidden: readRpcBoolean(record.hidden) } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'auto_renewal') ? { auto_renewal: readRpcBoolean(record.auto_renewal) } : {}),
  } as T;
}

function normalizeClientList<T extends { hidden?: unknown; auto_renewal?: unknown }>(clients: T[]): T[] {
  return clients.map(normalizeClientBooleans);
}

function readRpcStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
}

function normalizePingTask<T extends { clients?: unknown; all_clients?: unknown }>(task: T): T {
  return {
    ...task,
    clients: readRpcStringArray((task as Record<string, unknown>).clients),
    all_clients: readRpcBoolean((task as Record<string, unknown>).all_clients),
  } as T;
}

function normalizePingTaskList<T extends { clients?: unknown; all_clients?: unknown }>(tasks: T[]): T[] {
  return tasks.map(normalizePingTask);
}

export function getSupabasePublicSettings(env: SupabaseApiEnv): Promise<Record<string, string>> {
  return callSupabaseRpc<Record<string, string>>(env, 'cfm_public_settings');
}

export function getSupabaseSettingsByKeys(env: SupabaseApiEnv, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return Promise.resolve({});
  return callSupabaseRpc<Record<string, string>>(env, 'cfm_settings_by_keys', { input_keys: [...new Set(keys)] });
}

export function setSupabaseSettings(env: SupabaseApiEnv, settings: Record<string, string>): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_set_settings', { input_settings: settings });
}

export function getSupabasePublicClients(env: SupabaseApiEnv): Promise<PublicClientRow[]> {
  return callSupabaseRpc<PublicClientRow[]>(env, 'cfm_public_clients').then(normalizeClientList);
}

export function getSupabaseAdminClients(env: SupabaseApiEnv): Promise<Client[]> {
  return callSupabaseRpc<Client[]>(env, 'cfm_admin_clients').then(normalizeClientList);
}


export function getSupabaseClient(env: SupabaseApiEnv, uuid: string): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_client', { input_uuid: uuid }).then(normalizeClientBooleans);
}


export function listSupabaseScheduledClientRows(env: SupabaseApiEnv): Promise<ScheduledClientRow[]> {
  return callSupabaseRpc<ScheduledClientRow[]>(env, 'cfm_scheduled_clients');
}

export function getSupabaseScheduledClientRowsByIds(env: SupabaseApiEnv, uuids: string[]): Promise<ScheduledClientRow[]> {
  return callSupabaseRpc<ScheduledClientRow[]>(env, 'cfm_scheduled_clients_by_ids', { input_uuids: uuids });
}

export function getSupabaseClientTokenMeta(env: SupabaseApiEnv, uuid: string): Promise<ClientTokenMeta | null> {
  return callSupabaseRpc<ClientTokenMeta | null>(env, 'cfm_client_token_meta', { input_uuid: uuid });
}

export function getSupabaseClientsByIds(env: SupabaseApiEnv, uuids: string[]): Promise<Client[]> {
  return callSupabaseRpc<Client[]>(env, 'cfm_clients_by_ids', { input_uuids: uuids }).then(normalizeClientList);
}

export function getSupabaseClientIds(env: SupabaseApiEnv): Promise<string[]> {
  return callSupabaseRpc<string[]>(env, 'cfm_client_ids');
}

export async function getSupabaseClientByToken(env: SupabaseApiEnv, token: string): Promise<Client | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<Client | null>(env, 'cfm_agent_client_by_token', {
    input_token_hash: tokenHash,
    input_token: token,
  }).then(normalizeClientBooleans);
}

export async function getSupabaseClientIdentityByToken(env: SupabaseApiEnv, token: string): Promise<ClientIdentity | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<ClientIdentity | null>(env, 'cfm_agent_client_identity_by_token', {
    input_token_hash: tokenHash,
    input_token: token,
  }).then(normalizeClientBooleans);
}

export async function supabaseClientTokenExists(env: SupabaseApiEnv, token: string): Promise<boolean> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<boolean>(env, 'cfm_client_token_exists', {
    input_token_hash: tokenHash,
    input_token: token,
  });
}

export async function getSupabaseClientCreateConflict(env: SupabaseApiEnv, uuid: string, token: string): Promise<'uuid' | 'token' | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<'uuid' | 'token' | null>(env, 'cfm_client_create_conflict', {
    input_uuid: uuid,
    input_token_hash: tokenHash,
    input_token: token,
  });
}

export async function createSupabaseClient(env: SupabaseApiEnv, client: Partial<Client>): Promise<Client> {
  const token = client.token || generateAgentToken();
  return callSupabaseRpc<Client>(env, 'cfm_create_client', {
    input_client: {
      uuid: client.uuid || crypto.randomUUID(),
      name: client.name || '',
      token,
      token_hash: client.token_hash || await hashAgentToken(token),
      sort_order: client.sort_order,
    },
  }).then(normalizeClientBooleans);
}

export type MarkClientTokenUsedResult = {
  updated: boolean;
  previous_ip: string | null;
};

export function markSupabaseClientTokenUsed(env: SupabaseApiEnv, uuid: string, ip = ''): Promise<MarkClientTokenUsedResult> {
  return callSupabaseRpc<MarkClientTokenUsedResult>(env, 'cfm_mark_client_token_used', {
    input_uuid: uuid,
    input_ip: ip,
  });
}

export async function rotateSupabaseClientToken(env: SupabaseApiEnv, uuid: string, token: string): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_rotate_client_token', {
    input_uuid: uuid,
    input_token: token,
    input_token_hash: await hashAgentToken(token),
  }).then(normalizeClientBooleans);
}

export function updateSupabaseClient(env: SupabaseApiEnv, uuid: string, data: Partial<Client> | Record<string, unknown>): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_client', {
    input_uuid: uuid,
    input_patch: data,
  });
}

export function updateSupabaseClientAndReturn(env: SupabaseApiEnv, uuid: string, data: Partial<Client> | Record<string, unknown>): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_update_client_returning', {
    input_uuid: uuid,
    input_patch: data,
  }).then(normalizeClientBooleans);
}

export function deleteSupabaseClients(env: SupabaseApiEnv, uuids: string[]): Promise<DeleteClientsResult> {
  return callSupabaseRpc<DeleteClientsResult>(env, 'cfm_delete_clients', { input_uuids: uuids });
}

export function pruneSupabaseClientReferences(env: SupabaseApiEnv, uuid: string): Promise<ClientReferenceCleanupResult> {
  return pruneSupabaseClientReferencesForClients(env, [uuid]);
}

export function pruneSupabaseClientReferencesForClients(env: SupabaseApiEnv, uuids: string[]): Promise<ClientReferenceCleanupResult> {
  return callSupabaseRpc<ClientReferenceCleanupResult>(env, 'cfm_prune_client_references', { input_uuids: uuids });
}

export function cleanupSupabaseOrphanClientData(env: SupabaseApiEnv): Promise<OrphanClientDataCleanupResult> {
  return callSupabaseRpc<OrphanClientDataCleanupResult>(env, 'cfm_cleanup_orphan_client_data');
}

export function updateSupabaseClientsHidden(env: SupabaseApiEnv, uuids: string[], hidden: boolean): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_update_clients_hidden', {
    input_uuids: uuids,
    input_hidden: hidden,
  });
}

export function reorderSupabaseClients(env: SupabaseApiEnv, uuids: string[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_reorder_clients', { input_uuids: uuids });
}

export function getSupabaseClientCapacityCounts(env: SupabaseApiEnv): Promise<ClientCapacityCounts> {
  return callSupabaseRpc<ClientCapacityCounts>(env, 'cfm_client_capacity_counts');
}

export function getSupabasePingTaskEstimateRows(env: SupabaseApiEnv): Promise<PingTaskEstimateRow[]> {
  return callSupabaseRpc<PingTaskEstimateRow[]>(env, 'cfm_ping_task_estimate_rows').then(normalizePingTaskList);
}


export function createSupabasePingTask(env: SupabaseApiEnv, task: PingTask): Promise<PingTask> {
  return callSupabaseRpc<PingTask>(env, 'cfm_create_ping_task', { input_task: task }).then(normalizePingTask);
}

export function updateSupabasePingTaskAndReturn(env: SupabaseApiEnv, id: number, task: Partial<PingTask>): Promise<PingTask | null> {
  return callSupabaseRpc<PingTask | null>(env, 'cfm_update_ping_task', {
    input_id: id,
    input_task: task,
  }).then(task => task ? normalizePingTask(task) : null);
}

export function reorderSupabasePingTasks(env: SupabaseApiEnv, ids: number[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_reorder_ping_tasks', { input_ids: ids });
}

export function deleteSupabasePingTask(env: SupabaseApiEnv, id: number): Promise<PingTask | null> {
  return callSupabaseRpc<PingTask | null>(env, 'cfm_delete_ping_task', { input_id: id }).then(task => task ? normalizePingTask(task) : null);
}

export function maintainSupabaseHistory(env: SupabaseApiEnv, now: string): Promise<HistoryMaintenanceResult> {
  return callSupabaseRpc<HistoryMaintenanceResult>(
    env,
    'cfm_partition_maintain',
    { input_now: now },
    fetch,
    { timeoutMs: LONG_RUNNING_SUPABASE_RPC_TIMEOUT_MS },
  );
}


export function buildSupabaseRollup(
  env: SupabaseApiEnv,
  family: 'host' | 'ping',
  now: string,
  maxBuckets = 48,
): Promise<Record<string, unknown>> {
  return callSupabaseRpc<Record<string, unknown>>(env, 'cfm_build_rollup', {
    input_family: family, input_now: now, input_max_buckets: maxBuckets,
  }, fetch, { timeoutMs: LONG_RUNNING_SUPABASE_RPC_TIMEOUT_MS });
}

export function deleteSupabaseOldAuditLogs(
  env: SupabaseApiEnv,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ audit_logs: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_delete_old_audit_logs', {
    input_before_time: beforeTime,
    input_max_batches: options.maxBatches,
  }, fetch, { timeoutMs: LONG_RUNNING_SUPABASE_RPC_TIMEOUT_MS });
}

export function claimSupabaseNotificationDelivery(
  env: SupabaseApiEnv, key: string, eventId: string, now: string, repeatMs: number,
): Promise<NotificationDeliveryClaim> {
  return callSupabaseRpc(env, 'cfm_claim_notification_delivery', {
    input_key: key, input_event_id: eventId, input_now: now, input_repeat_ms: repeatMs,
  });
}

export function completeSupabaseNotificationDelivery(
  env: SupabaseApiEnv, key: string, eventId: string, token: string, success: boolean, now: string, repeatMs: number,
): Promise<boolean> {
  return callSupabaseRpc(env, 'cfm_complete_notification_delivery', {
    input_key: key, input_event_id: eventId, input_token: token,
    input_success: success, input_now: now, input_repeat_ms: repeatMs,
  });
}


export function listSupabaseOfflineNotifications(env: SupabaseApiEnv): Promise<OfflineNotification[]> {
  return callSupabaseRpc<OfflineNotification[]>(env, 'cfm_offline_notifications');
}

export function setSupabaseOfflineNotifications(env: SupabaseApiEnv, items: OfflineNotificationUpdate[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_set_offline_notifications', { input_items: items });
}

export function listSupabaseIpChangeNotifications(env: SupabaseApiEnv): Promise<IpChangeNotification[]> {
  return callSupabaseRpc<IpChangeNotification[]>(env, 'cfm_ip_change_notifications');
}

export function ipChangeNotificationEnabled(env: SupabaseApiEnv, uuid: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_ip_change_notification_enabled', { input_uuid: uuid });
}

export function setSupabaseIpChangeNotifications(env: SupabaseApiEnv, items: IpChangeNotification[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_set_ip_change_notifications', { input_items: items });
}

export function markSupabaseOfflineNotificationSent(env: SupabaseApiEnv, client: string, time: string | null, token: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_mark_offline_notification_sent', {
    input_client: client,
    input_time: time,
    input_token: token,
  });
}

export function recordSupabaseOfflineTransition(
  env: SupabaseApiEnv,
  client: string,
  transition: OfflineTransition,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_record_offline_transition', {
    input_client: client,
    input_phase: transition.phase,
    input_time: transition.time ?? null,
    input_since: transition.since ?? null,
    input_month_key: transition.monthKey ?? null,
    input_month_offline_ms: transition.monthOfflineMs ?? null,
    input_token: transition.token,
  });
}


export function listSupabaseExpiryNotifications(env: SupabaseApiEnv): Promise<ExpiryNotification[]> {
  return callSupabaseRpc<ExpiryNotification[]>(env, 'cfm_expiry_notifications');
}

export function setSupabaseExpiryNotifications(env: SupabaseApiEnv, items: ExpiryNotificationUpdate[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_set_expiry_notifications', { input_items: items });
}

export function markSupabaseExpiryNotificationSent(env: SupabaseApiEnv, client: string, time: string, token: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_mark_expiry_notification_sent', {
    input_client: client,
    input_time: time,
    input_token: token,
  });
}

export function markSupabaseLoadNotificationSent(
  env: SupabaseApiEnv, id: number, client: string, time: string, token: string,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_mark_load_notification_sent', {
    input_id: id, input_client: client, input_time: time, input_token: token,
  });
}

export function cleanupSupabaseNotificationDeliveryState(
  env: SupabaseApiEnv, now: string, options: NotificationDeliveryCleanupOptions = {},
): Promise<NotificationDeliveryCleanupResult> {
  return callSupabaseRpc<NotificationDeliveryCleanupResult>(env, 'cfm_cleanup_notification_delivery_state', {
    input_now: now, input_batch_size: options.batchSize, input_max_batches: options.maxBatches,
  });
}

export function listSupabaseLoadNotifications(env: SupabaseApiEnv): Promise<LoadNotification[]> {
  return callSupabaseRpc<LoadNotification[]>(env, 'cfm_load_notifications');
}

export function getSupabaseLoadNotification(env: SupabaseApiEnv, id: number): Promise<LoadNotification | null> {
  return callSupabaseRpc<LoadNotification | null>(env, 'cfm_load_notification', { input_id: id });
}

export async function getSupabaseLoadMetricWindowStatsForClients(
  env: SupabaseApiEnv,
  clients: string[],
  start: string,
  end: string,
  metric: LoadNotificationMetric,
  threshold: number,
): Promise<Map<string, LoadMetricWindowStats>> {
  const rows = await callSupabaseRpc<Array<LoadMetricWindowStats & { client: string }>>(
    env,
    'cfm_load_metric_window_stats',
    {
      input_clients: clients,
      input_start: start,
      input_end: end,
      input_metric: metric,
      input_threshold: threshold,
    },
  );
  return new Map(rows.map(row => [row.client, {
    samples: Number(row.samples || 0),
    exceeded: Number(row.exceeded || 0),
    avg_value: Number(row.avg_value || 0),
  }]));
}

export function updateSupabaseLoadNotification(env: SupabaseApiEnv, id: number, data: LoadNotificationInput): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_load_notification', {
    input_id: id,
    input_patch: data,
  });
}

export function createSupabaseLoadNotification(env: SupabaseApiEnv, data: LoadNotificationInput): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_create_load_notification', { input_item: data });
}

export function deleteSupabaseLoadNotification(env: SupabaseApiEnv, id: number): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_delete_load_notification', { input_id: id });
}

export function listSupabaseAuditLogsPaged(
  env: SupabaseApiEnv,
  page: number,
  limit: number,
  filter: AuditLogsFilter = {},
): Promise<AuditLogsPage> {
  return callSupabaseRpc<AuditLogsPage>(env, 'cfm_audit_logs_paged', {
    input_page: page,
    input_limit: limit,
    input_action: filter.action || null,
    input_search: filter.search || null,
  });
}

export function listSupabaseThemes(env: SupabaseApiEnv): Promise<Theme[]> {
  return callSupabaseRpc<Theme[]>(env, 'cfm_themes');
}

export function getSupabaseTheme(env: SupabaseApiEnv, short: string): Promise<Theme | null> {
  return callSupabaseRpc<Theme | null>(env, 'cfm_theme', { input_short: short });
}

export function upsertSupabaseTheme(
  env: SupabaseApiEnv,
  theme: ThemeUpsertInput,
  assets: ThemeAssetUpsertInput[],
): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_upsert_theme', {
    input_theme: theme,
    input_assets: assets,
  });
}

export function updateSupabaseThemeSettings(
  env: SupabaseApiEnv,
  short: string,
  configJson: string,
  customCss: string,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_theme_settings', {
    input_short: short,
    input_config_json: configJson,
    input_custom_css: customCss,
  });
}

export function deleteSupabaseTheme(env: SupabaseApiEnv, short: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_delete_theme', { input_short: short });
}

export function getSupabaseThemeAsset(env: SupabaseApiEnv, short: string, path: string): Promise<ThemeAsset | null> {
  return callSupabaseRpc<ThemeAsset | null>(env, 'cfm_theme_asset', {
    input_short: short,
    input_path: path,
  });
}

export function insertSupabaseMonitorRecord(env: SupabaseApiEnv, record: MonitorRecord): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_monitor_record', { input_record: record });
}

export function insertSupabasePingSnapshot(env: SupabaseApiEnv, client: string, time: string, results: PingSnapshotInput[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_ping_snapshot', {
    input_client: client,
    input_time: time,
    input_results: results,
  });
}

export function getSupabaseRecentRecords(env: SupabaseApiEnv, client: string, limit: number): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_recent_records', {
    input_client: client,
    input_limit: limit,
  });
}



export function getSupabaseLatestRecordTimesForClients(
  env: SupabaseApiEnv,
  clients: string[],
): Promise<Array<{ client: string; last_time: string }>> {
  return callSupabaseRpc<Array<{ client: string; last_time: string }>>(env, 'cfm_latest_record_times_for_clients', {
    input_clients: clients,
  });
}


export function getSupabaseRecordsByTimeRangeLimited(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  limit: number,
): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_records_range_limited', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_limit: limit,
  });
}

export function getSupabaseRecordsByTimeRangeBucketed(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  bucketSec: number,
  limit = 1000,
): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_records_range_bucketed', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_bucket_sec: bucketSec,
    input_limit: limit,
  });
}

/**
 * monitor 主题契约的 metrics：每个桶给整桶的均值、峰值与真实分钟数。
 * `sampleSec` 是记录落库间隔（record_persist_interval_sec），用来把样本数折成分钟。
 */
export function getSupabaseRecordsByTimeRangeAggregated(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  bucketSec: number,
  limit = 2000,
  sampleSec = 120,
): Promise<MonitorMetricsBucket[]> {
  return callSupabaseRpc<MonitorMetricsBucket[]>(env, 'cfm_records_range_aggregated', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_bucket_sec: bucketSec,
    input_limit: limit,
    input_sample_sec: sampleSec,
  });
}

export function getSupabaseRecordsByTimeRangeAggregatedRaw(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  bucketSec: number,
  limit = 2000,
  sampleSec = 120,
): Promise<MonitorMetricsBucket[]> {
  return callSupabaseRpc<MonitorMetricsBucket[]>(env, 'cfm_records_range_aggregated_raw', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_bucket_sec: bucketSec,
    input_limit: limit,
    input_sample_sec: sampleSec,
  });
}

/** monitor 主题契约的节点流量：批量取 day_* / total_*。 */
export function getSupabaseTrafficTotals(
  env: SupabaseApiEnv,
  clients: readonly string[],
): Promise<Record<string, MonitorTrafficTotals>> {
  return callSupabaseRpc<Record<string, MonitorTrafficTotals>>(env, 'cfm_traffic_totals', {
    input_clients: [...clients],
  });
}

export function getSupabaseRecordsByTimeRangePaged(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  page: number,
  limit: number,
): Promise<{ data: MonitorRecord[]; total: number; page: number; limit: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_records_range_paged', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_page: page,
    input_limit: limit,
  });
}

export function getSupabaseRecordsByTimeRangeCursor(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ data: MonitorRecord[]; total: number; page: number; limit: number; has_more: boolean; next_cursor?: string }> {
  return callSupabaseRpc(env, 'cfm_records_range_cursor', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_cursor: cursor,
    input_limit: limit,
  });
}

export function getSupabasePingRecords(env: SupabaseApiEnv, client: string, taskId: number, limit: number): Promise<PingHistoryRecord[]> {
  return callSupabaseRpc<PingHistoryRecord[]>(env, 'cfm_ping_records', {
    input_client: client,
    input_task_id: taskId,
    input_limit: limit,
  });
}

export function getSupabasePingRecordsPaged(
  env: SupabaseApiEnv,
  client: string,
  taskId: number,
  page: number,
  limit: number,
  start?: string,
  end?: string,
): Promise<{ data: PingHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_ping_records_paged', {
    input_client: client,
    input_task_id: taskId,
    input_page: page,
    input_limit: limit,
    input_start: start,
    input_end: end,
  });
}

export function getSupabasePingRecordsCursor(
  env: SupabaseApiEnv,
  client: string,
  taskId: number,
  cursor: string | undefined,
  limit: number,
  start?: string,
  end?: string,
): Promise<{ data: PingHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean; next_cursor?: string }> {
  return callSupabaseRpc(env, 'cfm_ping_records_cursor', {
    input_client: client,
    input_task_id: taskId,
    input_cursor: cursor,
    input_limit: limit,
    input_start: start,
    input_end: end,
  });
}

export function getSupabasePingRecordsForTasks(
  env: SupabaseApiEnv,
  client: string,
  tasks: number[] | PingTaskHistoryRequest[],
  limit: number,
  cursor?: string,
): Promise<Record<string, PingHistoryRecord[]>> {
  if (tasks.some(task => typeof task !== 'number')) {
    return getSupabasePingRecordsForTaskSpecs(env, client, tasks as PingTaskHistoryRequest[], limit, cursor);
  }
  const taskIds = tasks.map(task => typeof task === 'number' ? task : task.taskId);
  return callSupabaseRpc<Record<string, PingHistoryRecord[]>>(env, 'cfm_ping_records_for_tasks', {
    input_client: client,
    input_task_ids: taskIds,
    input_limit: limit,
    input_cursor: cursor,
  });
}

export function getSupabasePingRecordsForTasksRange(
  env: SupabaseApiEnv,
  client: string,
  taskIds: number[],
  start: string | undefined,
  end: string | undefined,
  limit: number,
): Promise<Record<string, PingHistoryRecord[]>> {
  return callSupabaseRpc<Record<string, PingHistoryRecord[]>>(env, 'cfm_ping_records_for_tasks_range', {
    input_client: client,
    input_task_ids: taskIds,
    input_start: start,
    input_end: end,
    input_limit: limit,
  });
}

export function getSupabasePingRecordsForTasksRangeBucketed(
  env: SupabaseApiEnv,
  client: string,
  taskIds: number[],
  start: string | undefined,
  end: string | undefined,
  bucketSec: number,
  limit = 1000,
): Promise<Record<string, PingHistoryRecord[]>> {
  return callSupabaseRpc(env, 'cfm_ping_records_for_tasks_range_bucketed', {
    input_client: client,
    input_task_ids: taskIds,
    input_start: start,
    input_end: end,
    input_bucket_sec: bucketSec,
    input_limit: limit,
  });
}

export function getSupabasePingRollupRange(
  env: SupabaseApiEnv,
  client: string,
  taskIds: number[],
  start: string | undefined,
  end: string | undefined,
  stepSec: number,
  limit = 1500,
): Promise<Record<string, PingHistoryRecord[]>> {
  return callSupabaseRpc(env, 'cfm_ping_rollup_range', {
    input_client: client,
    input_task_ids: taskIds,
    input_start: start,
    input_end: end,
    input_step_sec: stepSec,
    input_limit: limit,
  });
}

export function getSupabasePingStatsForTasksRange(
  env: SupabaseApiEnv,
  client: string,
  taskIds: number[],
  start: string | undefined,
  end: string | undefined,
): Promise<Record<string, PingTaskStats>> {
  return callSupabaseRpc<Record<string, PingTaskStats>>(env, 'cfm_ping_stats_for_tasks_range', {
    input_client: client,
    input_task_ids: taskIds,
    input_start: start,
    input_end: end,
  });
}

export function getSupabasePingStatsFromRollupRange(
  env: SupabaseApiEnv,
  client: string,
  taskIds: number[],
  start: string,
  end: string,
): Promise<Record<string, PingTaskStats>> {
  return callSupabaseRpc<Record<string, PingTaskStats>>(env, 'cfm_ping_stats_from_rollup', {
    input_client: client,
    input_task_ids: taskIds,
    input_start: start,
    input_end: end,
  });
}

export function getSupabaseHomePingAssignments(env: SupabaseApiEnv): Promise<Record<string, number>> {
  return callSupabaseRpc<Record<string, number>>(env, 'cfm_home_ping_assignments');
}

export function setSupabaseHomePingTask(
  env: SupabaseApiEnv,
  client: string,
  taskId: number | null,
): Promise<{ client: string; task_id: number | null }> {
  return callSupabaseRpc(env, 'cfm_set_home_ping_task', {
    input_client: client,
    input_task_id: taskId,
  });
}

/** Agent 上报的一次网卡读数样本（已由调用方校验、限幅）。 */
export interface TrafficSamplePayload {
  ts: number;
  boot: number;
  scope: string;
  utc_offset: number;
  interfaces: Record<string, { up: number; down: number }>;
}

/** 旧版 Agent 本地保存的一个日增量（升级迁移用）。 */
export interface TrafficImportDay {
  date: string;
  up: number;
  down: number;
}

export interface TrafficImportBaseline {
  scope: string;
  boot: number;
  interfaces: Record<string, { up: number; down: number }>;
}

/**
 * 处理一批网卡读数样本（换算增量、累加到当日、更新读数），并返回 [from, to]（YYYY-MM-DD，含两端）
 * 的流量合计，即当前计费周期的流量。samples 为空时只返回合计。
 */
export async function applySupabaseTrafficSamples(
  env: SupabaseApiEnv,
  client: string,
  samples: TrafficSamplePayload[],
  from: string,
  to: string,
): Promise<{ up: number; down: number; applied: number }> {
  const result = await callSupabaseRpc<{ up?: unknown; down?: unknown; applied?: unknown } | null>(env, 'cfm_traffic_apply_samples', {
    input_client: client,
    input_samples: samples,
    input_from: from,
    input_to: to,
  });
  const toCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return { up: toCount(result?.up), down: toCount(result?.down), applied: toCount(result?.applied) };
}

/** 一次性导入旧版 Agent 的本地流量历史；幂等。返回处理的日期数。 */
export async function importSupabaseTrafficHistory(
  env: SupabaseApiEnv,
  client: string,
  days: TrafficImportDay[],
  baseline: TrafficImportBaseline | null,
): Promise<number> {
  const result = await callSupabaseRpc<{ days?: unknown } | null>(env, 'cfm_traffic_import', {
    input_client: client,
    input_days: days,
    input_baseline: baseline,
  });
  return typeof result?.days === 'number' ? result.days : 0;
}

export function getSupabaseHomePingRows(
  env: SupabaseApiEnv,
  start: string,
  end: string,
  rowLimit = 400,
): Promise<Record<string, { task_id: number; name: string; rows: { time: string; value: number }[] }>> {
  return callSupabaseRpc(env, 'cfm_home_ping_rows', {
    input_start: start,
    input_end: end,
    input_row_limit: rowLimit,
  });
}


async function getSupabasePingRecordsForTaskSpecs(
  env: SupabaseApiEnv,
  client: string,
  tasks: PingTaskHistoryRequest[],
  fallbackLimit: number,
  cursor?: string,
): Promise<Record<string, PingHistoryRecord[]>> {
  const entries = await Promise.all(tasks.map(async (task) => {
    const taskLimit = Number.isInteger(task.limit) && task.limit && task.limit > 0
      ? Math.min(task.limit, 1000)
      : fallbackLimit;
    const records = cursor
      ? (await getSupabasePingRecordsCursor(env, client, task.taskId, cursor, taskLimit)).data
      : await getSupabasePingRecords(env, client, task.taskId, taskLimit);
    return [String(task.taskId), records] as const;
  }));
  return Object.fromEntries(entries);
}


export function getSupabaseHistoryStorageBytes(env: SupabaseApiEnv): Promise<HistoryTableByteSizes> {
  return callSupabaseRpc<HistoryTableByteSizes>(env, 'cfm_history_storage_bytes');
}

export function getSupabaseHistoryMaintenanceStatus(env: SupabaseApiEnv): Promise<HistoryMaintenanceStatus> {
  return callSupabaseRpc<HistoryMaintenanceStatus>(env, 'cfm_history_maintenance_status');
}



export function getSupabasePublicPingTasks(
  env: SupabaseApiEnv,
  fetcher: typeof fetch = fetch,
  options: SupabaseRpcOptions = {},
): Promise<PingTask[]> {
  return callSupabaseRpc<PingTask[]>(env, 'cfm_public_ping_tasks', {}, fetcher, options).then(normalizePingTaskList);
}

export function getSupabasePingTaskClientTimeouts(env: SupabaseApiEnv): Promise<PingTaskClientTimeout[]> {
  return callSupabaseRpc<PingTaskClientTimeout[]>(env, 'cfm_ping_task_client_timeouts', {});
}

export async function setSupabaseClientPingAssignment(
  env: SupabaseApiEnv, client: string, desired: number[], base: number[],
  timeouts: Array<{ taskId: number; timeoutMs: number | null }>,
): Promise<ClientPingAssignmentResult> {
  const result = await callSupabaseRpc<ClientPingAssignmentResult>(env, 'cfm_set_client_ping_assignment', {
    input_client: client, input_desired: desired, input_base: base,
    input_timeouts: timeouts.map(row => ({ task_id: row.taskId, timeout_ms: row.timeoutMs })),
  });
  return result.ok ? { ...result, tasks: normalizePingTaskList(result.tasks) } : result;
}

export function setSupabasePingTaskClientTimeout(
  env: SupabaseApiEnv,
  taskId: number,
  client: string,
  timeoutMs: number | null,
): Promise<PingTaskClientTimeout | null> {
  return callSupabaseRpc<PingTaskClientTimeout | null>(env, 'cfm_set_ping_task_client_timeout', {
    input_task_id: taskId,
    input_client: client,
    input_timeout_ms: timeoutMs,
  });
}

export function getSupabaseLoginUser(env: SupabaseApiEnv, username: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_login_user', { input_username: username });
}

export function countSupabaseUsers(env: SupabaseApiEnv): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_users_count');
}



export function createSupabaseInitialAdmin(
  env: SupabaseApiEnv,
  uuid: string,
  username: string,
  passwordHash: string,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_create_initial_admin', {
    p_uuid: uuid,
    p_username: username,
    p_password_hash: passwordHash,
  });
}

export function recoverSupabaseSingleAdmin(
  env: SupabaseApiEnv,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<User> {
  return callSupabaseRpc<User>(env, 'cfm_recover_single_admin', {
    input_uuid: user.uuid,
    input_username: user.username,
    input_passwd: user.hashedPassword,
  });
}

export function getSupabaseUserByUuid(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_user_by_uuid', { input_uuid: uuid });
}

export function enableSupabaseUserTotp(
  env: SupabaseApiEnv,
  uuid: string,
  secretEnc: string,
  recoveryCodeHashes: string[],
  usedStep: number,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_enable_user_totp', {
    input_uuid: uuid,
    input_secret_enc: secretEnc,
    input_recovery_code_hashes: recoveryCodeHashes,
    input_used_step: usedStep,
  });
}

export function disableSupabaseUserTotp(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_disable_user_totp', { input_uuid: uuid });
}

export function replaceSupabaseUserRecoveryCodes(
  env: SupabaseApiEnv,
  uuid: string,
  recoveryCodeHashes: string[],
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_replace_user_recovery_codes', {
    input_uuid: uuid,
    input_recovery_code_hashes: recoveryCodeHashes,
  });
}

export function consumeSupabaseTotpStep(env: SupabaseApiEnv, uuid: string, step: number): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_consume_totp_step', {
    input_uuid: uuid,
    input_step: step,
  });
}

export function consumeSupabaseRecoveryCode(env: SupabaseApiEnv, uuid: string, codeHash: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_consume_recovery_code', {
    input_uuid: uuid,
    input_code_hash: codeHash,
  });
}


export function updateSupabaseUserUsernameAndRotateSession(
  env: SupabaseApiEnv,
  uuid: string,
  username: string,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_update_user_username_rotate_session', {
    input_uuid: uuid,
    input_username: username,
  });
}

export function updateSupabaseUserPassword(env: SupabaseApiEnv, uuid: string, hashedPassword: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_update_user_password', {
    input_uuid: uuid,
    input_passwd: hashedPassword,
  });
}

export function updateSupabaseUserPasswordAndRotateSession(
  env: SupabaseApiEnv,
  uuid: string,
  hashedPassword: string,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_update_user_password_rotate_session', {
    input_uuid: uuid,
    input_passwd: hashedPassword,
  });
}

export function rotateSupabaseUserSession(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_rotate_user_session', {
    input_uuid: uuid,
  });
}

export function validateSupabaseAdminSession(
  env: SupabaseApiEnv,
  userId: string,
  sessionVersion: number,
): Promise<Pick<User, 'uuid' | 'username' | 'session_version'> | null> {
  return callSupabaseRpc<Pick<User, 'uuid' | 'username' | 'session_version'> | null>(
    env,
    'cfm_validate_admin_session',
    { user_uuid: userId, expected_session_version: sessionVersion },
  );
}



export function getSupabaseLoginRateLimitsByBuckets(env: SupabaseApiEnv, buckets: string[]): Promise<LoginRateLimit[]> {
  return callSupabaseRpc<LoginRateLimit[]>(env, 'cfm_login_rate_limits', { input_buckets: buckets });
}

export function recordSupabaseLoginFailures(env: SupabaseApiEnv, buckets: string[], failedAt: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_record_login_failures', { input_buckets: buckets, input_failed_at: failedAt });
}

export function clearSupabaseObservedLoginFailures(env: SupabaseApiEnv, states: LoginRateLimit[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_clear_observed_login_failures', { input_states: states });
}





export function deleteSupabaseLoginRateLimitsBefore(env: SupabaseApiEnv, beforeTime: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_delete_login_rate_limits_before', { input_before_time: beforeTime });
}

export function insertSupabaseAuditLog(
  env: SupabaseApiEnv,
  user: string,
  action: string,
  detail: string,
  level = 'info',
): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_audit_log', {
    input_user: user,
    input_action: action,
    input_detail: detail,
    input_level: level,
  });
}

export function trySupabaseClaimAuditThrottle(
  env: SupabaseApiEnv,
  key: string,
  now: string,
  throttleMs: number,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_try_claim_audit_throttle', {
    input_key: key,
    input_now: now,
    input_throttle_ms: throttleMs,
  });
}
