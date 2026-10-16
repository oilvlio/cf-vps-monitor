import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Flex, Text, Button, DropdownMenu } from '@radix-ui/themes';
import {
  ChevronLeft, ChevronDown, Check, RefreshCw, Eye, EyeOff,
  Cpu, MemoryStick, HardDrive, Network, Cable, Activity, Thermometer, MonitorSpeaker,
} from 'lucide-react';
import Loading from '../components/Loading';
import { useIsMobile } from '../hooks/useIsMobile';
import Flag from '../components/Flag';
import PingYAxisTick from '../components/PingYAxisTick';
import { useLiveData } from '../contexts/LiveDataContext';
import { useAuth } from '../contexts/AuthContext';
import { publicFetch } from '../utils/api';
import { normalizePublicClients } from '../utils/publicClients';
import {
  collectCursorHistory,
  normalizePublicGpuRecords,
  normalizePublicMonitorRecords,
  type PublicGpuRecord,
  type PublicMonitorRecord,
} from '../utils/publicHistory';
import type { ClientInfo, LiveDataMap } from '../types';
import { diskUsagePresentation, formatLastReport, formatLoadTriple, formatMetricBytes, formatMetricSpeed, formatMetricUptime, getNodeDisplayRecord, getNodeLastReportTime, getNodeStatus, resourceTotal } from '../utils/nodeMetrics';
import { formatCpuSpec } from '../utils/cpuFormat';
import { filterMonitorNodes } from '../utils/monitorView';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, ComposedChart
} from 'recharts';
import {
  buildPingChartRows,
  fetchPingTaskSeries,
  formatPingLossRate,
  formatPingMs,
  getPingLossRate,
  getPingSeriesP75,
  getPingSeriesWithRecords,
  getPingTimeDomain,
  getPingYAxisDomain,
  PingTaskSeries,
} from '../utils/pingChart';
import { buildMonitorChartData, getMonitorChartRenderData } from '../utils/monitorChartData';
import { cutPeakRows, latencyHeatColor, lossHeatColor, pingRecordLossPercent } from '../utils/pingChartView';
import { metricNumber } from '../utils/nodeMetrics';
import { parseTrafficLimitType, formatTrafficLimitLabel } from '../utils/traffic';
import { chartTooltipProps } from '../utils/chartTooltip';

const formatSpeed = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
};

function formatIpSupport(supported?: boolean, sourceValue?: string) {
  return supported || Boolean(sourceValue) ? '支持' : '不支持';
}

type TimeRange = '4h' | '12h' | '24h' | '3d' | '7d';
type ViewTab = 'load' | 'ping';

const timeRangeMs: Record<TimeRange, number> = {
  '4h': 14400000,
  '12h': 43200000,
  '24h': 86400000,
  '3d': 259200000,
  '7d': 604800000,
};

const timeRangeHours: Record<TimeRange, number> = {
  '4h': 4,
  '12h': 12,
  '24h': 24,
  '3d': 72,
  '7d': 168,
};

const timeRangePointLimit: Record<TimeRange, number> = {
  '4h': 360,
  '12h': 720,
  '24h': 720,
  '3d': 1000,
  '7d': 400,
};

const pingChartMargin = { top: 14, right: 20, bottom: 4, left: 4 };
const miniChartMargin = { top: 8, right: 10, bottom: 0, left: 0 };
// 详情页整体放大：图表不再是 150/210 的小图。窄屏（<720）由 useChartHeights 回落。
const miniChartHeight = 200;
const pingChartHeight = 400;
const lpYAxisBase = { fontSize: 11, tickCount: 4, tickLine: false, axisLine: false, tickMargin: 4 } as const;
const lpYAxis = { ...lpYAxisBase, width: 44 };
const lpYAxisWide = { ...lpYAxisBase, width: 62 };

const timeRangeLabel: Record<TimeRange, string> = {
  '4h': '4 小时', '12h': '12 小时', '24h': '24 小时', '3d': '3 天', '7d': '7 天',
};

type PingMode = 'latency' | 'loss';

function historyQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query.toString();
}
export default function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile(720);
  const { authLoading, isAuthenticated } = useAuth();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [records, setRecords] = useState<PublicMonitorRecord[]>([]);
  const [clientLoading, setClientLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [gpuLoading, setGpuLoading] = useState(false);
  const [gpuRefresh, setGpuRefresh] = useState(0);
  const clientRequestRef = useRef(0);
  const recordsRequestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>('load');
  const [timeRange, setTimeRange] = useState<TimeRange>('4h');
  const [recordsRangeEnd, setRecordsRangeEnd] = useState(() => Date.now());
  const [pingSeries, setPingSeries] = useState<PingTaskSeries[]>([]);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string | null>(null);
  const [shouldLoadPing, setShouldLoadPing] = useState(false);
  // 被点掉的测速点（与 LuminaPlus 一致：点击图例切换显示 / 隐藏，空集合即全部显示）。
  const [hiddenPingKeys, setHiddenPingKeys] = useState<string[]>([]);
  const [pingMode, setPingMode] = useState<PingMode>('latency');
  const [pingCutPeak, setPingCutPeak] = useState(false);
  // 库里的原始 Ping 记录是去重后的（状态不变不落库），各任务时间点并不对齐，
  // 所以默认连线；关掉后才在缺值处断开。
  const [pingConnectGaps, setPingConnectGaps] = useState(true);
  const [pingRefresh, setPingRefresh] = useState(0);
  const [gpuRecords, setGpuRecords] = useState<PublicGpuRecord[]>([]);
  const pingSectionRef = useRef<HTMLDivElement | null>(null);
  const { liveData, snapshotReady } = useLiveData();
  const liveView: LiveDataMap = useMemo(() => ({ online: liveData?.online || [], data: liveData?.data || {},
    clients: liveData?.clients || [], last_known: liveData?.last_known || {}, statusReady: snapshotReady }), [liveData, snapshotReady]);
  const liveRecord = uuid ? getNodeDisplayRecord(uuid, liveView) : undefined;
  const nodeStatus = uuid ? getNodeStatus(uuid, liveView) : 'unknown';
  const onlineSet = useMemo(() => new Set(liveData?.online || []), [liveData?.online]);
  const groupedClients = useMemo(() => {
    const sorted = filterMonitorNodes(clients, liveView, { offlinePosition: 'last' });

    const groups = new Map<string, ClientInfo[]>();
    sorted.forEach((node) => {
      const groupName = node.group?.trim() || '未分组';
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(node);
    });

    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === '未分组') return 1;
        if (b === '未分组') return -1;
        return a.localeCompare(b);
      })
      .map(([group, nodes]) => ({ group, nodes }));
  }, [clients, liveView]);

  // Load public client info.
  const loadClient = useCallback(async (signal?: AbortSignal) => {
    if (!uuid || authLoading) return;
    const requestId = ++clientRequestRef.current;
    setClientLoading(true);
    setClient(null);
    try {
      setError(null);
      const data = await publicFetch(`/nodes${isAuthenticated ? '?include_hidden=1' : ''}`, { signal });
      if (signal?.aborted || requestId !== clientRequestRef.current) return;
      const visible = normalizePublicClients(data, { includeHidden: isAuthenticated });
      setClients(visible);
      const found = visible.find((c) => c.uuid === uuid) || null;
      if (found) { setClient(found); } else { setError('服务器不存在'); }
    } catch {
      if (!signal?.aborted && requestId === clientRequestRef.current) setError('加载失败');
    } finally {
      if (!signal?.aborted && requestId === clientRequestRef.current) setClientLoading(false);
    }
  }, [uuid, authLoading, isAuthenticated]);

  useEffect(() => {
    const controller = new AbortController();
    void loadClient(controller.signal);
    return () => { controller.abort(); clientRequestRef.current += 1; };
  }, [loadClient]);

  // Load history records
  const loadRecords = useCallback(async (range: TimeRange, signal?: AbortSignal) => {
    if (!uuid || authLoading) return;
    const requestId = ++recordsRequestRef.current;
    setRecordsLoading(true);
    setRecords([]);
    setRecordsError(null);
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[range];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();
    const limit = timeRangePointLimit[range];
    setRecordsRangeEnd(endTs);

    try {
      const data = await collectCursorHistory(
        (cursor) => publicFetch(`/records/load?${historyQuery({ uuid, start, end, cursor, limit: Math.min(limit, 500), include_hidden: isAuthenticated ? 1 : undefined })}`, { signal }),
        { cursor: end, start, end, normalize: normalizePublicMonitorRecords, signal },
      );
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecords(data);
    } catch {
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecordsError('加载监控历史失败，请重试');
    } finally {
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecordsLoading(false);
    }
  }, [uuid, authLoading, isAuthenticated]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRecords(timeRange, controller.signal);
    return () => { controller.abort(); recordsRequestRef.current += 1; };
  }, [loadRecords, timeRange]);

  useEffect(() => {
    setShouldLoadPing(false);
    setPingSeries([]);
    setHiddenPingKeys([]);
    setPingError(null);
    setPingLoading(false);
  }, [uuid]);

  useEffect(() => {
    if (shouldLoadPing || viewTab !== 'ping') return;
    const target = pingSectionRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setShouldLoadPing(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoadPing(true);
      observer.disconnect();
    }, { rootMargin: '240px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [shouldLoadPing, uuid, viewTab]);

  // Load ping tasks and records only when the Ping card is near the viewport.
  useEffect(() => {
    if (!uuid || authLoading || !shouldLoadPing) return;
    const controller = new AbortController();
    setPingSeries([]);
    setPingError(null);
    setPingLoading(true);

    fetchPingTaskSeries(uuid, { limit: timeRangePointLimit[timeRange], maxTasks: 8, rangeHours: timeRangeHours[timeRange], cursor: new Date().toISOString(), start: new Date(Date.now() - timeRangeMs[timeRange]).toISOString(), end: new Date().toISOString(), includeHidden: isAuthenticated, signal: controller.signal })
      .then((series) => {
        if (!controller.signal.aborted) setPingSeries(series);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPingError('加载 Ping 数据失败');
          setPingSeries([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPingLoading(false);
      });

    return () => controller.abort();
  }, [shouldLoadPing, timeRange, uuid, authLoading, isAuthenticated, pingRefresh]);

  // Load GPU records (only for GPU-capable clients)
  useEffect(() => {
    setGpuRecords([]);
    setGpuError(null);
    setGpuLoading(false);
    if (!uuid || authLoading || !client?.gpu_name || client.uuid !== uuid) return;
    setGpuLoading(true);
    const controller = new AbortController();
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[timeRange];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();

    collectCursorHistory(
      (cursor) => publicFetch(`/records/gpu?${historyQuery({ uuid, start, end, cursor, limit: 500, include_hidden: isAuthenticated ? 1 : undefined })}`, { signal: controller.signal }),
      { cursor: end, start, end, normalize: normalizePublicGpuRecords, signal: controller.signal },
    )
      .then((data) => { if (!controller.signal.aborted) setGpuRecords(data); })
      .catch(() => { if (!controller.signal.aborted) setGpuError('加载 GPU 历史失败，请重试'); })
      .finally(() => { if (!controller.signal.aborted) setGpuLoading(false); });
    return () => controller.abort();
  }, [uuid, timeRange, client?.uuid, client?.gpu_name, authLoading, isAuthenticated, gpuRefresh]);

  const handleTimeRangeChange = (v: string) => {
    const range = v as TimeRange;
    setTimeRange(range);
    setRecords([]);
    setGpuRecords([]);
    setRecordsLoading(true);
  };

  // 这些派生数据是纯函数且要遍历全部 ping 点，放在提前 return 之前并 memo，
  // 避免 hover/轮询等无关重渲染时反复重算。
  const pingSeriesWithRecords = useMemo(() => getPingSeriesWithRecords(pingSeries), [pingSeries]);
  const visiblePingSeries = useMemo(() => {
    if (hiddenPingKeys.length === 0) return pingSeriesWithRecords;
    const hidden = new Set(hiddenPingKeys);
    return pingSeriesWithRecords.filter((item) => !hidden.has(item.task.key));
  }, [pingSeriesWithRecords, hiddenPingKeys]);
  const pingChartRows = useMemo(() => {
    if (pingMode === 'loss') return buildPingChartRows(visiblePingSeries, pingRecordLossPercent);
    const rows = buildPingChartRows(visiblePingSeries);
    return pingCutPeak ? cutPeakRows(rows, visiblePingSeries.map((item) => item.task.key)) : rows;
  }, [visiblePingSeries, pingMode, pingCutPeak]);
  const pingYAxisDomain = useMemo<[number, number]>(
    () => (pingMode === 'loss' ? [0, 100] : getPingYAxisDomain(visiblePingSeries)),
    [visiblePingSeries, pingMode],
  );
  const pingXAxisDomain = useMemo(
    () => getPingTimeDomain(visiblePingSeries, timeRangeHours[timeRange]),
    [visiblePingSeries, timeRange],
  );

  if (clientLoading || (client && client.uuid !== uuid) || (recordsLoading && records.length === 0)) return <Loading />;
  if (error || !client) return <Text color="red" align="center" style={{ padding: 40 }}>{error || '未找到'}</Text>;

  const latestHistory = records.length > 0 ? records[records.length - 1] : null;
  const latest = liveRecord || latestHistory;
  const latestRecordTime = liveRecord ? getNodeLastReportTime(uuid || '', liveView)
    : latestHistory ? Date.parse(latestHistory.time) : undefined;

  const chartTimeFormatter = (value: unknown) => {
    const dateInput = typeof value === 'string' || typeof value === 'number' || value instanceof Date ? value : '';
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';
    return timeRange !== '4h'
      ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartData = buildMonitorChartData(records);
  const chartRenderData = getMonitorChartRenderData(chartData, timeRangeMs[timeRange], recordsRangeEnd);
  const monitorXAxisDomain = [recordsRangeEnd - timeRangeMs[timeRange], recordsRangeEnd] as [number, number];
  const lastPoint = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const hasDiskData = chartData.some((point) => point.disk !== null);
  const hasTempData = chartData.some((point) => point.temp !== null);

  const gpuChartData = gpuRecords.map((r) => ({
    time: new Date(r.time).getTime(),
    utilization: r.utilization || 0,
    memory: r.mem_total > 0 ? Number(((r.mem_used / r.mem_total) * 100).toFixed(1)) : 0,
    temp: r.temperature || 0,
  }));
  const lastGpuPoint = gpuChartData.length > 0 ? gpuChartData[gpuChartData.length - 1] : null;

  const togglePingTask = (taskKey: string) => {
    setHiddenPingKeys((current) => (
      current.includes(taskKey) ? current.filter((key) => key !== taskKey) : [...current, taskKey]
    ));
  };
  const allPingHidden = pingSeriesWithRecords.length > 0 && hiddenPingKeys.length >= pingSeriesWithRecords.length;
  const toggleAllPing = () => {
    setHiddenPingKeys(allPingHidden ? [] : pingSeriesWithRecords.map((item) => item.task.key));
  };

  // 与 DetailsGrid 同口径的展示数据：字段一个不少，只是按系统 / 资源 / 网络分组横排。
  const infoDisk = diskUsagePresentation(latest || undefined, client.disk_total);
  const infoIpValue = `IPv4 ${formatIpSupport(client.has_ipv4, client.ipv4)} / IPv6 ${formatIpSupport(client.has_ipv6, client.ipv6)}`;
  const normalizedRemark = client.public_remark?.trim();

  const memTotal = resourceTotal(latest?.ram_total, client.mem_total);
  const swapTotal = latest?.swap_total ?? client.swap_total;
  const memUsedText = liveRecord && memTotal ? `${formatMetricBytes(liveRecord.ram)} / ${formatMetricBytes(memTotal)}` : formatMetricBytes(memTotal);
  const swapUsedText = liveRecord && swapTotal ? `${formatMetricBytes(liveRecord.swap)} / ${formatMetricBytes(swapTotal)}` : formatMetricBytes(swapTotal);
  const loadText = lastPoint && (lastPoint.load !== null || lastPoint.load5 !== null || lastPoint.load15 !== null)
    ? formatLoadTriple(lastPoint.load, lastPoint.load5, lastPoint.load15) : '—';

  // 实时网络 / 累计流量 / 配额进度（口径与首页 NodeCard 一致）。
  const rtIn = metricNumber(liveRecord?.net_in ?? lastPoint?.net_in);
  const rtOut = metricNumber(liveRecord?.net_out ?? lastPoint?.net_out);
  const totalUp = metricNumber(liveRecord?.net_total_up);
  const totalDown = metricNumber(liveRecord?.net_total_down);
  const trafficLimit = client.traffic_limit > 0 ? client.traffic_limit : 0;
  const trafficUsed = (() => {
    if (!trafficLimit || totalUp === null || totalDown === null) return null;
    switch (parseTrafficLimitType(client.traffic_limit_type)) {
      case 'max': return Math.max(totalUp, totalDown);
      case 'min': return Math.min(totalUp, totalDown);
      case 'up': return totalUp;
      case 'down': return totalDown;
      default: return totalUp + totalDown;
    }
  })();
  const trafficFraction = trafficLimit && trafficUsed !== null ? Math.min(1, trafficUsed / trafficLimit) : 0;
  const lastUpdateText = latestRecordTime ? formatLastReport(latestRecordTime) : '—';

  const miniH = isMobile ? 170 : miniChartHeight;
  const pingH = isMobile ? 300 : pingChartHeight;

  const miniXAxis = (
    <XAxis
      dataKey="time"
      type="number"
      domain={monitorXAxisDomain}
      tickFormatter={chartTimeFormatter}
      fontSize={11}
      minTickGap={56}
      tickLine={false}
      axisLine={false}
    />
  );
  const miniGrid = <CartesianGrid strokeDasharray="3 3" opacity={0.22} />;
  const pct = (value: unknown) => `${Number(value).toFixed(1)}%`;
  const pctTick = (value: unknown) => `${Number(value).toFixed(0)}%`;

  const statusLabel = nodeStatus === 'online' ? `在线 · 已运行 ${formatMetricUptime(latest?.uptime)}` : nodeStatus === 'offline' ? '离线' : '确认中';

  return (
    <div className="lp-inst-page">
      <div className="lp-inst-inner">
        <button type="button" className="lp-back" onClick={() => navigate('/')}>
          <ChevronLeft size={14} /> 返回
        </button>

        {/* 概览：名称 + 节点切换 + 状态；下面横排 系统 / 资源 / 网络 三组 */}
        <section className="lp-panel">
          <header className="lp-panel-head">
            <div className="lp-panel-headings">
              <div className="lp-panel-title-row">
                <Flag region={client.region} size={20} />
                <h2 className="lp-panel-title">{client.name}</h2>
                <LpNodeSwitcher groups={groupedClients} activeUuid={uuid || ''} onlineSet={onlineSet} statusReady={snapshotReady} onSelect={(next) => navigate(`/instance/${next}`)} />
                <span className="lp-pill" data-status={nodeStatus}>
                  <Activity size={12} aria-hidden /> {statusLabel}
                </span>
                {client.group && <span className="lp-pill is-muted">{client.group}</span>}
              </div>
              {nodeStatus === 'offline' && (
                <p className="lp-panel-desc">最后上报 {formatLastReport(latestRecordTime)} · 上报时已运行 {formatMetricUptime(latest?.uptime)}</p>
              )}
            </div>
          </header>

          <div className="lp-info-groups">
            <div className="lp-info-group">
              <div className="lp-info-group-title">系统</div>
              <LpInfoRow label="CPU" value={formatCpuSpec(client.cpu_name, client.cpu_cores)} />
              <LpInfoRow label="架构" value={client.arch || '-'} />
              <LpInfoRow label="虚拟化" value={client.virtualization || '-'} />
              <LpInfoRow label="操作系统" value={client.os || '-'} />
              <LpInfoRow label="内核" value={client.kernel_version || '-'} />
              <LpInfoRow label="GPU" value={client.gpu_name || '-'} />
            </div>

            <div className="lp-info-group">
              <div className="lp-info-group-title">资源</div>
              <LpInfoRow label="内存" value={memUsedText} />
              <LpInfoRow label="交换空间" value={swapTotal ? swapUsedText : '无'} />
              <LpInfoRow label="磁盘" value={infoDisk.estimated ? infoDisk.detail : formatMetricBytes(resourceTotal(latest?.disk_total, client.disk_total))} />
              <LpInfoRow label="负载" value={loadText} />
              <LpInfoRow label="运行时长" value={formatMetricUptime(latest?.uptime)} />
              <LpInfoRow label="Agent" value={client.version || '-'} />
              {infoDisk.estimated && <p className="lp-info-note">{infoDisk.description} {infoDisk.sampleLabel}</p>}
            </div>

            <div className="lp-info-group">
              <div className="lp-info-group-title">网络</div>
              <LpInfoRow label="实时网络" value={rtIn === null && rtOut === null ? '—' : `↓ ${formatMetricSpeed(rtIn)} · ↑ ${formatMetricSpeed(rtOut)}`} />
              <LpInfoRow label="最近更新" value={lastUpdateText} />
              <LpInfoRow label="IP 支持" value={infoIpValue} />
              <LpInfoRow label="地区" value={client.region || '-'} />
              {normalizedRemark && <LpInfoRow label="备注" value={normalizedRemark} />}
              <div className="lp-info-item is-stack">
                <span className="lp-info-label">累计流量</span>
                <span className="lp-info-value">
                  {totalUp === null || totalDown === null ? '—' : `↑ ${formatMetricBytes(totalUp)} · ↓ ${formatMetricBytes(totalDown)}`}
                </span>
                {trafficLimit > 0 && (
                  <>
                    <div className="lp-progress" aria-hidden><span style={{ width: `${trafficFraction * 100}%` }} /></div>
                    <span className="lp-info-note">
                      {trafficUsed === null ? '—' : formatMetricBytes(trafficUsed)} / {formatTrafficLimitLabel(client.traffic_limit, client.traffic_limit_type)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 负载 | Ping 切换 + 时间档位 */}
        <div className="lp-controls">
          <div className="lp-seg" role="group" aria-label="图表类型">
            <button type="button" data-active={viewTab === 'load'} aria-pressed={viewTab === 'load'} onClick={() => setViewTab('load')}>负载</button>
            <button type="button" data-active={viewTab === 'ping'} aria-pressed={viewTab === 'ping'} onClick={() => setViewTab('ping')}>Ping</button>
          </div>
          <div className="lp-seg is-scroll" role="group" aria-label="时间范围">
            {(Object.keys(timeRangeLabel) as TimeRange[]).map((range) => (
              <button key={range} type="button" data-active={timeRange === range} aria-pressed={timeRange === range} onClick={() => handleTimeRangeChange(range)}>
                {timeRangeLabel[range]}
              </button>
            ))}
          </div>
        </div>

        {viewTab === 'load' ? (
          <section className="lp-panel lp-chart-panel">
            <header className="lp-panel-head is-center">
              <h2 className="lp-panel-title">负载图表</h2>
              <div className="lp-head-meta">
                <span className="lp-meta-chip">覆盖 <strong>{timeRangeLabel[timeRange]}</strong></span>
                <span className="lp-meta-chip">采样 <strong>{records.length}</strong> 个点</span>
                <button type="button" className="lp-tool-btn" onClick={() => void loadRecords(timeRange)} disabled={recordsLoading} aria-busy={recordsLoading}>
                  <RefreshCw size={14} aria-hidden /> {recordsLoading ? '刷新中' : '刷新'}
                </button>
              </div>
            </header>

            {recordsError && <Flex align="center" gap="2" mb="3"><Text color="red" role="alert">{recordsError}</Text><Button size="1" variant="soft" onClick={() => void loadRecords(timeRange)}>重试</Button></Flex>}
            {gpuError && <Flex align="center" gap="2" mb="3"><Text color="red" role="alert">{gpuError}</Text><Button size="1" variant="soft" onClick={() => setGpuRefresh(value => value + 1)}>重试 GPU 历史</Button></Flex>}

            <div className="lp-chart-grid" data-count={6 + (hasTempData ? 1 : 0) + (client.gpu_name ? 1 : 0)}>
              <LpMetricCard icon={<Cpu size={14} />} accent="var(--lp-cpu)" title="CPU" value={lastPoint ? pct(lastPoint.cpu) : '—'} sub="使用率">
                <LpAreaChart id="cpu" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                  yProps={{ ...lpYAxis, domain: [0, 100], tickFormatter: pctTick }} labelFormatter={chartTimeFormatter}
                  series={[{ key: 'cpu', name: 'CPU', color: 'var(--lp-cpu)', band: true, format: pct }]} />
              </LpMetricCard>

              <LpMetricCard icon={<MemoryStick size={14} />} accent="var(--lp-mem)" title="内存" value={lastPoint ? pct(lastPoint.ram) : '—'} sub={liveRecord && memTotal ? memUsedText : undefined}>
                <LpAreaChart id="mem" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                  yProps={{ ...lpYAxis, domain: [0, 100], tickFormatter: pctTick }} labelFormatter={chartTimeFormatter}
                  series={[{ key: 'ram', name: '内存', color: 'var(--lp-mem)', band: true, format: pct }]} />
              </LpMetricCard>

              <LpMetricCard
                icon={<HardDrive size={14} />} accent="var(--lp-disk)" title="磁盘"
                value={lastPoint?.disk !== null && lastPoint?.disk !== undefined ? pct(lastPoint.disk) : '—'}
                sub={infoDisk.estimated ? infoDisk.detail : '已用空间'}
                note="按上报时间记录，可能包含容器文件占用估算；同一次磁盘采样可出现在多次上报中。"
              >
                {!recordsLoading && !recordsError && !hasDiskData ? (
                  <Flex align="center" justify="center" style={{ height: miniH }}><Text role="status" color="gray">磁盘使用量数据不可用</Text></Flex>
                ) : (
                  <LpAreaChart id="disk" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                    yProps={{ ...lpYAxis, domain: [0, 100], tickFormatter: pctTick }} labelFormatter={chartTimeFormatter}
                    series={[{ key: 'disk', name: '磁盘', color: 'var(--lp-disk)', band: true, dots: true, format: pct }]} />
                )}
              </LpMetricCard>

              <LpMetricCard icon={<Network size={14} />} accent="var(--lp-net)" title="网络"
                value={lastPoint ? `↓ ${formatSpeed(lastPoint.net_in)} · ↑ ${formatSpeed(lastPoint.net_out)}` : '—'}
                sub={totalUp !== null && totalDown !== null ? `累计 ↓ ${formatMetricBytes(totalDown)} · ↑ ${formatMetricBytes(totalUp)}` : undefined}>
                <LpAreaChart id="net" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                  yProps={{ ...lpYAxisWide, tickFormatter: (value: unknown) => formatSpeed(Number(value)) }} labelFormatter={chartTimeFormatter}
                  series={[
                    { key: 'net_in', name: '下载', color: 'var(--lp-net)', format: (v) => formatSpeed(Number(v)) },
                    { key: 'net_out', name: '上传', color: 'var(--lp-net-up)', format: (v) => formatSpeed(Number(v)) },
                  ]} />
              </LpMetricCard>

              <LpMetricCard icon={<Cable size={14} />} accent="var(--lp-conn)" title="连接数"
                value={lastPoint ? `TCP ${Number(lastPoint.connections).toFixed(0)} / UDP ${Number(lastPoint.connections_udp).toFixed(0)}` : '—'} sub="连接">
                <LpAreaChart id="conn" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                  yProps={{ ...lpYAxis, domain: ['auto', 'auto'], allowDecimals: false }} labelFormatter={chartTimeFormatter}
                  series={[
                    { key: 'connections', name: 'TCP', color: 'var(--lp-conn)', format: (v) => Number(v).toFixed(0) },
                    { key: 'connections_udp', name: 'UDP', color: 'var(--lp-conn-udp)', format: (v) => Number(v).toFixed(0) },
                  ]} />
              </LpMetricCard>

              <LpMetricCard icon={<Activity size={14} />} accent="var(--lp-proc)" title="进程"
                value={lastPoint ? Number(lastPoint.process_count).toFixed(0) : '—'} sub={loadText !== '—' ? `负载 ${loadText}` : undefined}>
                <LpAreaChart id="proc" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                  yProps={{ ...lpYAxis, domain: ['auto', 'auto'], allowDecimals: false }} labelFormatter={chartTimeFormatter}
                  series={[{ key: 'process_count', name: '进程数', color: 'var(--lp-proc)', format: (v) => Number(v).toFixed(0) }]} />
              </LpMetricCard>

              {hasTempData && (
                <LpMetricCard icon={<Thermometer size={14} />} accent="var(--lp-temp)" title="温度"
                  value={lastPoint?.temp !== null && lastPoint?.temp !== undefined ? `${Number(lastPoint.temp).toFixed(1)} °C` : '—'} sub="CPU / SoC">
                  <LpAreaChart id="temp" data={chartRenderData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                    yProps={{ ...lpYAxis, domain: ['auto', 'auto'], tickFormatter: (value: unknown) => `${Number(value).toFixed(0)}°C` }} labelFormatter={chartTimeFormatter}
                    series={[{ key: 'temp', name: '温度', color: 'var(--lp-temp)', band: true, dots: true, format: (v) => `${Number(v).toFixed(1)} °C` }]} />
                </LpMetricCard>
              )}

              {client.gpu_name && (
                <LpMetricCard icon={<MonitorSpeaker size={14} />} accent="var(--lp-gpu)" title="GPU"
                  value={lastGpuPoint ? pct(lastGpuPoint.utilization) : '—'} sub={client.gpu_name}>
                  {gpuLoading ? (
                    <Flex align="center" justify="center" style={{ height: miniH }}><Text role="status" color="gray">正在加载 GPU 历史…</Text></Flex>
                  ) : !gpuError && gpuRecords.length === 0 ? (
                    <Flex align="center" justify="center" style={{ height: miniH }}><Text role="status" color="gray">暂无 GPU 历史记录</Text></Flex>
                  ) : gpuError ? null : (
                    <LpAreaChart id="gpu" data={gpuChartData} height={miniH} margin={miniChartMargin} grid={miniGrid} xAxis={miniXAxis}
                      yProps={{ ...lpYAxis, domain: [0, 100], tickFormatter: pctTick }} labelFormatter={chartTimeFormatter}
                      series={[
                        { key: 'utilization', name: '利用率 %', color: 'var(--lp-gpu)', format: pct },
                        { key: 'memory', name: '显存 %', color: 'var(--lp-net)', format: pct },
                        { key: 'temp', name: '温度 °C', color: 'var(--lp-temp)', fill: false, format: (v) => `${Number(v).toFixed(1)} °C` },
                      ]} />
                  )}
                </LpMetricCard>
              )}
            </div>
          </section>
        ) : (
          <div ref={pingSectionRef}>
            <section className="lp-panel lp-chart-panel lp-ping-panel">
              <header className="lp-panel-head is-center">
                <div className="lp-panel-headings">
                  <h2 className="lp-panel-title">Ping 图表</h2>
                  <p className="lp-panel-desc">
                    覆盖 {timeRangeLabel[timeRange]}
                    {pingSeries.length > 0 && ` · ${pingSeriesWithRecords.length} / ${pingSeries.length} 个任务有记录`}
                  </p>
                </div>
                <div className="lp-head-meta">
                  <LpSwitch label="削峰平滑" title="剔除与邻近点相差过大的尖峰，再做平滑（仅延迟视图）" active={pingCutPeak} disabled={pingMode === 'loss'} onToggle={() => setPingCutPeak((v) => !v)} />
                  <LpSwitch label="断点连线" title="在缺值处把前后两个点连起来" active={pingConnectGaps} onToggle={() => setPingConnectGaps((v) => !v)} />
                  <button type="button" className="lp-tool-btn" onClick={toggleAllPing} disabled={pingSeriesWithRecords.length === 0}>
                    {allPingHidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                    {allPingHidden ? '显示全部' : '隐藏全部'}
                  </button>
                  <button type="button" className="lp-tool-btn" onClick={() => setPingRefresh((v) => v + 1)} disabled={pingLoading} aria-busy={pingLoading}>
                    <RefreshCw size={14} aria-hidden /> {pingLoading ? '刷新中' : '刷新'}
                  </button>
                </div>
              </header>

              {pingLoading ? (
                <Loading />
              ) : pingError ? (
                <p className="lp-empty" role="alert">{pingError}</p>
              ) : pingSeries.length === 0 ? (
                <p className="lp-empty">暂无 Ping 任务</p>
              ) : pingChartRows.length === 0 && visiblePingSeries.length > 0 || pingSeriesWithRecords.length === 0 ? (
                <p className="lp-empty">暂无该节点的 Ping 记录</p>
              ) : (
                <>
                  <div className="lp-ping-toolbar">
                    <div className="lp-seg" role="group" aria-label="Ping 指标">
                      <button type="button" data-active={pingMode === 'latency'} aria-pressed={pingMode === 'latency'} onClick={() => setPingMode('latency')}>延迟</button>
                      <button type="button" data-active={pingMode === 'loss'} aria-pressed={pingMode === 'loss'} onClick={() => setPingMode('loss')}>丢包率</button>
                    </div>
                    <div className="lp-ping-tasks">
                      {pingSeriesWithRecords.map((item) => {
                        const visible = !hiddenPingKeys.includes(item.task.key);
                        const lastValid = [...item.records].reverse().find((r) => Number.isFinite(Number(r.value)) && Number(r.value) >= 0);
                        const latestMs = lastValid ? Number(lastValid.value) : null;
                        const lossRate = getPingLossRate(item.records);
                        const p75 = getPingSeriesP75(item.records);
                        return (
                          <button
                            key={item.task.key}
                            type="button"
                            className="lp-ping-task"
                            data-visible={visible}
                            aria-pressed={visible}
                            onClick={() => togglePingTask(item.task.key)}
                            style={{ borderColor: visible ? item.task.color : undefined }}
                            title={`${item.task.type} ${item.task.target}\n最新 ${formatPingMs(latestMs)} · P75 ${p75 === null ? '-' : formatPingMs(p75)} · 丢包 ${formatPingLossRate(lossRate)}`}
                          >
                            <span className="lp-ping-dot" style={{ background: item.task.color }} aria-hidden />
                            <span className="lp-ping-name">{item.task.label}</span>
                            <span className="lp-ping-primary" style={{ color: latencyHeatColor(latestMs) }}>{latestMs === null ? '—' : `${latestMs.toFixed(1)} ms`}</span>
                            <span className="lp-ping-loss" style={{ color: lossHeatColor(lossRate) }}>{formatPingLossRate(lossRate)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {visiblePingSeries.length === 0 ? (
                    <p className="lp-empty">测速点已全部隐藏</p>
                  ) : (
                    <div className="lp-ping-chart">
                      <ResponsiveContainer width="100%" height={pingH}>
                        <LineChart data={pingChartRows} margin={pingChartMargin}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.22} />
                          <XAxis
                            dataKey="time"
                            type="number"
                            domain={pingXAxisDomain}
                            tickFormatter={chartTimeFormatter}
                            fontSize={11}
                            minTickGap={48}
                            tickLine={false}
                            axisLine={false}
                          />
                          {pingMode === 'latency' ? (
                            <YAxis {...lpYAxisBase} width={56} domain={pingYAxisDomain} allowDecimals={false} tick={<PingYAxisTick />} />
                          ) : (
                            <YAxis {...lpYAxisBase} width={48} domain={[0, 100]} allowDecimals={false} tickFormatter={pctTick} />
                          )}
                          <Tooltip
                            {...chartTooltipProps}
                            labelFormatter={chartTimeFormatter}
                            itemSorter={(item) => (pingMode === 'latency' ? Number(item.value ?? 0) : -Number(item.value ?? 0))}
                            formatter={(value, name) => [pingMode === 'loss' ? formatPingLossRate(Number(value)) : formatPingMs(Number(value)), name]}
                          />
                          {visiblePingSeries.map((item) => (
                            <Line
                              key={item.task.key}
                              type={pingMode === 'loss' ? 'linear' : 'monotone'}
                              dataKey={item.task.key}
                              name={item.task.label}
                              stroke={item.task.color}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 3.5 }}
                              connectNulls={pingMode === 'loss' ? true : pingConnectGaps}
                              isAnimationActive={false}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function LpInfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  const title = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return (
    <div className="lp-info-item">
      <span className="lp-info-label">{label}</span>
      <span className="lp-info-value" title={title}>{value || '-'}</span>
    </div>
  );
}

function LpSwitch({ label, title, active, disabled, onToggle }: { label: string; title?: string; active: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="lp-tool-btn lp-switch" data-active={active && !disabled} aria-pressed={active} disabled={disabled} title={title} onClick={onToggle}>
      <span>{label}</span>
      <span className="lp-switch-track" aria-hidden><span className="lp-switch-thumb" /></span>
      <span className="lp-switch-state">{active ? '开启' : '关闭'}</span>
    </button>
  );
}

function LpMetricCard({ icon, accent, title, value, sub, note, children }: {
  icon: React.ReactNode; accent: string; title: string; value: string; sub?: string; note?: string; children: React.ReactNode;
}) {
  return (
    <section className="lp-metric-card" aria-label={title} style={{ ['--lp-accent' as string]: accent }}>
      <header className="lp-metric-head">
        <span className="lp-metric-title">{icon}{title}</span>
        <span className="lp-metric-values">
          <span className="lp-metric-value" title={value}>{value}</span>
          {sub && <span className="lp-metric-sub" title={sub}>{sub}</span>}
        </span>
      </header>
      {note && <p className="lp-metric-note">{note}</p>}
      <div className="lp-metric-body">{children}</div>
    </section>
  );
}

type LpSeriesSpec = {
  key: string;
  name: string;
  color: string;
  /** 画 xxx_min / xxx_max 两条淡线（聚合桶的极值带） */
  band?: boolean;
  dots?: boolean;
  fill?: boolean;
  format: (value: unknown) => string;
};

function LpAreaChart({ id, data, height, margin, grid, xAxis, yProps, labelFormatter, series }: {
  id: string;
  data: object[];
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  grid: React.ReactElement;
  xAxis: React.ReactElement;
  yProps: React.ComponentProps<typeof YAxis>;
  labelFormatter: (value: unknown) => string;
  series: LpSeriesSpec[];
}) {
  const byName = new Map(series.map((item) => [item.name, item]));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={margin}>
        <defs>
          {series.map((item) => (
            <linearGradient key={item.key} id={`lp-fill-${id}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: item.color, stopOpacity: 0.34 }} />
              <stop offset="100%" style={{ stopColor: item.color, stopOpacity: 0.02 }} />
            </linearGradient>
          ))}
        </defs>
        {grid}
        {xAxis}
        <YAxis {...yProps} />
        <Tooltip
          {...chartTooltipProps}
          labelFormatter={labelFormatter}
          formatter={(value: number, name) => [byName.get(String(name))?.format(value) ?? String(value), name]}
        />
        {series.filter((item) => item.band).flatMap((item) => [
          <Line key={`${item.key}-max`} type="monotone" dataKey={`${item.key}_max`} stroke={item.color} strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" tooltipType="none" />,
          <Line key={`${item.key}-min`} type="monotone" dataKey={`${item.key}_min`} stroke={item.color} strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" tooltipType="none" />,
        ])}
        {series.map((item) => (
          <Area
            key={item.key}
            type="monotone"
            dataKey={item.key}
            name={item.name}
            stroke={item.color}
            strokeWidth={1.8}
            fill={item.fill === false ? 'none' : `url(#lp-fill-${id}-${item.key})`}
            dot={item.dots ? { r: 2 } : false}
            activeDot={{ r: 3.5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function LpNodeSwitcher({ groups, activeUuid, onlineSet, statusReady, onSelect }: {
  groups: Array<{ group: string; nodes: ClientInfo[] }>;
  activeUuid: string;
  onlineSet: Set<string>;
  statusReady: boolean;
  onSelect: (uuid: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button type="button" className="lp-switch-trigger" aria-label="切换节点" title="切换节点">
          <ChevronDown size={14} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1" align="start" className="lp-switch-menu">
        {groups.map((group) => (
          <div key={group.group}>
            <DropdownMenu.Label>{group.group} ({group.nodes.length})</DropdownMenu.Label>
            {group.nodes.map((node) => {
              const online = onlineSet.has(node.uuid);
              return (
                <DropdownMenu.Item key={node.uuid} onSelect={() => onSelect(node.uuid)}>
                  <span className={`lp-switch-dot${online ? ' is-online' : statusReady ? ' is-offline' : ''}`} aria-hidden />
                  <Flag region={node.region} size={14} />
                  <span className="lp-switch-name">{node.name}</span>
                  {node.uuid === activeUuid && <Check size={13} aria-hidden />}
                </DropdownMenu.Item>
              );
            })}
          </div>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
