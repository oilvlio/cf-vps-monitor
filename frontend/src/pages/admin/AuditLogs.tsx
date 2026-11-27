import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollText, Search, Shield, Clock3, User, FileText } from 'lucide-react';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { formatAuditLogDetailText, formatAuditLogRawDetailText, getAuditLogDetailText } from '../../utils/audit-log';
import { AuditLogEntry, normalizeAuditLogsPage } from '../../utils/audit-log-response';
import {
  Badge,
  Button,
  Card,
  Dialog,
  StatGrid,
} from '../../components/ui/minimal';

type BadgeVariant = 'secondary' | 'outline' | 'warning' | 'success' | 'danger' | 'info';

const actionLabels: Record<string, { label: string; variant: BadgeVariant }> = {
  login: { label: '登录', variant: 'success' },
  login_failed: { label: '登录失败', variant: 'warning' },
  account_username_edit: { label: '修改用户名', variant: 'warning' },
  client_add: { label: '添加服务器', variant: 'info' },
  client_edit: { label: '编辑服务器', variant: 'info' },
  client_remove: { label: '删除服务器', variant: 'danger' },
  client_batch_hide: { label: '批量隐藏服务器', variant: 'warning' },
  client_batch_remove: { label: '批量删除服务器', variant: 'danger' },
  client_reorder: { label: '调整服务器排序', variant: 'secondary' },
  client_token_rotate: { label: '重置服务器 Token', variant: 'warning' },
  chpasswd: { label: '修改密码', variant: 'warning' },
  agent_token_source_ip_change: { label: 'Token 来源变化', variant: 'warning' },
  ip_change: { label: 'IP 变更', variant: 'warning' },
  settings_save: { label: '保存设置', variant: 'info' },
  settings_edit: { label: '修改设置', variant: 'info' },
  ping_add: { label: '添加 Ping', variant: 'info' },
  ping_edit: { label: '编辑 Ping', variant: 'info' },
  ping_assign: { label: '分配 Ping', variant: 'info' },
  ping_delete: { label: '删除 Ping', variant: 'danger' },
  ping_reorder: { label: '调整 Ping 排序', variant: 'secondary' },
  offline_notification_edit: { label: '离线通知', variant: 'warning' },
  load_notification_add: { label: '负载通知', variant: 'info' },
  load_notification_edit: { label: '编辑负载', variant: 'info' },
  load_notification_delete: { label: '删除负载', variant: 'danger' },
  record_clear: { label: '清除记录', variant: 'danger' },
  record_clear_all: { label: '清除全部', variant: 'danger' },
  maintenance_cleanup: { label: '手动维护清理', variant: 'secondary' },
  maintenance_cleanup_error: { label: '手动维护清理失败', variant: 'danger' },
  cron_cleanup: { label: '定时清理', variant: 'secondary' },
  cron_cleanup_error: { label: '定时清理失败', variant: 'danger' },
  cron_load: { label: '负载告警检查', variant: 'secondary' },
  cron_load_error: { label: '负载告警检查失败', variant: 'danger' },
  cron_offline: { label: '离线告警检查', variant: 'secondary' },
  cron_offline_error: { label: '离线告警检查失败', variant: 'danger' },
  cron_expiry: { label: '到期提醒检查', variant: 'secondary' },
  cron_expiry_error: { label: '到期提醒检查失败', variant: 'danger' },
  cron_rollup: { label: '历史分桶', variant: 'secondary' },
  cron_rollup_error: { label: '历史分桶失败', variant: 'danger' },
  cron_rollup_degraded: { label: '历史分桶降级', variant: 'warning' },
  cron_ping_rollup_error: { label: '历史分桶失败', variant: 'danger' },
  offline_notify: { label: '离线告警', variant: 'danger' },
  online_notify: { label: '恢复上线', variant: 'success' },
  expiry_notify: { label: '到期提醒', variant: 'warning' },
  load_notify: { label: '负载告警', variant: 'warning' },
  offline_check_skipped: { label: '跳过离线检查', variant: 'warning' },
  init: { label: '系统初始化', variant: 'secondary' },
  mfa_enabled: { label: '启用双重验证', variant: 'warning' },
  mfa_disabled: { label: '关闭双重验证', variant: 'warning' },
  mfa_recovery_codes_regenerated: { label: '重新生成恢复码', variant: 'warning' },
  mfa_step_up: { label: '敏感操作二次确认', variant: 'info' },
  csrf_rejected: { label: '拒绝 CSRF 请求', variant: 'warning' },
  admin_recovery: { label: '管理员账号恢复', variant: 'warning' },
  agent_policy_error: { label: 'Agent 策略错误', variant: 'danger' },
  do_agent_policy_background_error: { label: 'Agent 策略后台错误', variant: 'danger' },
  do_live_network_metadata_background_error: { label: '实时网络信息后台错误', variant: 'danger' },
  do_record_persistence_background_error: { label: '记录持久化后台错误', variant: 'danger' },
  do_viewer_expiry_background_error: { label: '查看器过期后台错误', variant: 'danger' },
  ping_persistence_background_error: { label: 'Ping 持久化后台错误', variant: 'danger' },
  traffic_error: { label: '流量统计错误', variant: 'danger' },
  do_basic_info_sync_error: { label: '基础信息同步错误', variant: 'danger' },
  do_record_persistence_error: { label: '记录持久化错误', variant: 'danger' },
  do_record_capacity_error: { label: '记录容量检查错误', variant: 'danger' },
  do_record_capacity_high_watermark: { label: '记录容量接近上限', variant: 'warning' },
  ping_persistence_error: { label: 'Ping 持久化错误', variant: 'danger' },
  telegram_error: { label: 'Telegram 通知错误', variant: 'danger' },
  email_error: { label: '邮件通知错误', variant: 'danger' },
  webhook_error: { label: 'Webhook 通知错误', variant: 'danger' },
  notification_error: { label: '通知发送错误', variant: 'danger' },
  theme_upload: { label: '上传主题', variant: 'info' },
  theme_set: { label: '启用主题', variant: 'info' },
  theme_settings: { label: '配置主题', variant: 'info' },
  theme_delete: { label: '删除主题', variant: 'danger' },
  third_party_theme_update: { label: '更新第三方主题', variant: 'info' },
  cfsm_ping_map_update: { label: '更新 Ping 地图', variant: 'info' },
  cfsm_theme_update: { label: '更新站点主题', variant: 'info' },
};

// 旧版本写入的动作名可能用空格或连字符分隔，统一成下划线后再查表。
function normalizeActionKey(action: string) {
  return action.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function actionInfo(action?: string | null) {
  if (!action) return { label: '-', variant: 'secondary' as BadgeVariant };
  return actionLabels[action]
    || actionLabels[normalizeActionKey(action)]
    || { label: action, variant: 'secondary' as BadgeVariant };
}

function SummaryCards({ logs }: { logs: AuditLogEntry[] }) {
  const userCount = new Set(logs.map((log) => log.user).filter(Boolean)).size;
  const highRiskCount = logs.filter((log) =>
    ['client_remove', 'record_clear', 'record_clear_all', 'ping_delete'].includes(log.action || ''),
  ).length;
  const todayCount = logs.filter((log) => {
    const now = new Date();
    const date = new Date(log.time);
    return now.toDateString() === date.toDateString();
  }).length;

  return (
    <StatGrid
      label="审计日志概览"
      items={[
        { label: '当前页日志', value: String(logs.length), icon: <FileText /> },
        { label: '活跃用户', value: String(userCount), icon: <User /> },
        { label: '今日操作', value: String(todayCount), icon: <Clock3 /> },
        { label: '高风险动作', value: String(highRiskCount), icon: <Shield /> },
      ]}
    />
  );
}

export default function AdminAuditLogs() {
  const apiFetch = useApi();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [knownActions, setKnownActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // 首次加载前整页显示 Loading；之后的翻页 / 筛选只让表格变淡，
  // 不能再卸载整页，否则正在输入的搜索框会失去焦点。
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [filter, setFilter] = useState('all');
  // searchInput 是输入框里的即时内容；search 是防抖后真正发给后端的关键词。
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('50');
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      setSearch(value.trim());
    }, 300);
  };

  const handleFilterChange = (value: string) => {
    setPage(1);
    setFilter(value);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: pageSize, page: String(page) });
    if (filter !== 'all') params.set('action', filter);
    if (search) params.set('search', search);
    apiFetch(`/admin/logs?${params.toString()}`)
      .then(data => {
        if (cancelled) return;
        const pageData = normalizeAuditLogsPage(data);
        setLogs(pageData.logs);
        setTotal(pageData.total);
        setHasMore(pageData.hasMore);
        setKnownActions(pageData.actions);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setLogs([]);
        setTotal(0);
        setHasMore(false);
        setError(loadError instanceof Error ? loadError.message : '审计日志加载失败');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setInitialLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, page, pageSize, filter, search]);

  // 下拉框候选项来自后端的全表动作列表；当前选中的动作即使暂时不在列表里也要保留，避免下拉框显示空白。
  const actionOptions = useMemo(() => {
    const set = new Set(knownActions);
    if (filter !== 'all') set.add(filter);
    return Array.from(set).sort((a, b) => actionInfo(a).label.localeCompare(actionInfo(b).label, 'zh-CN'));
  }, [knownActions, filter]);

  const isFiltering = filter !== 'all' || search !== '';
  const knownPages = Math.max(page, Math.ceil(total / Number(pageSize || 50)));
  const pageLabel = hasMore ? `第 ${page} 页，至少 ${total} 条` : `第 ${page} / ${knownPages} 页，共 ${total} 条`;
  const resultLabel = hasMore ? `匹配 至少 ${total} 条` : `匹配 ${total} 条`;

  if (!initialLoaded && loading) return <Loading />;

  return (
    <div className="sa-scope sa-page">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <ScrollText size={20} />
          <span>审计日志</span>
        </div>
      </div>

      <SummaryCards logs={logs} />

      {error && (
        <div className="sa-alert" role="alert">
          <span>审计日志加载失败：{error}</span>
        </div>
      )}

      <Card>
        <div className="sa-toolbar">
          <div className="sa-toolbar-group">
            <div className="sa-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="sa-input"
                placeholder="搜索 ID、用户、动作、详情..."
                aria-label="搜索日志"
                value={searchInput}
                onChange={(event) => handleSearchChange(event.target.value)}
              />
            </div>
            <select
              className="sa-input sa-select"
              aria-label="操作类型筛选"
              value={filter}
              onChange={(event) => handleFilterChange(event.target.value)}
            >
              <option value="all">全部操作</option>
              {actionOptions.map(action => (
                <option key={action} value={action}>{actionInfo(action).label}</option>
              ))}
            </select>
            <select
              className="sa-input sa-select"
              aria-label="每页条数"
              value={pageSize}
              onChange={(event) => { setPage(1); setPageSize(event.target.value); }}
            >
              <option value="20">每页 20 条</option>
              <option value="50">每页 50 条</option>
              <option value="100">每页 100 条</option>
            </select>
          </div>
          <div className="sa-toolbar-group">
            {isFiltering && <Badge variant="info">{resultLabel}</Badge>}
          </div>
        </div>

        <div className="sa-table-scroll" aria-busy={loading} style={loading ? { opacity: 0.55, transition: 'opacity 120ms' } : undefined}>
          <table className="sa-table">
            <thead>
              <tr>
                <th className="sa-col-md" style={{ width: 84 }}>ID</th>
                <th style={{ width: 170 }}>时间</th>
                <th style={{ width: 120 }}>用户</th>
                <th style={{ width: 150 }}>操作</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="sa-empty">
                    {isFiltering ? '没有匹配的日志' : '暂无日志记录'}
                  </td>
                </tr>
              ) : (
                logs.map(log => {
                  const info = actionInfo(log.action);
                  return (
                    <tr className="sa-tr" key={log.id}>
                      <td className="sa-col-md">
                        <Button variant="outline" size="sm" onClick={() => setSelectedLog(log)} aria-label={`查看日志 ${log.id}`}>
                          {log.id}
                        </Button>
                      </td>
                      <td><span className="sa-mono sa-muted">{new Date(log.time).toLocaleString('zh-CN')}</span></td>
                      <td>{log.user || '-'}</td>
                      <td><Badge variant={info.variant}>{info.label}</Badge></td>
                      <td>
                        <button
                          type="button"
                          className="sa-clamp"
                          onClick={() => setSelectedLog(log)}
                          title="查看完整详情"
                          aria-label={`查看日志 ${log.id} 完整详情`}
                        >
                          {getAuditLogDetailText(log.detail)}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="sa-table-footer sa-table-footer-row">
          <span>{pageLabel}</span>
          <div className="sa-toolbar-group">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <Button variant="outline" size="sm" disabled={!hasMore || loading} onClick={() => setPage((value) => value + 1)}>
              下一页
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={Boolean(selectedLog)}
        onOpenChange={(open) => { if (!open) setSelectedLog(null); }}
        size="lg"
        title="日志详情"
        footer={<Button variant="outline" onClick={() => setSelectedLog(null)}>关闭</Button>}
      >
        {selectedLog && (() => {
          const info = actionInfo(selectedLog.action);
          const detailText = formatAuditLogDetailText(selectedLog.detail);
          const rawDetailText = formatAuditLogRawDetailText(selectedLog.detail);
          const showRawDetail = rawDetailText !== '-' && rawDetailText !== detailText;
          return (
            <div className="sa-detail-stack">
              <div className="sa-detail-meta">
                <Badge variant={info.variant}>{info.label}</Badge>
                <span className="sa-muted sa-mono">{new Date(selectedLog.time).toLocaleString('zh-CN')}</span>
              </div>
              <div className="sa-kv">
                <div className="sa-kv-row"><span className="sa-kv-label">ID</span><span className="sa-kv-value">{selectedLog.id}</span></div>
                <div className="sa-kv-row"><span className="sa-kv-label">用户</span><span className="sa-kv-value">{selectedLog.user || '-'}</span></div>
                <div className="sa-kv-row"><span className="sa-kv-label">级别</span><span className="sa-kv-value">{selectedLog.level || 'info'}</span></div>
                <div className="sa-kv-row">
                  <span className="sa-kv-label">动作</span>
                  <span className="sa-kv-value">
                    {info.label}
                    {selectedLog.action && selectedLog.action !== info.label && (
                      <span className="sa-muted sa-mono"> ({selectedLog.action})</span>
                    )}
                  </span>
                </div>
              </div>
              <div>
                <div className="sa-form-label">详情</div>
                <pre className="sa-code-block sa-pre">{detailText}</pre>
              </div>
              {showRawDetail && (
                <div>
                  <div className="sa-form-label">原始详情</div>
                  <pre className="sa-code-block sa-pre">{rawDetailText}</pre>
                </div>
              )}
            </div>
          );
        })()}
      </Dialog>
    </div>
  );
}
