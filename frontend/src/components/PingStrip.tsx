import { Timer, PackageX } from 'lucide-react';
import {
  formatHomeLatency,
  formatHomeLoss,
  latencyLevel,
  lossLevel,
  type HomePingNode,
} from '../utils/homePing';

function formatBucketTime(t: number): string {
  if (!t) return '';
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function bucketLabel(bucketSec: number): string {
  return bucketSec >= 3600 && bucketSec % 3600 === 0 ? `${bucketSec / 3600} 小时` : `${Math.round(bucketSec / 60)} 分钟`;
}

export default function PingStrip({ data, bucketSec = 300 }: { data: HomePingNode; bucketSec?: number }) {
  const latencyValue = data.latency_ms ?? data.latency_avg_ms;
  const headLatencyLevel = latencyLevel(data.latency_ms, data.loss_percent);
  const headLossLevel = lossLevel(data.loss_percent);
  const hint = `探测点：${data.task_name || `#${data.task_id}`} · 每格 ${bucketLabel(bucketSec)}`;
  const latencyTimedOut = data.latency_ms === null && data.loss_percent !== null && data.loss_percent > 0;

  return (
    <div className="node-ping-strip" data-monitor-role="ping-strip" title={hint}>
      <div className="node-ping-row" data-kind="latency">
        <span className="node-ping-head">
          <span className="node-ping-label"><Timer size={14} />延迟</span>
          <span className="node-ping-value" data-level={headLatencyLevel}>
            {latencyTimedOut ? '超时' : formatHomeLatency(latencyValue)}
            {!latencyTimedOut && latencyValue !== null && <small>ms</small>}
          </span>
        </span>
        <span className="node-ping-blocks" aria-hidden="true">
          {data.points.map((point) => (
            <i
              key={point.t}
              className="node-ping-block"
              data-level={latencyLevel(point.latency_ms, point.loss_percent)}
              title={`${formatBucketTime(point.t)} ${point.latency_ms === null ? (point.loss_percent === null ? '无数据' : '超时') : `${point.latency_ms} ms`}`}
            />
          ))}
        </span>
      </div>
      <div className="node-ping-row" data-kind="loss">
        <span className="node-ping-head">
          <span className="node-ping-label"><PackageX size={14} />丢包</span>
          <span className="node-ping-value" data-level={headLossLevel}>
            {formatHomeLoss(data.loss_percent)}<small>%</small>
          </span>
        </span>
        <span className="node-ping-blocks" aria-hidden="true">
          {data.points.map((point) => (
            <i
              key={point.t}
              className="node-ping-block"
              data-level={lossLevel(point.loss_percent)}
              title={`${formatBucketTime(point.t)} ${point.loss_percent === null ? '无数据' : `丢包 ${formatHomeLoss(point.loss_percent)}%`}`}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
