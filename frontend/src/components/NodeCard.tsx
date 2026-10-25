import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Card, Flex, Text, Tooltip } from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Timer } from 'lucide-react';
import Flag from './Flag';
import PriceTags from './PriceTags';
import type { HomePingNode } from '../utils/homePing';
import { DEFAULT_HOME_PING_SAMPLE_COUNT, homePingHead, homePingSlots, latencyLevel } from '../utils/homePing';
import { diskUsagePresentation, formatLastReport, formatLoadValue, formatMetricBytes, formatMetricSpeed, formatMetricUptimeCn, metricNumber, resourceUsage, type NodeStatus } from '../utils/nodeMetrics';
import { formatTrafficLimitLabel, parseTrafficLimitType } from '../utils/traffic';
import { ClientInfo, LiveRecord } from '../types';
import { getOSDisplay } from '../utils/osIcon';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatCpuSpec } from '../utils/cpuFormat';
import { parseMonitorTags } from '../utils/tags';
import { getExpiryInfo, getExpiryRemaining } from '../utils/billing';

interface NodeCardProps {
  client: ClientInfo;
  live?: Partial<LiveRecord>;
  online: boolean;
  status?: NodeStatus;
  lastReportTime?: number;
  /** 首页探测点最新的 N 次原始采样；节点没设置首页探测点时为空，不渲染色块 */
  homePing?: HomePingNode;
  /** 色块总格数（= 后端返回的采样数上限） */
  homePingSampleCount?: number;
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

// 连续细条：纯色填充，颜色只随档位（正常 / 偏高 / 过高）切换，不做渐变。
function LpBar({ percent, level }: { percent: number | null; level: string }) {
  const width = percent === null ? 0 : clampPercent(percent);
  // 有用量但很小时保留一点可见宽度，免得条看起来是空的。
  const shown = width > 0 ? Math.max(width, 1.5) : 0;
  return (
    <span className="lp-bar" data-level={level} aria-hidden="true">
      <i className="lp-bar-fill" style={{ width: `${shown}%` }} />
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
      <LpBar percent={percent} level={level} />
    </div>
  );
}

function formatSampleTime(t: number): string {
  if (!t) return '';
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 首页探测点延迟色块：每格一次原始采样（不聚合），最右是最新；数字是最新一格的数值。 */
function LpPingRows({ data, sampleCount = DEFAULT_HOME_PING_SAMPLE_COUNT }: { data: HomePingNode; sampleCount?: number }) {
  const head = homePingHead(data.points);
  const slots = homePingSlots(data.points, sampleCount);
  const hint = `探测点：${data.task_name || `#${data.task_id}`} · 每格一次采样，最近 ${data.points.length} 次`;
  return (
    <div className="lp-ping" title={hint} data-monitor-role="ping-strip">
      <div className="lp-ping-row" data-kind="latency">
        <div className="lp-ping-head">
          <span className="lp-ping-label"><Timer size={14} />延迟</span>
          <span className="lp-ping-value" data-level={head.level}>
            {head.text}
            {head.showUnit && <small>ms</small>}
          </span>
        </div>
        <span className="lp-ping-dots" aria-hidden="true">
          {slots.map((point, index) => (
            point === null
              ? <i key={`empty-${index}`} className="lp-ping-dot" data-level="none" />
              : (
                <i
                  key={`${point.t}-${index}`}
                  className="lp-ping-dot"
                  data-level={latencyLevel(point.latency_ms)}
                  title={`${formatSampleTime(point.t)} ${point.latency_ms === null ? '超时' : `${point.latency_ms} ms`}`}
                />
              )
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

export default function NodeCard({ client, live, online, status, lastReportTime, homePing, homePingSampleCount }: NodeCardProps) {
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
  const uptimeLabel = `${nodeStatus === 'offline' ? '上报时' : ''}在线${formatMetricUptimeCn(d.uptime)}`;
  const expiry = getExpiryRemaining(client.expired_at);
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
  const quotaLevel = trafficPct === undefined ? 'none' : getUsageLevel(trafficPct);
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
                showExpiry={false}
              />
            </span>
            <NodeIpBadges client={client} className="node-card-title-ip-badges" />
          </Flex>

          <Flex direction="column" gap="2" className="lp-stack">
            <div className="lp-grid" data-cols="2">
              <LpMetric icon={<Cpu size={14} />} label="CPU" value={formatPercent(cpuPct)} title={cpuTitle} percent={cpuPct} />
              <LpMetric icon={<MemoryStick size={14} />} label="内存" value={formatPercent(memPct)} percent={memPct} />
            </div>
            <div className="lp-grid" data-cols="2">
              <LpMetric icon={<HardDrive size={14} />} label="磁盘" value={formatPercent(diskPct)} percent={diskPct} />
              <LpMetric icon={<Activity size={14} />} label="负载" value={formatLoadValue(load1)} title={loadTitle} percent={loadPct} />
            </div>

            <div className="lp-info">
              <span className="lp-info-head" />
              <span className="lp-info-head is-end">实时</span>
              <span className="lp-info-head is-end">累计</span>
              <span className="lp-info-head lp-life-cell" />

              <span className="lp-net-dir is-up"><ArrowUp size={13} />上行</span>
              <span className="lp-info-val">{uploadSpeed}</span>
              <span className="lp-info-val">{formatMetricBytes(totalUp)}</span>
              <span className="lp-life-cell" title={uptimeLabel}>{uptimeLabel}</span>

              <span className="lp-net-dir is-down"><ArrowDown size={13} />下行</span>
              <span className="lp-info-val">{downloadSpeed}</span>
              <span className="lp-info-val">{formatMetricBytes(totalDown)}</span>
              <span className="lp-life-cell" data-tone={expiry.color} title={expiry.text}>{expiry.text}</span>
            </div>

            <div className="lp-quota" title={trafficLimitLabel || '月度流量'}>
              <div className="lp-quota-head">
                <span className="lp-quota-label">流量</span>
                <span className="lp-quota-usage">
                  {client.traffic_limit > 0
                    ? `${formatMetricBytes(trafficUsed)} / ${formatMetricBytes(client.traffic_limit)}`
                    : trafficLimitLabel || '流量未限'}
                </span>
              </div>
              <LpBar percent={trafficPct ?? null} level={quotaLevel} />
            </div>

            {homePing && <LpPingRows data={homePing} sampleCount={homePingSampleCount} />}
          </Flex>
        </Flex>
      </Link>
    </Card>
  );
}
