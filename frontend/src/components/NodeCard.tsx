import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Card, Flex, Text, Tooltip } from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, PackageX, Timer } from 'lucide-react';
import Flag from './Flag';
import PriceTags from './PriceTags';
import type { HomePingNode } from '../utils/homePing';
import { formatHomeLatency, formatHomeLoss, latencyLevel, lossLevel } from '../utils/homePing';
import { diskUsagePresentation, formatLastReport, formatLoadValue, formatMetricBytes, formatMetricSpeed, formatMetricUptime, metricNumber, resourceUsage, type NodeStatus } from '../utils/nodeMetrics';
import { formatTrafficLimitLabel, parseTrafficLimitType } from '../utils/traffic';
import { ClientInfo, LiveRecord } from '../types';
import { getOSDisplay } from '../utils/osIcon';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatCpuSpec } from '../utils/cpuFormat';
import { parseMonitorTags } from '../utils/tags';
import { getExpiryInfo } from '../utils/billing';

interface NodeCardProps {
  client: ClientInfo;
  live?: Partial<LiveRecord>;
  online: boolean;
  status?: NodeStatus;
  lastReportTime?: number;
  /** 首页探测点的分桶结果；节点没设置首页探测点时为空，不渲染色块 */
  homePing?: HomePingNode;
  homePingBucketSec?: number;
}

function NodeRegionTagsLine({ region, tags }: { region?: string; tags?: string }) {
  const tagTexts = parseMonitorTags(tags).map((tag) => tag.text);
  const regionLabel = region || '未知';
  const tooltipContent = (
    <span className="node-card-tag-tooltip-content">
      <span className="node-card-tag-tooltip-region">{regionLabel}</span>
      <span className="node-card-tag-tooltip-tags">
        {tagTexts.map((tag, index) => (
          <span className="node-card-tag-tooltip-pill" key={`${tag}-${index}`}>{tag}</span>
        ))}
      </span>
    </span>
  );
  const line = (
    <div className="node-card-region-line node-card-region-tags-line lp-sub-region">
      <span className="node-card-region-text">{regionLabel}</span>
      {tagTexts.length > 0 && (
        <span className="node-card-header-tags lp-sub-tags" aria-label={`标签 ${tagTexts.join(' ')}`}>
          {tagTexts.map((tag, index) => (
            <span className="node-card-header-tag lp-sub-tag" key={`${tag}-${index}`}>{tag}</span>
          ))}
        </span>
      )}
    </div>
  );

  return tagTexts.length > 0 ? (
    <Tooltip className="node-card-tag-tooltip" content={tooltipContent} side="bottom">
      {line}
    </Tooltip>
  ) : line;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function getUsageLevel(percent: number) {
  if (percent >= 85) return 'hot';
  if (percent >= 65) return 'warm';
  return 'normal';
}

function formatPercent(value: number | null) {
  if (value === null) return '—';
  const clamped = clampPercent(value);
  return `${clamped.toFixed(clamped < 10 ? 1 : 0)}%`;
}

const LP_DOT_COUNT = 20;

function LpDotBar({ percent, level }: { percent: number | null; level: string }) {
  const lit = percent === null ? 0 : Math.round((clampPercent(percent) / 100) * LP_DOT_COUNT);
  return (
    <span className="lp-dots" data-level={level} aria-hidden="true">
      {Array.from({ length: LP_DOT_COUNT }, (_, i) => (
        <i key={i} className="lp-dot" data-lit={i < lit ? 'true' : 'false'} />
      ))}
    </span>
  );
}

function LpMetric({
  icon,
  label,
  value,
  title,
  percent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
  percent: number | null;
}) {
  const level = percent === null ? 'none' : getUsageLevel(clampPercent(percent));
  return (
    <div className="lp-metric" data-load={level} title={title}>
      <div className="lp-metric-head">
        <span className="lp-metric-label">{icon}{label}</span>
        <span className="lp-metric-value" data-load={level}>{value}</span>
      </div>
      <LpDotBar percent={percent} level={level} />
    </div>
  );
}

function formatBucketTime(t: number): string {
  if (!t) return '';
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 首页探测点两行点阵：延迟一行、丢包一行（与原 PingStrip 同口径）。 */
function LpPingRows({ data, bucketSec = 300 }: { data: HomePingNode; bucketSec?: number }) {
  const headLatency = data.latency_ms ?? data.latency_avg_ms;
  const headLatencyLevel = latencyLevel(data.latency_ms, data.loss_percent);
  const headLossLevel = lossLevel(data.loss_percent);
  const timedOut = data.latency_ms === null && data.loss_percent !== null && data.loss_percent > 0;
  const bucketLabel = bucketSec >= 3600 && bucketSec % 3600 === 0 ? `${bucketSec / 3600} 小时` : `${Math.round(bucketSec / 60)} 分钟`;
  const hint = `探测点：${data.task_name || `#${data.task_id}`} · 每格 ${bucketLabel}`;
  return (
    <div className="lp-ping" title={hint} data-monitor-role="ping-strip">
      <div className="lp-ping-row" data-kind="latency">
        <div className="lp-ping-head">
          <span className="lp-ping-label"><Timer size={13} />延迟</span>
          <span className="lp-ping-value" data-level={headLatencyLevel}>
            {timedOut ? '超时' : formatHomeLatency(headLatency)}
            {!timedOut && headLatency !== null && <small>ms</small>}
          </span>
        </div>
        <span className="lp-ping-dots" aria-hidden="true">
          {data.points.map((point) => (
            <i
              key={point.t}
              className="lp-ping-dot"
              data-level={point.latency_ms === null && point.loss_percent === null ? 'none' : latencyLevel(point.latency_ms, point.loss_percent)}
              title={`${formatBucketTime(point.t)} ${point.latency_ms === null ? (point.loss_percent === null ? '无数据' : '超时') : `${point.latency_ms} ms`}`}
            />
          ))}
        </span>
      </div>
      <div className="lp-ping-row" data-kind="loss">
        <div className="lp-ping-head">
          <span className="lp-ping-label"><PackageX size={13} />丢包</span>
          <span className="lp-ping-value" data-level={headLossLevel}>
            {formatHomeLoss(data.loss_percent)}<small>%</small>
          </span>
        </div>
        <span className="lp-ping-dots" aria-hidden="true">
          {data.points.map((point) => (
            <i
              key={point.t}
              className="lp-ping-dot"
              data-level={point.loss_percent === null ? 'none' : lossLevel(point.loss_percent)}
              title={`${formatBucketTime(point.t)} ${point.loss_percent === null ? '无数据' : `丢包 ${formatHomeLoss(point.loss_percent)}%`}`}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function NodeIpBadges({ client, className }: { client: ClientInfo; className?: string }) {
  const hasIpv4 = Boolean(client.has_ipv4 || client.ipv4);
  const hasIpv6 = Boolean(client.has_ipv6 || client.ipv6);
  if (!hasIpv4 && !hasIpv6) return null;

  return (
    <Flex className={['node-ip-family-badges', className].filter(Boolean).join(' ')} align="center" gap="1" wrap="nowrap">
      {hasIpv4 && <Badge size="1" variant="soft" color="gray">IPv4</Badge>}
      {hasIpv6 && <Badge size="1" variant="soft" color="gray">IPv6</Badge>}
    </Flex>
  );
}

export default function NodeCard({ client, live, online, status, lastReportTime, homePing, homePingBucketSec }: NodeCardProps) {
  const isMobile = useIsMobile();
  const defaultLive: Partial<LiveRecord> = {
    temp: null,
  };
  const d = live || defaultLive;
  const nodeStatus = status ?? (online ? 'online' : 'offline');
  const cpuPct = metricNumber(d.cpu);
  const memory = resourceUsage(d.ram, d.ram_total, client.mem_total);
  const disk = diskUsagePresentation(d, client.disk_total);
  const load1 = metricNumber(d.load);
  // 负载不是百分比：点阵按单核折算（load1 / 核心数）着色，数值只显示实时值 load1。
  // 不可用（null）时点阵全暗、数值为破折号。
  const loadPct = load1 !== null && client.cpu_cores > 0 ? Math.min(100, (load1 / client.cpu_cores) * 100) : null;
  const loadTitle = `实时负载 ${formatLoadValue(load1)}`;
  const memPct = memory.percent;
  const diskPct = disk.percent;
  const totalUp = metricNumber(d.net_total_up);
  const totalDown = metricNumber(d.net_total_down);
  const uploadSpeed = formatMetricSpeed(d.net_out);
  const downloadSpeed = formatMetricSpeed(d.net_in);
  const osConfig = getOSDisplay(client.os || '');
  const trafficLimitLabel = formatTrafficLimitLabel(client.traffic_limit, client.traffic_limit_type);
  const uptimeLabel = formatMetricUptime(d.uptime);
  const cpuTitle = formatCpuSpec(client.cpu_name, client.cpu_cores);

  const trafficUsed = (() => {
    if (!client.traffic_limit || client.traffic_limit <= 0) return 0;
    const type = parseTrafficLimitType(client.traffic_limit_type);
    switch (type) {
      case 'max': return totalUp === null || totalDown === null ? null : Math.max(totalUp, totalDown);
      case 'min': return totalUp === null || totalDown === null ? null : Math.min(totalUp, totalDown);
      case 'up': return totalUp;
      case 'down': return totalDown;
      case 'sum':
      default: return totalUp === null || totalDown === null ? null : totalUp + totalDown;
    }
  })();
  const trafficPct = client.traffic_limit > 0 && trafficUsed !== null ? Math.min(100, (trafficUsed / client.traffic_limit) * 100) : undefined;
  const quotaLit = trafficPct === undefined ? 0 : (trafficUsed !== null && trafficUsed > 0 ? Math.max(1, Math.round((trafficPct / 100) * LP_DOT_COUNT)) : 0);
  const hasBillingInfo = (client.price !== undefined && client.price !== 0) || Boolean(getExpiryInfo(client.expired_at).label);

  return (
    <Card
      className="node-card lp-card"
      data-status={nodeStatus}
      style={{ width: '100%', margin: '0 auto', opacity: online ? 1 : 0.75 }}
      id={client.uuid}
    >
      <Link className="node-card-link lp-link" to={`/instance/${client.uuid}`} style={{ textDecoration: 'none', color: 'inherit' }}>
        <Flex className="node-card-body lp-body" direction="column" gap="2">
          <Flex className="node-card-header lp-head" justify="between" align="start" my={isMobile ? '-1' : '0'} data-has-message={d.message ? 'true' : undefined}>
            <Flex justify="start" align="center" style={{ flex: 1, minWidth: 0 }}>
              <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                <Flex className="node-card-title-row lp-title-row" align="center" gap="2">
                  <span
                    className="node-card-corner-flag"
                    data-monitor-role="node-region-flag"
                    role="img"
                    aria-label={`服务器归属地 ${client.region || '未知'}`}
                  >
                    <Flag region={client.region} size={isMobile ? 18 : 20} />
                  </span>
                  <Text weight="bold" size={isMobile ? '2' : '4'} truncate className="lp-name" style={{ maxWidth: '100%' }}>
                    {client.name}
                  </Text>
                </Flex>
                <NodeRegionTagsLine region={client.region} tags={client.tags} />
              </Flex>
            </Flex>

            <Flex className="node-card-status-row lp-status-row" gap="2" align="center" style={{ flex: 'none' }}>
              {d.message && (
                <Box
                  style={{
                    width: 20, height: 20, borderRadius: '50%',
                    background: 'var(--red-9)', color: 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 'bold', cursor: 'help', flexShrink: 0,
                  }}
                  title={d.message}
                >!</Box>
              )}
              <Badge color={nodeStatus === 'online' ? 'green' : nodeStatus === 'offline' ? 'red' : 'gray'} variant="solid" radius="full">
                {nodeStatus === 'online' ? '在线' : nodeStatus === 'offline' ? '离线' : '确认中'}
              </Badge>
            </Flex>
          </Flex>
          {nodeStatus === 'offline' && <Text size="1" color="gray" className="lp-offline-note">最后上报 {formatLastReport(lastReportTime)}{!live && ' · 暂无上报数据'}</Text>}
          <Flex className="node-card-title-meta lp-sub" align="center" gap="2">
            <span className="node-os-chip lp-os-chip">
              <img src={osConfig.image} alt="" aria-hidden="true" />
              {osConfig.name}
            </span>
            <span className="node-card-billing-row" aria-hidden={!hasBillingInfo}>
              <PriceTags
                price={client.price}
                billing_cycle={client.billing_cycle}
                currency={client.currency}
                expired_at={client.expired_at}
                showTags={false}
                showExpiry
              />
            </span>
            <NodeIpBadges client={client} className="node-card-title-ip-badges" />
          </Flex>

          <Flex direction="column" gap="2" className="lp-stack">
            <div className="lp-grid" data-cols="2">
              <LpMetric icon={<Cpu size={13} />} label="CPU" value={formatPercent(cpuPct)} title={cpuTitle} percent={cpuPct} />
              <LpMetric icon={<MemoryStick size={13} />} label="内存" value={formatPercent(memPct)} percent={memPct} />
            </div>
            <div className="lp-grid" data-cols="2">
              <LpMetric icon={<HardDrive size={13} />} label={disk.estimated ? '磁盘·估' : '磁盘'} value={`${disk.estimated && diskPct !== null ? '≈ ' : ''}${formatPercent(diskPct)}`} title={disk.estimated ? `${disk.description} ${disk.sampleLabel}` : undefined} percent={diskPct} />
              <LpMetric icon={<Activity size={13} />} label="负载" value={formatLoadValue(load1)} title={loadTitle} percent={loadPct} />
            </div>

            <div className="lp-net">
              <div className="lp-net-col">
                <div className="lp-net-head"><span className="lp-net-dir">实时速率</span></div>
                <div className="lp-net-foot"><span className="lp-net-dir is-up"><ArrowUp size={13} />上行</span><span>{uploadSpeed}</span></div>
                <div className="lp-net-foot"><span className="lp-net-dir is-down"><ArrowDown size={13} />下行</span><span>{downloadSpeed}</span></div>
              </div>
              <div className="lp-net-col">
                <div className="lp-net-head"><span className="lp-net-dir">累计流量</span></div>
                <div className="lp-net-foot"><span className="lp-net-dir is-up"><ArrowUp size={13} />上行</span><span>{formatMetricBytes(totalUp)}</span></div>
                <div className="lp-net-foot"><span className="lp-net-dir is-down"><ArrowDown size={13} />下行</span><span>{formatMetricBytes(totalDown)}</span></div>
              </div>
            </div>

            <div className="lp-quota" title={trafficLimitLabel || '月度流量'}>
              <div className="lp-quota-head">
                <span className="lp-quota-label">在线时长 {nodeStatus === 'offline' ? '(上报时) ' : ''}{uptimeLabel}</span>
                <span className="lp-quota-usage">
                  {client.traffic_limit > 0
                    ? `${formatMetricBytes(trafficUsed)} / ${formatMetricBytes(client.traffic_limit)}`
                    : trafficLimitLabel || '流量未限'}
                </span>
              </div>
              <div className="lp-quota-track" aria-hidden="true">
                {Array.from({ length: LP_DOT_COUNT }, (_, i) => (
                  <span key={i} className="lp-quota-seg" data-lit={trafficLimitLabel ? (i < quotaLit ? 'true' : 'false') : undefined} data-pos={i} />
                ))}
              </div>
            </div>

            {homePing && <LpPingRows data={homePing} bucketSec={homePingBucketSec} />}
          </Flex>
        </Flex>
      </Link>
    </Card>
  );
}
