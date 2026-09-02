export interface MonitorHistoryRecord {
  time: string;
  cpu?: number;
  ram?: number;
  ram_total?: number;
  disk?: number;
  disk_total?: number;
  net_in?: number;
  net_out?: number;
  temp?: number;
  connections?: number;
  connections_udp?: number;
  process_count?: number;
}

export interface MonitorChartPoint {
  time: number;
  cpu: number;
  ram: number;
  disk: number;
  net_in: number;
  net_out: number;
  temp: number;
  connections: number;
  connections_udp: number;
  process_count: number;
  cpu_min?: number; cpu_max?: number; ram_min?: number; ram_max?: number; disk_min?: number; disk_max?: number; temp_min?: number; temp_max?: number;
}

const emptyMetricValues = {
  cpu: 0,
  ram: 0,
  disk: 0,
  net_in: 0,
  net_out: 0,
  temp: 0,
  connections: 0,
  connections_udp: 0,
  process_count: 0,
};

export function buildMonitorChartData(records: MonitorHistoryRecord[]): MonitorChartPoint[] {
  return records.map((record) => {
    const raw = record as MonitorHistoryRecord & { _min?: Record<string, number>; _max?: Record<string, number> };
    return {
    time: new Date(record.time).getTime(),
    cpu: Number((record.cpu || 0).toFixed(2)),
    ram: record.ram_total && record.ram_total > 0
      ? Number((((record.ram || 0) / record.ram_total) * 100).toFixed(1))
      : 0,
    net_in: record.net_in || 0,
    net_out: record.net_out || 0,
    temp: record.temp || 0,
    disk: record.disk_total && record.disk_total > 0
      ? Number((((record.disk || 0) / record.disk_total) * 100).toFixed(1))
      : 0,
    connections: record.connections || 0,
    connections_udp: record.connections_udp || 0,
    process_count: record.process_count || 0,
      cpu_min: raw._min?.cpu, cpu_max: raw._max?.cpu,
      ram_min: raw._min?.ram !== undefined && record.ram_total ? (raw._min.ram / record.ram_total) * 100 : undefined,
      ram_max: raw._max?.ram !== undefined && record.ram_total ? (raw._max.ram / record.ram_total) * 100 : undefined,
      disk_min: raw._min?.disk !== undefined && record.disk_total ? (raw._min.disk / record.disk_total) * 100 : undefined,
      disk_max: raw._max?.disk !== undefined && record.disk_total ? (raw._max.disk / record.disk_total) * 100 : undefined,
      temp_min: raw._min?.temp, temp_max: raw._max?.temp,
    };
  });
}

export function buildMonitorChartAxisData(rangeMs: number, now = Date.now()): MonitorChartPoint[] {
  const end = Number.isFinite(now) ? now : Date.now();
  const start = end - Math.max(rangeMs, 1);

  return [
    { time: start, ...emptyMetricValues },
    { time: end, ...emptyMetricValues },
  ];
}

export function getMonitorChartRenderData(
  chartData: MonitorChartPoint[],
  rangeMs: number,
  now = Date.now(),
): MonitorChartPoint[] {
  return chartData.length > 0 ? chartData : buildMonitorChartAxisData(rangeMs, now);
}
