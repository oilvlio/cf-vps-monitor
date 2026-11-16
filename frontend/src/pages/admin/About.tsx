import { useState, useEffect } from 'react';
import { Activity, Bell, Cloud, Code2, Database, Github, Monitor, ShieldCheck, Server, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';
import { Badge, Button, Card } from '../../components/ui/minimal';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

const stackItems = [
  { icon: Cloud, title: 'Cloudflare Workers', text: 'API 入口、前端托管与部署运行时' },
  { icon: Zap, title: 'Durable Objects', text: '实时数据、WebSocket 与在线状态协调' },
  { icon: Database, title: 'Supabase HTTP API', text: '配置、历史记录、备份与审计日志' },
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
  '加密备份与恢复',
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
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

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
