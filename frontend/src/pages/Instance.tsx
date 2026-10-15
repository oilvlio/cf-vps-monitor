import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Flex, Card, Text, Badge, Heading,
  Button, Box, SegmentedControl
} from '@radix-ui/themes';
import {
  ArrowLeft,
  Server, Globe, Activity,
  Layers
} from 'lucide-react';
import Loading from '../components/Loading';
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
import { diskUsagePresentation, formatLastReport, formatLoadTriple, formatMetricBytes, formatMetricUptime, getNodeDisplayRecord, getNodeLastReportTime, getNodeStatus, resourceTotal } from '../utils/nodeMetrics';
import { formatCpuSpec } from '../utils/cpuFormat';
import { filterMonitorNodes } from '../utils/monitorView';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, AreaChart
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
import { monitorYAxisProps, pingYAxisProps, wideYAxisProps } from '../utils/monitorChartAxis';
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

type TimeRange = '1h' | '4h' | '24h' | '3d' | '7d';
type ViewTab = 'load' | 'ping';

const timeRangeMs: Record<TimeRange, number> = {
  '1h': 3600000,
  '4h': 14400000,
  '24h': 86400000,
  '3d': 259200000,
  '7d': 604800000,
};

const timeRangeHours: Record<TimeRange, number> = {
  '1h': 1,
  '4h': 4,
  '24h': 24,
  '3d': 72,
  '7d': 168,
};

const timeRangePointLimit: Record<TimeRange, number> = {
  '1h': 240,
  '4h': 360,
  '24h': 720,
  '3d': 1000,
  '7d': 400,
};

const monitorChartMargin = { top: 12, right: 16, bottom: 4, left: 4 };
const miniChartMargin = { top: 8, right: 8, bottom: 0, left: 0 };
const miniChartHeight = 150;
const pingChartHeight = 210;

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
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [recordsRangeEnd, setRecordsRangeEnd] = useState(() => Date.now());
  const [pingSeries, setPingSeries] = useState<PingTaskSeries[]>([]);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string | null>(null);
  const [shouldLoadPing, setShouldLoadPing] = useState(false);
  // 空集合表示未筛选，即显示全部测速点。
  const [selectedPingTaskKeys, setSelectedPingTaskKeys] = useState<string[]>([]);
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
    setSelectedPingTaskKeys([]);
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
  }, [shouldLoadPing, timeRange, uuid, authLoading, isAuthenticated]);

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
    return timeRange !== '1h'
      ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartData = buildMonitorChartData(records);
  const chartRenderData = getMonitorChartRenderData(chartData, timeRangeMs[timeRange], recordsRangeEnd);
  const monitorXAxisDomain = [recordsRangeEnd - timeRangeMs[timeRange], recordsRangeEnd] as [number, number];
  const lastPoint = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const hasDiskData = chartData.some((point) => point.disk !== null);
  const hasTempData = chartData.some((point) => point.temp !== null);
  const hasLoadData = chartData.some((point) => point.load !== null || point.load5 !== null || point.load15 !== null);

  const gpuChartData = gpuRecords.map((r) => ({
    time: new Date(r.time).getTime(),
    utilization: r.utilization || 0,
    memory: r.mem_total > 0 ? Number(((r.mem_used / r.mem_total) * 100).toFixed(1)) : 0,
    temp: r.temperature || 0,
  }));
  const lastGpuPoint = gpuChartData.length > 0 ? gpuChartData[gpuChartData.length - 1] : null;

  const pingSeriesWithRecords = getPingSeriesWithRecords(pingSeries);
  const selectedPingTaskKeySet = new Set(selectedPingTaskKeys);
  const visiblePingSeries = selectedPingTaskKeys.length === 0
    ? pingSeriesWithRecords
    : pingSeriesWithRecords.filter((item) => selectedPingTaskKeySet.has(item.task.key));
  const pingChartRows = buildPingChartRows(visiblePingSeries);
  const pingYAxisDomain = getPingYAxisDomain(visiblePingSeries);
  const pingXAxisDomain = getPingTimeDomain(visiblePingSeries, timeRangeHours[timeRange]);

  const togglePingTask = (taskKey: string) => {
    setSelectedPingTaskKeys((current) => {
      if (current.length === 0) return [taskKey];
      if (current.includes(taskKey)) {
        const next = current.filter((key) => key !== taskKey);
        return next;
      }
      return [...current, taskKey];
    });
  };

  const timeRangeLabel = timeRange === '1h' ? '最近1小时' : timeRange === '4h' ? '最近4小时' : timeRange === '24h' ? '最近24小时' : timeRange === '3d' ? '最近3天' : '最近7天';
  // 与 DetailsGrid 同口径的展示数据：字段一个不少，只是按系统 / 资源 / 网络分组横排。
  const infoDisk = diskUsagePresentation(latest || undefined, client.disk_total);
  const infoIpValue = `IPv4 ${formatIpSupport(client.has_ipv4, client.ipv4)} / IPv6 ${formatIpSupport(client.has_ipv6, client.ipv6)}`;
  const normalizedRemark = client.public_remark?.trim();

  const miniXAxis = (
    <XAxis
      dataKey="time"
      type="number"
      domain={monitorXAxisDomain}
      tickFormatter={chartTimeFormatter}
      fontSize={11}
      minTickGap={64}
      tickLine={false}
      axisLine={false}
    />
  );
  const miniGrid = <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />;

  return (
    <div className="instance-page lp-inst-page">
      <div className="instance-shell lp-inst-shell">
        <InstanceNodeSidebar
          groups={groupedClients}
          activeUuid={uuid || ''}
          onlineSet={onlineSet}
          statusReady={snapshotReady}
          liveData={liveData?.data || {}}
          onSelect={(nextUuid) => navigate(`/instance/${nextUuid}`)}
        />

        <section className="instance-detail-panel lp-inst-panel">
      {/* Top bar */}
      <Flex justify="between" align="center" mb="4">
        <Button variant="ghost" onClick={() => navigate('/')}>
          <ArrowLeft size={16} /> 返回
        </Button>
      </Flex>

      {/* Header + 横向多信息卡（系统 / 资源 / 网络） */}
      <Card className="instance-top-summary lp-inst-summary" mb="3">
        <Flex align="center" gap="3" wrap="wrap" className="instance-top-summary-header">
          <Server size={26} color="var(--accent-9)" />
          <Heading size="5">{client.name}</Heading>
          {client.region && <Badge color="gray"><Globe size={12} /> {client.region}</Badge>}
          {client.group && <Badge color="purple"><Layers size={12} /> {client.group}</Badge>}
          <Badge color={nodeStatus === 'online' ? 'green' : nodeStatus === 'offline' ? 'red' : 'gray'} variant="solid">
            <Activity size={12} /> {nodeStatus === 'online' ? `在线 · 已运行 ${formatMetricUptime(latest?.uptime)}` : nodeStatus === 'offline' ? '离线' : '确认中'}
          </Badge>
          {nodeStatus === 'offline' && <Text size="1" color="gray">最后上报 {formatLastReport(latestRecordTime)} · 上报时已运行 {formatMetricUptime(latest?.uptime)}</Text>}
        </Flex>
        <div className="lp-info-groups">
          <div className="lp-info-group">
            <div className="lp-info-group-title">系统</div>
            <dl className="lp-info-list">
              <LpInfoRow label="CPU" value={formatCpuSpec(client.cpu_name, client.cpu_cores)} />
              <LpInfoRow label="架构" value={client.arch || '-'} />
              <LpInfoRow label="虚拟化" value={client.virtualization || '-'} />
              <LpInfoRow label="操作系统" value={client.os || '-'} />
              <LpInfoRow label="内核" value={client.kernel_version || '-'} />
              <LpInfoRow label="GPU" value={client.gpu_name || '-'} />
            </dl>
          </div>
          <div className="lp-info-group">
            <div className="lp-info-group-title">资源</div>
            <dl className="lp-info-list">
              <LpInfoRow label="内存容量" value={formatMetricBytes(resourceTotal(latest?.ram_total, client.mem_total))} />
              <LpInfoRow label="交换空间" value={formatMetricBytes(latest?.swap_total ?? client.swap_total)} />
              <LpInfoRow label="磁盘容量" value={formatMetricBytes(resourceTotal(latest?.disk_total, client.disk_total))} />
              {infoDisk.estimated && <LpInfoRow label="磁盘占用（估算）" value={infoDisk.detail} />}
              <LpInfoRow label="Agent" value={client.version || '-'} />
            </dl>
            {infoDisk.estimated && <Text as="p" size="1" color="gray" mt="2">{infoDisk.description} {infoDisk.sampleLabel}</Text>}
          </div>
          <div className="lp-info-group">
            <div className="lp-info-group-title">网络</div>
            <dl className="lp-info-list">
              <LpInfoRow label="IP 支持" value={infoIpValue} />
              <LpInfoRow label="地区" value={client.region || '-'} />
              {normalizedRemark && <LpInfoRow label="备注" value={normalizedRemark} />}
            </dl>
          </div>
        </div>
      </Card>

      {/* 负载 | Ping 切换 + 时间档位 */}
      <Card className="lp-inst-controls" mb="3">
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Flex align="center" gap="3" wrap="wrap">
            <SegmentedControl.Root size="1" value={viewTab} onValueChange={(value) => setViewTab(value as ViewTab)}>
              <SegmentedControl.Item value="load">负载</SegmentedControl.Item>
              <SegmentedControl.Item value="ping">Ping</SegmentedControl.Item>
            </SegmentedControl.Root>
            <Text weight="bold">{viewTab === 'load' ? '负载' : 'Ping 延迟'} · {timeRangeLabel}</Text>
          </Flex>
          <Flex align="center" gap="3" wrap="wrap">
            <SegmentedControl.Root size="1" value={timeRange} onValueChange={handleTimeRangeChange}>
              <SegmentedControl.Item value="1h">1小时</SegmentedControl.Item>
              <SegmentedControl.Item value="4h">4小时</SegmentedControl.Item>
              <SegmentedControl.Item value="24h">24小时</SegmentedControl.Item>
              <SegmentedControl.Item value="3d">3天</SegmentedControl.Item>
              <SegmentedControl.Item value="7d">7天</SegmentedControl.Item>
            </SegmentedControl.Root>
            <Text size="1" color="gray">{records.length} 个数据点</Text>
          </Flex>
        </Flex>
      </Card>

      {viewTab === 'load' ? (
      <div>
        {recordsError && <Card className="lp-inst-chart" mb="3"><Flex align="center" gap="2"><Text color="red" role="alert">{recordsError}</Text><Button size="1" variant="soft" onClick={() => void loadRecords(timeRange)}>重试</Button></Flex></Card>}
        {gpuError && <Card className="lp-inst-chart" mb="3"><Flex align="center" gap="2"><Text color="red" role="alert">{gpuError}</Text><Button size="1" variant="soft" onClick={() => setGpuRefresh(value => value + 1)}>重试 GPU 历史</Button></Flex></Card>}
        <div className="lp-mini-grid">
          <LpMiniCard title="CPU" value={lastPoint ? `${Number(lastPoint.cpu).toFixed(1)}%` : '—'}>
            <ResponsiveContainer width="100%" height={miniChartHeight}>
              <LineChart data={chartRenderData} margin={miniChartMargin}>
                {miniGrid}
                {miniXAxis}
                <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number) => [`${Number(value).toFixed(1)}%`, 'CPU']}
                />
                <Line type="monotone" dataKey="cpu_max" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="cpu_min" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="cpu" stroke="var(--accent-9)" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </LpMiniCard>

          <LpMiniCard title="内存" value={lastPoint ? `${Number(lastPoint.ram).toFixed(1)}%` : '—'}>
            <ResponsiveContainer width="100%" height={miniChartHeight}>
              <LineChart data={chartRenderData} margin={miniChartMargin}>
                {miniGrid}
                {miniXAxis}
                <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number) => [`${Number(value).toFixed(1)}%`, '内存']}
                />
                <Line type="monotone" dataKey="ram_max" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="ram_min" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="ram" stroke="var(--accent-9)" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </LpMiniCard>

          <LpMiniCard
            title="磁盘"
            value={lastPoint?.disk !== null && lastPoint?.disk !== undefined ? `${Number(lastPoint.disk).toFixed(1)}%` : '—'}
            note="按上报时间记录，可能包含容器文件占用估算；同一次磁盘采样可出现在多次上报中。"
          >
            {!recordsLoading && !recordsError && !hasDiskData ? (
              <Flex align="center" justify="center" style={{ height: miniChartHeight }}>
                <Text role="status" color="gray">磁盘使用量数据不可用</Text>
              </Flex>
            ) : (
              <ResponsiveContainer width="100%" height={miniChartHeight}>
                <LineChart data={chartRenderData} margin={miniChartMargin}>
                  {miniGrid}
                  {miniXAxis}
                  <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => [`${Number(value).toFixed(1)}%`, '磁盘']}
                  />
                  <Line type="monotone" dataKey="disk_max" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                  <Line type="monotone" dataKey="disk_min" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                  <Line type="monotone" dataKey="disk" stroke="var(--accent-9)" dot={{ r: 2 }} connectNulls={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </LpMiniCard>

          <LpMiniCard
            title="网络"
            value={lastPoint ? `↓ ${formatSpeed(lastPoint.net_in)} · ↑ ${formatSpeed(lastPoint.net_out)}` : '—'}
          >
            <ResponsiveContainer width="100%" height={miniChartHeight}>
              <AreaChart data={chartRenderData} margin={miniChartMargin}>
                {miniGrid}
                {miniXAxis}
                <YAxis {...wideYAxisProps} tickFormatter={(value) => formatSpeed(Number(value))} unit="" />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number, name) => [formatSpeed(Number(value)), name]}
                />
                <Area type="monotone" dataKey="net_in" stroke="var(--green-9)" fill="var(--green-3)" fillOpacity={0.32} dot={false} name="下载" isAnimationActive={false} />
                <Area type="monotone" dataKey="net_out" stroke="var(--blue-9)" fill="var(--blue-3)" fillOpacity={0.32} dot={false} name="上传" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </LpMiniCard>

          <LpMiniCard
            title="连接数"
            value={lastPoint ? `TCP ${Number(lastPoint.connections).toFixed(0)} · UDP ${Number(lastPoint.connections_udp).toFixed(0)}` : '—'}
          >
            <ResponsiveContainer width="100%" height={miniChartHeight}>
              <LineChart data={chartRenderData} margin={miniChartMargin}>
                {miniGrid}
                {miniXAxis}
                <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number, name) => [Number(value).toFixed(0), name]}
                />
                <Line type="monotone" dataKey="connections" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="TCP" isAnimationActive={false} />
                <Line type="monotone" dataKey="connections_udp" stroke="var(--cyan-9)" dot={false} strokeWidth={2} name="UDP" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </LpMiniCard>

          <LpMiniCard
            title="进程数"
            value={lastPoint ? `${Number(lastPoint.process_count).toFixed(0)} 个` : '—'}
          >
            <ResponsiveContainer width="100%" height={miniChartHeight}>
              <LineChart data={chartRenderData} margin={miniChartMargin}>
                {miniGrid}
                {miniXAxis}
                <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number) => [Number(value).toFixed(0), '进程数']}
                />
                <Line type="monotone" dataKey="process_count" stroke="var(--accent-9)" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </LpMiniCard>

          <LpMiniCard
            title="CPU 负载"
            value={lastPoint ? formatLoadTriple(lastPoint.load, lastPoint.load5, lastPoint.load15) : '—'}
            note="1 / 5 / 15 分钟平均负载"
          >
            {!recordsLoading && !recordsError && !hasLoadData ? (
              <Flex align="center" justify="center" style={{ height: miniChartHeight }}>
                <Text role="status" color="gray">暂无 CPU 负载数据</Text>
              </Flex>
            ) : (
              <ResponsiveContainer width="100%" height={miniChartHeight}>
                <LineChart data={chartRenderData} margin={miniChartMargin}>
                  {miniGrid}
                  {miniXAxis}
                  <YAxis {...wideYAxisProps} domain={['auto', 'auto']} tickFormatter={(value) => Number(value).toFixed(1)} />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [Number(value).toFixed(2), name]}
                  />
                  <Line type="monotone" dataKey="load" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="1 分钟" connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="load5" stroke="var(--green-9)" dot={false} strokeWidth={2} name="5 分钟" connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="load15" stroke="var(--blue-9)" dot={false} strokeWidth={2} name="15 分钟" connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </LpMiniCard>

          {hasTempData && (
            <LpMiniCard
              title="温度"
              value={lastPoint?.temp !== null && lastPoint?.temp !== undefined ? `${Number(lastPoint.temp).toFixed(1)} °C` : '—'}
            >
              <ResponsiveContainer width="100%" height={miniChartHeight}>
                <LineChart data={chartRenderData} margin={miniChartMargin}>
                  {miniGrid}
                  {miniXAxis}
                  <YAxis
                    {...monitorYAxisProps}
                    domain={['auto', 'auto']}
                    tickFormatter={(value) => `${Number(value).toFixed(0)}°C`}
                  />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => [`${Number(value).toFixed(1)} °C`, '温度']}
                  />
                  <Line type="monotone" dataKey="temp_max" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                  <Line type="monotone" dataKey="temp_min" stroke="var(--accent-9)" strokeOpacity={0.28} dot={false} strokeWidth={1} isAnimationActive={false} />
                  <Line type="monotone" dataKey="temp" stroke="var(--accent-9)" dot={{ r: 2 }} connectNulls={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </LpMiniCard>
          )}

          {client.gpu_name && (
            <LpMiniCard
              title="GPU"
              value={lastGpuPoint ? `${Number(lastGpuPoint.utilization).toFixed(1)}%` : '—'}
            >
              {gpuLoading ? (
                <Flex align="center" justify="center" style={{ height: miniChartHeight }}>
                  <Text role="status" color="gray">正在加载 GPU 历史…</Text>
                </Flex>
              ) : !gpuError && gpuRecords.length === 0 ? (
                <Flex align="center" justify="center" style={{ height: miniChartHeight }}>
                  <Text role="status" color="gray">暂无 GPU 历史记录</Text>
                </Flex>
              ) : gpuError ? null : (
                <ResponsiveContainer width="100%" height={miniChartHeight}>
                  <LineChart data={gpuChartData} margin={miniChartMargin}>
                    {miniGrid}
                    {miniXAxis}
                    <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                    <Tooltip
                      {...chartTooltipProps}
                      labelFormatter={chartTimeFormatter}
                      formatter={(value: number, name) => [
                        `${Number(value).toFixed(1)}${name === '温度 °C' ? ' °C' : '%'}`,
                        name,
                      ]}
                    />
                    <Line type="monotone" dataKey="utilization" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="利用率 %" isAnimationActive={false} />
                    <Line type="monotone" dataKey="memory" stroke="var(--green-9)" dot={false} strokeWidth={2} name="显存 %" isAnimationActive={false} />
                    <Line type="monotone" dataKey="temp" stroke="var(--red-9)" dot={false} strokeWidth={2} name="温度 °C" isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </LpMiniCard>
          )}
        </div>
      </div>
      ) : (
      <div ref={pingSectionRef}>
      <Card mb="4" className="lp-inst-ping">
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <Text weight="bold">Ping 延迟</Text>
            {pingSeriesWithRecords.length > 0 && (
              <Text size="1" color="gray">
                测速点：{selectedPingTaskKeys.length === 0 ? '全部' : `${visiblePingSeries.length} 个已选`}
              </Text>
            )}
          </Flex>
          {pingSeries.length > 0 && (
            <Text size="1" color="gray">
              {pingSeriesWithRecords.length} / {pingSeries.length} 个任务有记录
            </Text>
          )}
        </Flex>

        {pingLoading ? (
          <Loading />
        ) : pingError ? (
          <Text size="2" color="red" align="center" style={{ display: 'block', padding: '20px' }}>
            {pingError}
          </Text>
        ) : pingSeries.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无 Ping 任务
          </Text>
        ) : pingChartRows.length === 0 || pingSeriesWithRecords.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无该节点的 Ping 记录
          </Text>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={pingChartHeight}>
              <LineChart data={pingChartRows} margin={monitorChartMargin}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={pingXAxisDomain}
                  tickFormatter={chartTimeFormatter}
                  fontSize={12}
                  minTickGap={28}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  {...pingYAxisProps}
                  domain={pingYAxisDomain}
                  allowDecimals={false}
                  tick={<PingYAxisTick />}
                />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number, name) => [
                    formatPingMs(value),
                    name,
                  ]}
                />
                {pingSeriesWithRecords.map((item) => (
                  <Line
                    key={item.task.key}
                    type="monotone"
                    dataKey={item.task.key}
                    name={item.task.label}
                    stroke={item.task.color}
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <div className="instance-ping-series-grid">
              {pingSeriesWithRecords.map((item) => {
                const p75 = getPingSeriesP75(item.records);
                const lossRate = getPingLossRate(item.records);
                const isSelected = selectedPingTaskKeys.length === 0 || selectedPingTaskKeySet.has(item.task.key);
                return (
                  <button
                    key={item.task.key}
                    type="button"
                    className={`instance-ping-series-item${isSelected ? ' is-selected' : ' is-unselected'}`}
                    aria-pressed={isSelected}
                    onClick={() => togglePingTask(item.task.key)}
                    style={{
                      borderColor: item.task.color,
                      background: `color-mix(in srgb, ${item.task.color} 9%, var(--color-panel-solid))`,
                    }}
                    title={`${item.task.type} ${item.task.target}`}
                  >
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: item.task.color,
                          flexShrink: 0,
                        }}
                      />
                      <Text size="1" weight="bold" truncate style={{ color: item.task.color }}>
                        {item.task.label}
                      </Text>
                    </Flex>
                    <Text
                      size="1"
                      color={lossRate !== null && lossRate >= 20 ? 'red' : lossRate !== null && lossRate > 0 ? 'amber' : 'gray'}
                      className="instance-ping-series-stat"
                    >
                      {p75 === null
                        ? '全部超时'
                        : `P75 ${formatPingMs(p75)} · 丢包 ${formatPingLossRate(lossRate)}`}
                    </Text>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Card>
      </div>
      )}

        </section>
      </div>
    </div>
  );
}

function LpInfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  const title = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return (
    <div className="lp-info-item">
      <dt className="lp-info-label">{label}</dt>
      <dd className="lp-info-value" title={title}>{value || '-'}</dd>
    </div>
  );
}

function LpMiniCard({ title, value, note, children }: { title: string; value: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="lp-mini-card" aria-label={title}>
      <header className="lp-mini-head">
        <span className="lp-mini-title">{title}</span>
        <span className="lp-mini-value" title={value}>{value}</span>
      </header>
      {note && <p className="lp-mini-note">{note}</p>}
      <div className="lp-mini-body">{children}</div>
    </section>
  );
}

function InstanceNodeSidebar({
  groups,
  activeUuid,
  onlineSet,
  statusReady,
  liveData,
  onSelect,
}: {
  groups: Array<{ group: string; nodes: ClientInfo[] }>;
  activeUuid: string;
  onlineSet: Set<string>;
  statusReady: boolean;
  liveData: Record<string, Partial<PublicMonitorRecord>>;
  onSelect: (uuid: string) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.nodes.length, 0);

  return (
    <aside className="instance-node-sidebar lp-inst-sidebar" aria-label="节点列表">
      <Card className="instance-node-sidebar-card lp-inst-sidebar-card">
        <Flex direction="column" style={{ height: '100%', minHeight: 0 }}>
          <Flex justify="between" align="center" className="instance-sidebar-header">
            <Box>
              <Text size="2" weight="bold" style={{ display: 'block' }}>节点列表</Text>
              <Text size="1" color="gray">{statusReady ? onlineSet.size : '—'} / {total} 在线</Text>
            </Box>
          </Flex>

          <Box className="instance-sidebar-scroll">
            {groups.map((group) => (
              <Box key={group.group}>
                <div className="instance-sidebar-group">
                  {group.group} ({group.nodes.length})
                </div>
                {group.nodes.map((node) => {
                  const isActive = node.uuid === activeUuid;
                  const isOnline = onlineSet.has(node.uuid);
                  const live = liveData[node.uuid];

                  return (
                    <button
                      key={node.uuid}
                      type="button"
                      className={`instance-sidebar-node${isActive ? ' is-active' : ''}`}
                      onClick={() => onSelect(node.uuid)}
                      title={node.name}
                    >
                      <span
                        className={`instance-sidebar-status${isOnline ? ' is-online' : statusReady ? ' is-offline' : ''}`}
                        aria-hidden="true"
                      />
                      <Flag region={node.region} size={16} />
                      <span className="instance-sidebar-node-main">
                        <span className="instance-sidebar-node-name">{node.name}</span>
                        <span className="instance-sidebar-node-meta">
                          {isOnline ? `CPU ${typeof live?.cpu === 'number' ? `${live.cpu.toFixed(0)}%` : '—'}` : statusReady ? '离线' : '确认中'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Flex>
      </Card>
    </aside>
  );
}
