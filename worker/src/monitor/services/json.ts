/** monitor 投影层的共享小工具（纯函数）。 */

/** 把任意值收窄成 JSON 对象；其余一律返回 null。 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
