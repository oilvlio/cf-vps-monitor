/**
 * Supabase RPC 调用的超时与重试策略。
 *
 * 普通请求没有 ScheduledBudget，scheduledFetch() 之前会直接透传给 fetch，
 * 于是挂死的 RPC 会一直占住 Worker 请求。这里给每次尝试一个默认上限，并把
 * 调用方的 AbortSignal 透传下去。
 *
 * 读 RPC 是幂等的：超时、网络错误和 429/5xx 可以安全重试一次。写 RPC 不重试，
 * 因为请求可能已经在服务端提交，只是响应丢失；重放会重复插入/重复扣减。
 * 新写接口只要沿用这些动词前缀就会自动落在不重试的一侧。
 */

export type SupabaseRpcMode = 'read' | 'write';

/** 单次 RPC 尝试的默认超时；调用方可用 options.timeoutMs 覆盖。 */
export const DEFAULT_SUPABASE_RPC_TIMEOUT_MS = 10_000;

/** 历史维护、汇总构建等批处理允许更长的单次尝试。 */
export const LONG_RUNNING_SUPABASE_RPC_TIMEOUT_MS = 25_000;

/** 读 RPC 最多尝试两次（一次原试 + 一次重试）。 */
export const SUPABASE_RPC_READ_ATTEMPTS = 2;

/** 两次读尝试之间的基础退避，第二次尝试翻倍。 */
export const SUPABASE_RPC_RETRY_BASE_DELAY_MS = 150;

// 这些 RPC 会写库，响应丢失时不能盲目重放。
const WRITE_RPC_NAMES = new Set([
  'cfm_traffic_apply_samples',
  'cfm_traffic_import',
]);

const WRITE_RPC_PREFIXES = [
  'cfm_build_',
  'cfm_claim_',
  'cfm_cleanup_',
  'cfm_clear_',
  'cfm_complete_',
  'cfm_consume_',
  'cfm_create_',
  'cfm_delete_',
  'cfm_disable_',
  'cfm_enable_',
  'cfm_insert_',
  'cfm_mark_',
  'cfm_partition_',
  'cfm_prune_',
  'cfm_record_',
  'cfm_recover_',
  'cfm_reorder_',
  'cfm_replace_',
  'cfm_rotate_',
  'cfm_set_',
  'cfm_try_claim_',
  'cfm_update_',
  'cfm_upsert_',
] as const;

/** 未识别的 RPC 按读处理；写接口应使用上面的动词命名。 */
export function supabaseRpcMode(functionName: string): SupabaseRpcMode {
  if (WRITE_RPC_NAMES.has(functionName)) return 'write';
  return WRITE_RPC_PREFIXES.some(prefix => functionName.startsWith(prefix)) ? 'write' : 'read';
}

// 这些状态说明请求没有被正常处理，且读 RPC 重试不会改变结果。
// 408/425/429 是临时性节流；5xx/52x 是上游或 Cloudflare 的瞬时故障。
const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function isRetryableReadStatus(status: number): boolean {
  return RETRYABLE_READ_STATUSES.has(status);
}