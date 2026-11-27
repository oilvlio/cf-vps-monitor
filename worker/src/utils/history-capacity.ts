import type { HistoryStorageUsage } from '../db/types.ts';

export function evaluateHistoryCapacity(
  usage: Pick<HistoryStorageUsage, 'allocated_bytes'>,
  options: { byteLimit: number; wasBlocked?: boolean },
): { blocked: boolean; byteRatio: number; allocatedWarning: boolean } {
  const byteRatio = usage.allocated_bytes / options.byteLimit;
  const ratio = byteRatio;
  return {
    blocked: !Number.isFinite(ratio) || (options.wasBlocked ? ratio > 0.8 : ratio >= 1),
    byteRatio,
    allocatedWarning: usage.allocated_bytes >= options.byteLimit,
  };
}
