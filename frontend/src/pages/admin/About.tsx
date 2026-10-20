import { useState, useEffect } from 'react';
import { Flex, Card, Text, Heading, Badge, Grid, Box, Button, Tabs } from '@radix-ui/themes';
import { Activity, Bell, Cloud, Code2, Database, Github, Monitor, ShieldCheck, Server, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';

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
  '网站监控，支持 Worker / Agent 检测',
  '公开状态页，支持 monitor / aurora 主题',
  '节点标签、分组、排序、对游客隐藏',
];

const opsFeatures = [
  'Telegram / Email 告警',
  '离线、到期、负载阈值通知',
  '后台一键安装命令生成',
  '站点 Logo 上传与主题配置',
  '加密备份与恢复',
  '审计日志、容量估算、健康检查',
];

function FeatureList({ items }: { items: string[] }) {
  return (
    <Grid columns={{ initial: '1', sm: '2' }} gap="2" mt="3">
      {items.map((feature) => (
        <Flex key={feature} align="start" gap="2" className="admin-about-feature-item">
          <Box className="admin-about-dot" />
          <Text size="2">{feature}</Text>
        </Flex>
      ))}
    </Grid>
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
    <div className="admin-about-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Monitor size={20} />
          <Heading size="5">关于</Heading>
        </Flex>
      </Flex>

      <Tabs.Root defaultValue="overview" className="admin-about-tabs">
        <Tabs.List>
          <Tabs.Trigger value="overview">项目概览</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview">
          <Flex direction="column" gap="3" mt="3">
            <Card className="admin-about-card admin-about-card-full">
              <Flex className="admin-about-hero" align="center" gap="4">
                <Box className="admin-about-logo">
                  <Monitor size={40} color="white" />
                </Box>
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Heading size="6">CF VPS Monitor</Heading>
                  <Text as="p" size="2" color="gray" mt="1">基于 Cloudflare Workers 的轻量 VPS 探针与公开状态页</Text>
                  <Flex gap="2" wrap="wrap" mt="2">
                    <Badge size="2" color="blue">{formatAppVersion(version?.version)}</Badge>
                    <Badge size="2" variant="soft" color="gray">{displayedHash}</Badge>
                    <Badge size="2" variant="soft" color="green">Cloudflare Workers</Badge>
                  </Flex>
                </Box>
                <Button variant="soft" onClick={() => openExternal('https://github.com/kadidalax/cf-vps-monitor')} aria-label="GitHub">
                  <Github size={16} />
                </Button>
              </Flex>
            </Card>

            <Card className="admin-about-card admin-about-card-full">
              <Heading size="3">技术架构</Heading>
              <Grid columns={{ initial: '1', sm: '2', lg: '3' }} gap="3" mt="3">
                {stackItems.map(({ icon: Icon, title, text }) => (
                  <Flex key={title} className="admin-about-stack-item" gap="2" align="center">
                    <Box className="admin-about-stack-icon"><Icon size={16} /></Box>
                    <Box style={{ minWidth: 0 }}>
                      <Text as="div" size="2" weight="bold">{title}</Text>
                      <Text as="div" size="1" color="gray">{text}</Text>
                    </Box>
                  </Flex>
                ))}
              </Grid>
            </Card>

            <Grid columns={{ initial: '1', md: '2' }} gap="3">
              <Card className="admin-about-card admin-about-card-full">
                <Flex align="center" gap="2">
                  <Activity size={18} color="var(--accent-9)" />
                  <Heading size="3">核心能力</Heading>
                </Flex>
                <FeatureList items={coreFeatures} />
              </Card>

              <Card className="admin-about-card admin-about-card-full">
                <Flex align="center" gap="2">
                  <Bell size={18} color="var(--accent-9)" />
                  <Heading size="3">运维能力</Heading>
                </Flex>
                <FeatureList items={opsFeatures} />
              </Card>
            </Grid>

            <Card className="admin-about-card admin-about-card-full">
              <Flex align="center" gap="2" mb="2">
                <ShieldCheck size={18} color="var(--accent-9)" />
                <Heading size="3">项目定位</Heading>
              </Flex>
              <Text size="2" color="gray" className="admin-about-position">
                面向个人和小团队的自托管 VPS 监控面板，优先追求轻量部署、公开状态展示、低维护成本和 Cloudflare 免费生态友好。
                适合轻量 VPS 探针、公开服务状态页、节点资产管理、基础告警与日常运维巡检。
              </Text>
            </Card>
          </Flex>
        </Tabs.Content>

      </Tabs.Root>
    </div>
  );
}
