/**
 * 历史查询的分桶口径：详情页路由与 Monitor 契约共用同一份定义，
 * 免得两处各写一套步长，档位之间对不齐。
 */

// 原始点的上限：12h 内按 60s 最小落库间隔最多 720 点，SVG 直接画完全没有压力。
// 前端的区间是 start/end 两次独立取 Date 得到的，会比名义区间多出几毫秒，
// 所以边界留 10 分钟余量，免得 12h 档被偶然判成分桶请求。
export const RAW_HISTORY_MAX_RANGE_MS = 12 * 60 * 60 * 1000 + 10 * 60 * 1000;

/**
 * <=12h 读原始（12h × 60s = 720 点）；更长的窗口分桶，目标约 720 点/档（1600px 宽约 2px 一个点）：
 * 12h~3.5d → 360s 桶（3d = 720 桶，1d = 240 桶）；>3.5d → 840s 桶（7d = 720 桶）。
 *
 * 步长取 120s 的整数倍（6min / 14min），60s 和 120s 的探测间隔都整除，每桶样本数恒定
 * （60s 探测下 6 / 14 个，120s 探测下 3 / 7 个）。每桶至少 3 个样本，中位数才压得住孤立的
 * 尖峰；步长等于探测间隔时桶边界会和采样时刻错位（桶里时有 0 个、时有 2 个），所以短窗口不分桶。
 */
export function historyBucketSec(rangeMs: number): number | null {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (rangeMs > 3.5 * day) return 840;
  if (rangeMs > RAW_HISTORY_MAX_RANGE_MS) return 360;
  return null;
}
