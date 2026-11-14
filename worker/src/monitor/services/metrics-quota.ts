/**
 * /api/nodes/:id/metrics 的限流额度：按最近一次公开快照的节点数放大（换算见
 * monitorMetricsRateLimit）。主题会按节点扇出历史请求，节点越多需要的额度越高。
 *
 * 两条路由（/nodes 与 /metrics）各自用最新快照校准它；原来是一个模块级 let，
 * 这里收进一个小对象：非法值忽略、可独立实例化，测试可以 reset 回冷启动状态
 * （按 0 走下限额度）。
 */
import { monitorMetricsRateLimit } from '../contract';

export class MonitorMetricsQuota {
  private nodeCount = 0;

  /** 用最近一次快照的节点数校准额度；非法值忽略，保留上一次的校准结果。 */
  update(nodeCount: number): void {
    if (Number.isInteger(nodeCount) && nodeCount >= 0) this.nodeCount = nodeCount;
  }

  limit(): number {
    return monitorMetricsRateLimit(this.nodeCount);
  }

  /** 测试用：回到冷启动状态。 */
  reset(): void {
    this.nodeCount = 0;
  }
}
