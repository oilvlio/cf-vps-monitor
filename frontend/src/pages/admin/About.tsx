import { useState, useEffect } from 'react';
import { Activity, Bell, Cloud, Code2, Database, Github, Monitor, RefreshCw, ShieldCheck, Server, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';
import { Badge, Button, Card } from '../../components/ui/minimal';
import { useApi } from '../../contexts/AuthContext';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

interface HistoryMaintenanceStatus {
  checked_at: string;
  rollups: Record<string, {
    watermark: string | null;
    lag_seconds: number | null;
    dirty_buckets: number;
    oldest_dirty_at: string | null;
    oldest_dirty_age_seconds: number | null;
  }>;
  partitions: Record<string, {
    min_start: string | null;
    max_end: string | null;
    runway_seconds: number | null;
    gate_family: string | null;
    gate_watermark: string | null;
    gate_clearance_seconds: number | null;
  }>;
  partition_maintenance: {
    updated_at: string | null;
    pending_partitions: number;
    lock_timeouts: number;
  };
}

const FAMILY_LABELS: Record<string, string> = { host: 'Host', ping: 'Ping' };
const PARTITION_LABELS: Record<string, string> = {
  'public.records': 'Host 原始',
  'public.ping_snapshots': 'Ping 原始',
  'public.host_rollup': 'Host 汇总',
  'public.ping_rollup': 'Ping 汇总',
};

function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 0) return `已过期 ${formatAge(-seconds)}`;
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

function formatGateClearance(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  return seconds >= 0 ? `已越过 ${formatAge(seconds)}` : `还差 ${formatAge(-seconds)}`;
}

function formatInstant(value: string | null): string {
  if (!value) return '尚无记录';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '未知';
}

const stackItems = [
  { icon: Cloud, title: 'Cloudflare Workers', text: 'API 入口、前端托管与部署运行时' },
  { icon: Zap, title: 'Durable Objects', text: '实时数据、WebSocket 与在线状态协调' },
  { icon: Database, title: 'Supabase HTTP API', text: '配置、历史记录与审计日志' },
  { icon: Code2, title: 'Hono + TypeScript', text: 'Worker 后端路由、鉴权与接口校验' },
  { icon: Monitor, title: 'React + Radix UI', text: '后台管理、公开状态页与图表展示' },
  { icon: Server, title: 'Go Agent', text: 'VPS 端采集、Ping、网站探测与上报' },
];

const coreFeatures = [
  '实时 CPU / 内存 / 磁盘 / 网络监控',
  '节点温度：支持 Linux CPU/SoC 传感器；无有效读数时显示不可用',
  '流量按节点重置日逐月统计，重启不影响累计',
  '自定义 Ping 任务与延迟图表',
  '公开状态页，支持 monitor / aurora 主题',
  '节点标签、分组、排序、对游客隐藏；价格字段由服务端公开下发，主题自行控制展示',
];

const opsFeatures = [
  'Telegram / Email / Webhook 告警',
  '离线、到期、负载阈值与 IP 变更通知',
  '后台一键安装命令生成',
  '站点 Logo 上传与主题配置',
  '审计日志、健康检查与双重身份验证',
];

function FeatureList({ items }: { items: string[] }) {
  return (
    <div className="sa-about-features">
      {items.map((feature) => (
        <div key={feature} className="sa-about-feature">
          <span className="sa-about-dot" aria-hidden="true" />
          <span>{feature}</span>
        </div>
      ))}
    </div>
  );
}

export default function AdminAbout() {
  const apiFetch = useApi();
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [history, setHistory] = useState<HistoryMaintenanceStatus | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refreshHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await apiFetch('/admin/health?deep=1');
      if (!response.history_maintenance) throw new Error('健康接口没有返回历史维护状态');
      setHistory(response.history_maintenance as HistoryMaintenanceStatus);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '读取历史维护状态失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => { void refreshHistory(); }, []);

  const displayedHash = version?.hash && version.hash !== 'dev' ? version.hash : '未记录';
  const openExternal = (url: string | null | undefined) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="sa-scope sa-page">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <Monitor size={20} />
          <span>关于</span>
        </div>
      </div>

      <Card>
        <div className="sa-card-body">
          <div className="sa-about-hero">
            <div className="sa-about-logo">
              <Monitor size={34} aria-hidden="true" />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 className="sa-about-title">CF VPS Monitor</h2>
              <p className="sa-about-subtitle">基于 Cloudflare Workers 的轻量 VPS 探针与公开状态页</p>
              <div className="sa-about-badges">
                <Badge variant="info">{formatAppVersion(version?.version)}</Badge>
                <Badge variant="secondary">{displayedHash}</Badge>
                <Badge variant="success">Cloudflare Workers</Badge>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => openExternal('https://github.com/kadidalax/cf-vps-monitor')}
              aria-label="在 GitHub 打开项目"
            >
              <Github size={16} /> GitHub
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="sa-card-body">
          <div className="admin-parent-title-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <h3 className="sa-card-title">历史存储健康</h3>
              <p className="sa-card-description">汇总水位线、待重算脏桶和分区保留余量</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refreshHistory()} disabled={historyLoading}>
              <RefreshCw size={15} /> {historyLoading ? '刷新中…' : '刷新'}
            </Button>
          </div>
          {historyError && <p className="sa-muted" role="alert">读取失败：{historyError}</p>}
          {history && <>
            <p className="sa-muted">数据检查时间：{formatInstant(history.checked_at)}；分区维护：{formatInstant(history.partition_maintenance.updated_at)}；
              因锁超时推迟 {history.partition_maintenance.pending_partitions} 个分区（{history.partition_maintenance.lock_timeouts} 次）；
              最近维护时间指最后一次成功取得维护锁的运行。
            </p>
            <div className="sa-about-stack">
              {Object.entries(history.rollups).map(([family, state]) => (
                <div key={family} className="sa-about-stack-item">
                  <span className="sa-about-stack-icon"><Activity size={16} aria-hidden="true" /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{FAMILY_LABELS[family] || family} rollup</div>
                    <div className="sa-muted" style={{ fontSize: 12.5 }}>
                      水位线 {formatInstant(state.watermark)} · 延迟 {formatAge(state.lag_seconds)} · 脏桶 {state.dirty_buckets}
                      {state.oldest_dirty_at ? ` · 最老积压 ${formatAge(state.oldest_dirty_age_seconds)}` : ''}
                    </div>
                  </div>
                  <Badge variant={state.dirty_buckets > 0 || (state.lag_seconds ?? 0) > 7200 ? 'warning' : 'success'}>
                    {state.dirty_buckets > 0 ? '有积压' : '正常'}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="sa-about-stack" style={{ marginTop: 12 }}>
              {Object.entries(history.partitions).map(([parent, state]) => (
                <div key={parent} className="sa-about-stack-item">
                  <span className="sa-about-stack-icon"><Database size={16} aria-hidden="true" /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{PARTITION_LABELS[parent] || parent}</div>
                    <div className="sa-muted" style={{ fontSize: 12.5 }}>
                      分区上界余量 {formatAge(state.runway_seconds)}
                      {state.gate_family ? ` · ${FAMILY_LABELS[state.gate_family] || state.gate_family} 水位门限 ${formatGateClearance(state.gate_clearance_seconds)}` : ''}
                    </div>
                  </div>
                  <Badge variant={state.runway_seconds !== null && state.runway_seconds < 0 ? 'warning' : 'secondary'}>
                    {state.runway_seconds !== null && state.runway_seconds < 0 ? '上界已过期' : '分区范围'}
                  </Badge>
                </div>
              ))}
            </div>
          </>}
          {!history && !historyError && <p className="sa-muted">{historyLoading ? '正在读取历史维护状态…' : '暂无状态'}</p>}
        </div>
      </Card>

      <Card>
        <div className="sa-card-body">
          <h3 className="sa-card-title">技术架构</h3>
          <div className="sa-about-stack">
            {stackItems.map(({ icon: Icon, title, text }) => (
              <div key={title} className="sa-about-stack-item">
                <span className="sa-about-stack-icon"><Icon size={16} aria-hidden="true" /></span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{title}</div>
                  <div className="sa-muted" style={{ fontSize: 12.5 }}>{text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="sa-about-columns">
        <Card>
          <div className="sa-card-body">
            <h3 className="sa-card-title sa-about-feature-title">
              <Activity size={16} aria-hidden="true" /> 核心能力
            </h3>
            <FeatureList items={coreFeatures} />
          </div>
        </Card>

        <Card>
          <div className="sa-card-body">
            <h3 className="sa-card-title sa-about-feature-title">
              <Bell size={16} aria-hidden="true" /> 运维能力
            </h3>
            <FeatureList items={opsFeatures} />
          </div>
        </Card>
      </div>

      <Card>
        <div className="sa-card-body">
          <h3 className="sa-card-title sa-about-feature-title">
            <ShieldCheck size={16} aria-hidden="true" /> 项目定位
          </h3>
          <p className="sa-about-text">
            面向个人和小团队的自托管 VPS 监控面板，优先追求轻量部署、公开状态展示、低维护成本和 Cloudflare 免费生态友好。
            适合轻量 VPS 探针、公开服务状态页、节点资产管理、基础告警与日常运维巡检。
          </p>
        </div>
      </Card>
    </div>
  );
}
