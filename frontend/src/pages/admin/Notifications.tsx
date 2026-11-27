import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, Pencil, Plus, Save, Search, Send, Trash2, TrendingUp,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useAdminAction } from '../../hooks/useAdminAction';
import { SettingRow, SettingTextarea } from '../../components/admin/SettingCard';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CollapsibleCard,
  Dialog,
  Field,
  FormInput,
  FormSelect,
  FormSwitch,
  Notice,
  Rows,
  Segmented,
  SelectField,
  Switch,
} from '../../components/ui/minimal';
import { summarizeSelectionValue } from '../../utils/batchPrefill';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';

const notificationTabValues = ['settings', 'offline', 'expiry', 'load', 'ipchange'] as const;

/**
 * 默认离线通知宽限期（秒）。
 * 取 360 而非更短值，是为了给「上报间隔 120 秒」留足余量：落库节流最坏情况下
 * last_time 会拉开到约两倍上报间隔，宽限期过短会在链路正常时误报离线。
 * 需与 worker 侧 `DEFAULT_OFFLINE_GRACE_PERIOD_SEC` 保持一致。
 */
const DEFAULT_GRACE_PERIOD_SEC = 360;

/** 默认到期提前提醒天数。 */
const DEFAULT_EXPIRY_ADVANCE_DAYS = 7;
type NotificationTab = typeof notificationTabValues[number];
type NotificationClient = {
  uuid: string;
  name?: string;
  ipv4?: string;
  ipv6?: string;
  region?: string;
  expired_at?: string;
};
type OfflineNotification = {
  client: string;
  enable?: boolean;
  grace_period?: number;
  last_notified?: string | null;
};
type ExpiryNotification = {
  client: string;
  enable?: boolean;
  advance_days?: number;
  last_notified?: string | null;
};
type IpChangeNotification = {
  client: string;
  enable?: boolean;
};
type LoadNotification = {
  id: number;
  name?: string;
  metric?: string;
  threshold?: number;
  ratio?: number;
  interval_min?: number;
  clients?: string[];
  all_clients?: boolean;
};
type LoadNotificationForm = Partial<LoadNotification> & {
  clients?: string[];
  all_clients?: boolean;
};
const emptyTabState: Record<NotificationTab, boolean> = {
  settings: false,
  offline: false,
  expiry: false,
  load: false,
  ipchange: false,
};

const loadMetricLabels: Record<string, string> = {
  cpu: 'CPU',
  ram: '内存',
  load: '负载',
  disk: '磁盘',
  temp: '温度',
};

const loadMetricOptions = [
  { value: 'cpu', label: 'CPU 使用率' },
  { value: 'ram', label: '内存使用率' },
  { value: 'load', label: '系统负载' },
  { value: 'disk', label: '磁盘使用率' },
  { value: 'temp', label: '温度' },
];

function toNotificationTab(value?: string): NotificationTab {
  return notificationTabValues.includes(value as NotificationTab) ? value as NotificationTab : 'settings';
}

function clientDisplayIp(client: NotificationClient) {
  return client.ipv4 || client.ipv6 || '';
}

function loadMetricUnit(metric?: string): string {
  if (metric === 'temp') return '°C';
  if (metric === 'load') return '';
  return '%';
}

function formatLastNotified(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (date.getFullYear() < 2000) return '从未触发';
  return date.toLocaleString('zh-CN');
}

export default function AdminNotifications() {
  const apiFetch = useApi();
  const { run: runAction, pendingActions } = useAdminAction();
  const navigate = useNavigate();
  const { tab: urlTab } = useParams<{ tab?: string }>();
  const initialTab = toNotificationTab(urlTab);
  const [activeTab, setActiveTab] = useState<NotificationTab>(initialTab);
  const [tabLoading, setTabLoading] = useState<Record<NotificationTab, boolean>>({
    ...emptyTabState,
    [initialTab]: true,
  });
  const [loadedTabs, setLoadedTabs] = useState<Record<NotificationTab, boolean>>(emptyTabState);
  const [offlineNotifications, setOfflineNotifications] = useState<OfflineNotification[]>([]);
  const [expiryNotifications, setExpiryNotifications] = useState<ExpiryNotification[]>([]);
  const [ipChangeNotifications, setIpChangeNotifications] = useState<IpChangeNotification[]>([]);
  const [clients, setClients] = useState<NotificationClient[]>([]);
  const [loadNotifications, setLoadNotifications] = useState<LoadNotification[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  // 渠道卡片默认收起（对齐 Monitor 默认主题）；展开状态放在页面级，切换页签不会丢。
  const [channelOpen, setChannelOpen] = useState<Record<'email' | 'telegram' | 'webhook', boolean>>({ email: false, telegram: false, webhook: false });
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testWebhookSending, setTestWebhookSending] = useState(false);
  const clientsRef = useRef<NotificationClient[]>([]);
  const clientsLoadedRef = useRef(false);
  const clientsLoadPromiseRef = useRef<Promise<NotificationClient[]> | null>(null);

  // Offline tab state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchForm, setBatchForm] = useState({ enable: true, grace_period: DEFAULT_GRACE_PERIOD_SEC });
  const [batchGraceMixed, setBatchGraceMixed] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingOffline, setEditingOffline] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ enable: false, grace_period: DEFAULT_GRACE_PERIOD_SEC });
  const [expiryBatchDialogOpen, setExpiryBatchDialogOpen] = useState(false);
  const [expiryBatchForm, setExpiryBatchForm] = useState({ enable: true, advance_days: DEFAULT_EXPIRY_ADVANCE_DAYS });
  const [expiryBatchDaysMixed, setExpiryBatchDaysMixed] = useState(false);
  const [expiryEditDialogOpen, setExpiryEditDialogOpen] = useState(false);
  const [editingExpiry, setEditingExpiry] = useState<string | null>(null);
  const [expiryEditForm, setExpiryEditForm] = useState({ enable: false, advance_days: DEFAULT_EXPIRY_ADVANCE_DAYS });

  // Load tab state
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [editingLoad, setEditingLoad] = useState<LoadNotification | null>(null);
  const [loadForm, setLoadForm] = useState<LoadNotificationForm>({});

  useEffect(() => {
    setActiveTab(toNotificationTab(urlTab));
  }, [urlTab]);

  const handleTabChange = (value: string) => {
    const nextTab = toNotificationTab(value);
    setActiveTab(nextTab);
    setSelectedClients([]);
    void navigate(`/admin/notifications/${nextTab}`);
  };

  const setTabBusy = useCallback((tab: NotificationTab, busy: boolean) => {
    setTabLoading((prev) => ({ ...prev, [tab]: busy }));
  }, []);

  const markTabLoaded = useCallback((tab: NotificationTab) => {
    setLoadedTabs((prev) => ({ ...prev, [tab]: true }));
  }, []);

  const ensureClientsLoaded = useCallback(async () => {
    if (clientsLoadedRef.current) return clientsRef.current;
    if (clientsLoadPromiseRef.current) return clientsLoadPromiseRef.current;

    const promise = apiFetch('/admin/clients')
      .then((data) => {
        const nextClients = Array.isArray(data) ? data as NotificationClient[] : [];
        clientsRef.current = nextClients;
        setClients(nextClients);
        clientsLoadedRef.current = true;
        return nextClients;
      })
      .finally(() => {
        clientsLoadPromiseRef.current = null;
      });
    clientsLoadPromiseRef.current = promise;
    return promise;
  }, [apiFetch]);

  const loadSettingsTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.settings) return;
    setTabBusy('settings', true);
    try {
      const settingsData = await apiFetch('/admin/settings?scope=notification');
      if (settingsData && typeof settingsData === 'object') {
        const nextSettings = settingsData as SettingsMap;
        setSettings(nextSettings);
        setOriginalSettings(nextSettings);
      }
      markTabLoaded('settings');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '通知设置加载失败');
    } finally {
      setTabBusy('settings', false);
    }
  }, [apiFetch, loadedTabs.settings, markTabLoaded, setTabBusy]);

  const loadOfflineTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.offline) return;
    setTabBusy('offline', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/offline'),
      ensureClientsLoaded(),
    ]);
    const [offData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(offData)) setOfflineNotifications(offData as OfflineNotification[]);
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('离线通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('offline');
    }
    setTabBusy('offline', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.offline, markTabLoaded, setTabBusy]);

  const loadExpiryTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.expiry) return;
    setTabBusy('expiry', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/expiry'),
      ensureClientsLoaded(),
    ]);
    const [expiryData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(expiryData)) setExpiryNotifications(expiryData as ExpiryNotification[]);
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('到期通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('expiry');
    }
    setTabBusy('expiry', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.expiry, markTabLoaded, setTabBusy]);

  const loadLoadTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.load) return;
    setTabBusy('load', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/load'),
      ensureClientsLoaded(),
    ]);
    const [loadRulesData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(loadRulesData)) {
      setLoadNotifications((loadRulesData as LoadNotification[]).map((item) => ({
        ...item,
        clients: Array.isArray(item.clients) ? item.clients : [],
      })));
    }
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('负载通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('load');
    }
    setTabBusy('load', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.load, markTabLoaded, setTabBusy]);

  const loadIpChangeTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.ipchange) return;
    setTabBusy('ipchange', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/ipchange'),
      ensureClientsLoaded(),
      loadedTabs.settings ? Promise.resolve(null) : apiFetch('/admin/settings?scope=notification'),
    ]);
    const [ipChangeData, , settingsData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(ipChangeData)) setIpChangeNotifications(ipChangeData as IpChangeNotification[]);
    if (settingsData && typeof settingsData === 'object') {
      const nextSettings = settingsData as SettingsMap;
      setSettings(nextSettings);
      setOriginalSettings(nextSettings);
    }
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('来源 IP 通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('ipchange');
    }
    setTabBusy('ipchange', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.settings, loadedTabs.ipchange, markTabLoaded, setTabBusy]);

  const loadActiveTab = useCallback((tab: NotificationTab, force = false) => {
    if (tab === 'settings') return loadSettingsTab(force);
    if (tab === 'offline') return loadOfflineTab(force);
    if (tab === 'expiry') return loadExpiryTab(force);
    if (tab === 'ipchange') return loadIpChangeTab(force);
    return loadLoadTab(force);
  }, [loadExpiryTab, loadLoadTab, loadOfflineTab, loadSettingsTab, loadIpChangeTab]);

  useEffect(() => {
    void loadActiveTab(activeTab);
  }, [activeTab, loadActiveTab]);

  // ─── Offline: search + filter ───
  const notificationMap = useMemo(() => {
    const map = new Map<string, OfflineNotification>();
    offlineNotifications.forEach((n) => map.set(n.client, n));
    return map;
  }, [offlineNotifications]);

  const expiryNotificationMap = useMemo(() => {
    const map = new Map<string, ExpiryNotification>();
    expiryNotifications.forEach((n) => map.set(n.client, n));
    return map;
  }, [expiryNotifications]);

  const ipChangeNotificationMap = useMemo(() => {
    const map = new Map<string, IpChangeNotification>();
    ipChangeNotifications.forEach((n) => map.set(n.client, n));
    return map;
  }, [ipChangeNotifications]);

  const filteredClients = useMemo(() => {
    if (!searchTerm.trim()) return clients;
    const term = searchTerm.toLowerCase();
    return clients.filter((c) =>
      c.name?.toLowerCase().includes(term) ||
      clientDisplayIp(c).toLowerCase().includes(term) ||
      c.region?.toLowerCase().includes(term)
    );
  }, [clients, searchTerm]);

  // ─── Source IP: toggle ───
  const toggleIpChange = (clientUuid: string, enable: boolean) => runAction('ipchange:' + clientUuid, async () => {
    const result = await apiFetch('/admin/notification/ipchange/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable }),
    });
    if (result.success) {
      toast.success(enable ? '已开启来源 IP 通知' : '已关闭来源 IP 通知');
      await loadIpChangeTab(true);
    } else {
      toast.error(result.error || '操作失败');
    }
  });

  // ─── Offline: toggle ───
  const toggleOffline = (clientUuid: string, enable: boolean) => runAction('offline:' + clientUuid, async () => {
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, grace_period: notificationMap.get(clientUuid)?.grace_period ?? DEFAULT_GRACE_PERIOD_SEC }),
    });
    if (result.success) {
      toast.success(enable ? '已开启离线通知' : '已关闭离线通知');
      await loadOfflineTab(true);
    } else {
      toast.error(result.error || '操作失败');
    }
  });

  // ─── Offline: single edit ───
  const openEditDialog = (clientUuid: string) => {
    const existing = notificationMap.get(clientUuid);
    setEditingOffline(clientUuid);
    setEditForm({
      enable: existing?.enable || false,
      grace_period: existing?.grace_period || DEFAULT_GRACE_PERIOD_SEC,
    });
    setEditDialogOpen(true);
  };

  const saveSingleEdit = () => runAction('offline:edit', async () => {
    if (!editingOffline) return;
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingOffline,
        enable: editForm.enable,
        grace_period: editForm.grace_period,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setEditDialogOpen(false);
      await loadOfflineTab(true);
    } else {
      toast.error(result.error || '更新失败');
    }
  });

  // ─── Offline: batch edit ───
  const openBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    // 预填选中节点的当前值而非固定数字：全部相同取该值，不一致取众数并提示。
    // 未配置过通知的节点按默认值计入，使统计覆盖全部选中项。
    const summary = summarizeSelectionValue(
      selectedClients.map(
        (uuid) => notificationMap.get(uuid)?.grace_period || DEFAULT_GRACE_PERIOD_SEC,
      ),
      DEFAULT_GRACE_PERIOD_SEC,
    );
    setBatchForm({ enable: true, grace_period: summary.value });
    setBatchGraceMixed(!summary.consistent);
    setBatchDialogOpen(true);
  };

  const saveBatchEdit = () => runAction('offline:batch', async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: batchForm.enable,
      grace_period: batchForm.grace_period,
    }));
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setBatchDialogOpen(false);
      setSelectedClients([]);
      await loadOfflineTab(true);
    } else {
      toast.error('批量更新失败');
    }
  });

  const toggleSelectAll = () => {
    if (selectedClients.length === filteredClients.length && filteredClients.length > 0) {
      setSelectedClients([]);
    } else {
      setSelectedClients(filteredClients.map((c) => c.uuid));
    }
  };

  const setClientSelected = (uuid: string, checked: boolean) => {
    setSelectedClients((current) => checked
      ? (current.includes(uuid) ? current : [...current, uuid])
      : current.filter((id) => id !== uuid));
  };

  const toggleExpiry = (clientUuid: string, enable: boolean) => runAction('expiry:' + clientUuid, async () => {
    const existing = expiryNotificationMap.get(clientUuid);
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, advance_days: existing?.advance_days || 7 }),
    });
    if (result.success) {
      toast.success(enable ? '已开启到期通知' : '已关闭到期通知');
      await loadExpiryTab(true);
    } else {
      toast.error(result.error || '操作失败');
    }
  });

  const openExpiryEditDialog = (clientUuid: string) => {
    const existing = expiryNotificationMap.get(clientUuid);
    setEditingExpiry(clientUuid);
    setExpiryEditForm({
      enable: existing?.enable || false,
      advance_days: existing?.advance_days || DEFAULT_EXPIRY_ADVANCE_DAYS,
    });
    setExpiryEditDialogOpen(true);
  };

  const saveExpirySingleEdit = () => runAction('expiry:edit', async () => {
    if (!editingExpiry) return;
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingExpiry,
        enable: expiryEditForm.enable,
        advance_days: expiryEditForm.advance_days,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setExpiryEditDialogOpen(false);
      await loadExpiryTab(true);
    } else {
      toast.error(result.error || '更新失败');
    }
  });

  const openExpiryBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    const summary = summarizeSelectionValue(
      selectedClients.map(
        (uuid) => expiryNotificationMap.get(uuid)?.advance_days || DEFAULT_EXPIRY_ADVANCE_DAYS,
      ),
      DEFAULT_EXPIRY_ADVANCE_DAYS,
    );
    setExpiryBatchForm({ enable: true, advance_days: summary.value });
    setExpiryBatchDaysMixed(!summary.consistent);
    setExpiryBatchDialogOpen(true);
  };

  const saveExpiryBatchEdit = () => runAction('expiry:batch', async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: expiryBatchForm.enable,
      advance_days: expiryBatchForm.advance_days,
    }));
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setExpiryBatchDialogOpen(false);
      setSelectedClients([]);
      await loadExpiryTab(true);
    } else {
      toast.error('批量更新失败');
    }
  });

  // ─── Settings: global notification channel ───
  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateSensitiveWebhookSetting = (
    key: 'webhook_url' | 'webhook_secret' | 'webhook_headers_json' | 'webhook_password',
    value: string,
  ) => {
    const clearKey = key === 'webhook_url'
      ? 'webhook_url_clear'
      : key === 'webhook_secret'
        ? 'webhook_secret_clear'
        : '';
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (value && clearKey) delete next[clearKey];
      return next;
    });
  };

  const handleNotificationMethodChange = (value: string) => {
    updateSetting('notification_method', value);
    const channel = value === 'email' ? 'email' : value === 'telegram' ? 'telegram' : value === 'webhook' ? 'webhook' : null;
    if (channel) setChannelOpen((prev) => ({ ...prev, [channel]: true }));
  };

  const saveNotificationSettings = async () => {
    const payload = { ...settings };
    delete payload.email_smtp_password_set;
    delete payload.webhook_url_set;
    delete payload.webhook_secret_set;
    delete payload.webhook_headers_set;
    delete payload.webhook_password_set;
    delete payload.webhook_url_host;
    if (!payload.email_smtp_password) {
      delete payload.email_smtp_password;
    }
    if (payload.webhook_url_clear !== 'true') {
      delete payload.webhook_url_clear;
    }
    if (payload.webhook_secret_clear !== 'true') {
      delete payload.webhook_secret_clear;
    }
    if (!payload.webhook_url && payload.webhook_url_clear !== 'true') {
      delete payload.webhook_url;
    }
    if (!payload.webhook_secret && payload.webhook_secret_clear !== 'true') {
      delete payload.webhook_secret;
    }
    if (!payload.webhook_headers_json) {
      delete payload.webhook_headers_json;
    }
    if (!payload.webhook_password) {
      delete payload.webhook_password;
    }
    const changedSettings = getChangedSettings(payload, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSettingsSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        await loadSettingsTab(true);
        toast.success('通知设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  // ─── Load: crud ───
  const openLoadAdd = () => {
    setEditingLoad(null);
    setLoadForm({
      name: '',
      metric: 'cpu',
      threshold: 80,
      ratio: 0.8,
      interval_min: 15,
      clients: [],
      all_clients: true,
    });
    setLoadDialogOpen(true);
  };

  const openLoadEdit = (item: LoadNotification) => {
    setEditingLoad(item);
    setLoadForm({
      ...item,
      all_clients: !item.clients || item.clients.length === 0,
    });
    setLoadDialogOpen(true);
  };

  const saveLoadNotification = () => runAction('load:save', async () => {
    if (!loadForm.all_clients && !loadForm.clients?.length) {
      toast.error('请至少选择一台服务器');
      return;
    }
    const payload = {
      ...loadForm,
      clients: loadForm.all_clients ? [] : loadForm.clients || [],
    };

    if (editingLoad?.id) {
      const result = await apiFetch(`/admin/notification/load/${editingLoad.id}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已更新');
        setLoadDialogOpen(false);
        await loadLoadTab(true);
      } else {
        toast.error(result.error || '更新失败');
      }
    } else {
      const result = await apiFetch('/admin/notification/load/add', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已添加');
        setLoadDialogOpen(false);
        await loadLoadTab(true);
      } else {
        toast.error(result.error || '添加失败');
      }
    }
  });

  const deleteLoadNotification = (id: number) => runAction('load:delete:' + id, async () => {
    const result = await apiFetch(`/admin/notification/load/${id}`, {
      method: 'DELETE',
    });
    if (result.success) {
      toast.success('已删除');
      await loadLoadTab(true);
    } else {
      toast.error(result.error || '删除失败');
    }
  });

  // ─── Test message ───
  // 测试一律以表单当前值为准：把当前设置随请求发出去，后端只取通知相关白名单字段，
  // 空值按「未提供」回落到已保存配置。这样不必先保存就能测。
  const sendTestMessage = () => runAction('test:telegram', async () => {
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({
          message: 'CF VPS Monitor 测试消息 - 通知配置成功!',
          channel: 'telegram',
          settings,
        }),
      });
      if (result.success) {
        toast.success('测试消息已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败');
    }
  });

  const sendTestEmail = async () => {
    setTestEmailSending(true);
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'email',
          message: 'CF VPS Monitor 测试消息 - 邮件通知配置成功!',
          test_recipient: testRecipient.trim(),
          settings,
        }),
      });
      if (result.success) {
        toast.success('测试邮件已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    } finally {
      setTestEmailSending(false);
    }
  };

  const sendTestWebhook = async () => {
    setTestWebhookSending(true);
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'webhook',
          message: 'CF VPS Monitor 测试消息 - Webhook 通知配置成功!',
          settings,
        }),
      });
      if (result.success) {
        toast.success('Webhook 测试消息已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    } finally {
      setTestWebhookSending(false);
    }
  };

  const offlineStatsCount = offlineNotifications.filter((n) => n.enable).length;
  const expiryStatsCount = expiryNotifications.filter((n) => n.enable).length;
  const ipChangeStatsCount = ipChangeNotifications.filter((n) => n.enable).length;
  const notificationMethod = settings.notification_method || 'telegram';
  const webhookFormat = settings.webhook_format || 'generic';
  // 「已配置」只看必填项是否齐全：已保存的密钥不会回显，所以同时认 *_set 标记和本次输入。
  const channelConfigured = {
    email: Boolean(settings.email_smtp_host?.trim() && settings.email_smtp_from_address?.trim() && settings.email_smtp_recipients?.trim()),
    telegram: (settings.telegram_bot_token_set === 'true' || Boolean(settings.telegram_bot_token?.trim()))
      && (settings.telegram_chat_id_set === 'true' || Boolean(settings.telegram_chat_id?.trim())),
    webhook: settings.webhook_url_set === 'true' || Boolean(settings.webhook_url?.trim()),
  };
  const selectedChannel = notificationMethod === 'email' || notificationMethod === 'telegram' || notificationMethod === 'webhook'
    ? notificationMethod
    : null;
  const channelBadges = (channel: 'email' | 'telegram' | 'webhook') => (
    <>
      {selectedChannel === channel && <Badge variant="success">当前通道</Badge>}
      <Badge variant={channelConfigured[channel] ? 'secondary' : 'outline'}>{channelConfigured[channel] ? '已配置' : '未配置'}</Badge>
    </>
  );
  const webhookSecretHint = webhookFormat === 'feishu' || webhookFormat === 'dingtalk'
    ? '用于平台签名校验'
    : webhookFormat === 'generic'
      ? '通用格式用于 HMAC'
      : webhookFormat === 'custom'
        ? '自定义模式可留空'
        : '当前平台通常不需要 Secret';
  const notificationMethodLabel = notificationMethod === 'email'
    ? 'SMTP 邮件'
    : notificationMethod === 'webhook'
      ? 'Webhook'
      : notificationMethod === 'none'
        ? '关闭'
        : 'Telegram';

  const tabOptions: Array<{ value: NotificationTab; label: string }> = [
    { value: 'settings', label: '通知设置' },
    { value: 'offline', label: loadedTabs.offline ? `离线通知 (${offlineStatsCount} 开启)` : '离线通知' },
    { value: 'expiry', label: loadedTabs.expiry ? `到期通知 (${expiryStatsCount} 开启)` : '到期通知' },
    { value: 'load', label: loadedTabs.load ? `负载通知 (${loadNotifications.length} 条)` : '负载通知' },
    { value: 'ipchange', label: loadedTabs.ipchange ? `IP 变更通知 (${ipChangeStatsCount} 开启)` : 'IP 变更通知' },
  ];

  const formWidthTab = activeTab === 'settings' || activeTab === 'ipchange';

  const headerAction = activeTab === 'settings' || activeTab === 'ipchange' ? (
    <Button onClick={() => void saveNotificationSettings()} disabled={settingsSaving || tabLoading[activeTab]}>
      <Save size={16} /> {settingsSaving ? '保存中…' : '保存设置'}
    </Button>
  ) : activeTab === 'load' ? (
    <Button onClick={openLoadAdd} disabled={tabLoading.load}><Plus size={16} /> 新建规则</Button>
  ) : null;

  const activeClientName = (uuid: string | null) => {
    if (!uuid) return '';
    return clients.find((client) => client.uuid === uuid)?.name || uuid;
  };

  const selectedAll = filteredClients.length > 0 && selectedClients.length === filteredClients.length;

  return (
    <div className="sa-scope sa-page admin-notifications-page">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <Bell size={20} />
          <span>通知管理</span>
        </div>
      </div>

      <div className={`sa-page-actions${formWidthTab ? ' sa-page-narrow' : ''}`}>
        <Segmented label="通知类型" value={activeTab} onChange={handleTabChange} options={tabOptions} />
        {headerAction && <div className="sa-toolbar-group">{headerAction}</div>}
      </div>

      {/* ─── 通知设置 ─── */}
      {activeTab === 'settings' && (
        tabLoading.settings ? <Loading /> : (
          <div className="sa-page sa-page-narrow">
            <Card>
              <CardHeader title="通知通道" description="选择全局通知发送方式" />
              <Rows>
                <SettingRow
                  label="发送方式"
                  description="离线、到期、负载与 IP 变更通知都通过这个通道发送；选择「关闭」后不再发送任何通知。"
                >
                  <select
                    className="sa-input sa-select"
                    style={{ width: 180 }}
                    aria-label="通知发送方式"
                    value={notificationMethod}
                    onChange={(event) => handleNotificationMethodChange(event.target.value)}
                  >
                    <option value="none">关闭</option>
                    <option value="telegram">Telegram</option>
                    <option value="email">SMTP 邮件</option>
                    <option value="webhook">Webhook</option>
                  </select>
                </SettingRow>
              </Rows>
              {selectedChannel && !channelConfigured[selectedChannel] && (
                <Notice tone="warning" title={`${notificationMethodLabel} 尚未配置完整`}>
                  当前发送方式是 {notificationMethodLabel}，但必填项还没填全，通知暂时不会发出。展开下方对应渠道补全后再保存。
                </Notice>
              )}
            </Card>

            <CollapsibleCard
              title="SMTP 邮件通知"
              description="发件服务器、账号和默认收件人"
              badges={channelBadges('email')}
              open={channelOpen.email}
              onOpenChange={(open) => setChannelOpen((prev) => ({ ...prev, email: open }))}
            >
              <Rows>
                <Field
                  label="SMTP Host"
                  placeholder="smtp.example.com"
                  value={settings.email_smtp_host || ''}
                  onChange={(value) => updateSetting('email_smtp_host', value)}
                  hint="邮件服务商的 SMTP 服务器地址，例如 smtp.gmail.com。"
                />
                <Field
                  label="端口"
                  type="number"
                  suffix="端口"
                  placeholder="587"
                  value={settings.email_smtp_port || '587'}
                  onChange={(value) => updateSetting('email_smtp_port', value)}
                  hint="STARTTLS 通常为 587，隐式 TLS 通常为 465。"
                />
                <SelectField
                  label="安全模式"
                  value={settings.email_smtp_security || 'starttls'}
                  onChange={(value) => updateSetting('email_smtp_security', value)}
                  options={[
                    { value: 'starttls', label: 'STARTTLS (587)' },
                    { value: 'tls', label: '隐式 TLS (465)' },
                  ]}
                  hint="STARTTLS 先建立明文连接再升级加密；隐式 TLS 从连接开始就加密。"
                />
                <SelectField
                  label="认证方式"
                  value={settings.email_smtp_auth_method || 'plain'}
                  onChange={(value) => updateSetting('email_smtp_auth_method', value)}
                  options={[{ value: 'plain', label: 'PLAIN' }, { value: 'login', label: 'LOGIN' }]}
                  hint="多数服务商使用 PLAIN；个别旧服务器只支持 LOGIN。"
                />
                <Field
                  label="用户名"
                  placeholder={settings.email_smtp_username_preview
                    ? `${settings.email_smtp_username_preview}（留空则不修改）` : 'user@example.com'}
                  value={settings.email_smtp_username || ''}
                  onChange={(value) => updateSetting('email_smtp_username', value)}
                />
                <Field
                  label="密码"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.email_smtp_password_preview
                    ? `${settings.email_smtp_password_preview}（留空则不修改）`
                    : (settings.email_smtp_password_set === 'true' ? '已保存密码，留空则不修改' : 'SMTP 密码或授权码')}
                  value={settings.email_smtp_password || ''}
                  onChange={(value) => updateSetting('email_smtp_password', value)}
                  hint="已保存的密码不会回显；留空表示沿用已保存的值。"
                />
                <Field
                  label="发件人邮箱"
                  placeholder="monitor@example.com"
                  value={settings.email_smtp_from_address || ''}
                  onChange={(value) => updateSetting('email_smtp_from_address', value)}
                />
                <Field
                  label="发件人名称"
                  placeholder="CF VPS Monitor"
                  value={settings.email_smtp_from_name || 'CF VPS Monitor'}
                  onChange={(value) => updateSetting('email_smtp_from_name', value)}
                />
                <SettingTextarea
                  label="收件地址"
                  description="支持逗号、分号或换行分隔，最多 20 个"
                  value={settings.email_smtp_recipients || ''}
                  onChange={(value) => updateSetting('email_smtp_recipients', value)}
                  rows={3}
                  placeholder={'admin@example.com\nops@example.com'}
                />
                <SettingRow label="发送测试邮件" description="用当前表单里的配置发送，无需先保存。留空则发到默认收件地址。">
                  <input
                    className="sa-input"
                    style={{ width: 280 }}
                    placeholder="测试收件人"
                    aria-label="测试收件人"
                    value={testRecipient}
                    onChange={(event) => setTestRecipient(event.target.value)}
                  />
                  <Button variant="outline" size="sm" onClick={() => void sendTestEmail()} disabled={testEmailSending}>
                    <Send size={14} /> {testEmailSending ? '发送中…' : 'SMTP 测试'}
                  </Button>
                </SettingRow>
              </Rows>
            </CollapsibleCard>

            <CollapsibleCard
              title="Telegram 通知"
              description="Bot 与辅助告警策略"
              badges={channelBadges('telegram')}
              open={channelOpen.telegram}
              onOpenChange={(open) => setChannelOpen((prev) => ({ ...prev, telegram: open }))}
            >
              <Rows>
                <Field
                  label="Bot Token"
                  placeholder={settings.telegram_bot_token_preview
                    ? `${settings.telegram_bot_token_preview}（留空则不修改）`
                    : '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'}
                  value={settings.telegram_bot_token || ''}
                  onChange={(value) => updateSetting('telegram_bot_token', value)}
                  hint={settings.telegram_bot_token_set === 'true'
                    ? '已配置，留空则保持不变；填写新值才会覆盖。'
                    : '从 @BotFather 获取。'}
                />
                <Field
                  label="Chat ID"
                  placeholder={settings.telegram_chat_id_preview
                    ? `${settings.telegram_chat_id_preview}（留空则不修改）`
                    : '-1001234567890'}
                  value={settings.telegram_chat_id || ''}
                  onChange={(value) => updateSetting('telegram_chat_id', value)}
                  hint={settings.telegram_chat_id_set === 'true'
                    ? '已配置，留空则保持不变；填写新值才会覆盖。'
                    : '群组或用户的 Chat ID。'}
                />
                <SettingRow label="发送测试消息" description="用当前表单里的 Bot 配置发送一条测试消息，无需先保存。">
                  <Button variant="outline" size="sm" onClick={() => void sendTestMessage()} disabled={pendingActions.has('test:telegram')}>
                    <Send size={14} /> Telegram 测试
                  </Button>
                </SettingRow>
              </Rows>
            </CollapsibleCard>

            <CollapsibleCard
              title="Webhook 通知"
              description="HTTPS 回调地址和消息格式"
              badges={channelBadges('webhook')}
              open={channelOpen.webhook}
              onOpenChange={(open) => setChannelOpen((prev) => ({ ...prev, webhook: open }))}
            >
              <Rows>
                <Field
                  label="Webhook URL"
                  placeholder={settings.webhook_url_set === 'true' ? '已保存 URL，留空则不修改' : 'https://hooks.example.com/...'}
                  value={settings.webhook_url || ''}
                  onChange={(value) => updateSensitiveWebhookSetting('webhook_url', value)}
                  hint={settings.webhook_url_host
                    ? `当前 Host：${settings.webhook_url_host}。仅支持 HTTPS URL。`
                    : settings.webhook_url_set === 'true'
                      ? '已配置 URL，留空则不修改。仅支持 HTTPS URL。'
                      : '仅支持 HTTPS URL。'}
                />
                <SelectField
                  label="消息格式"
                  value={webhookFormat}
                  onChange={(value) => updateSetting('webhook_format', value)}
                  options={[
                    { value: 'generic', label: '通用 JSON' },
                    { value: 'slack', label: 'Slack' },
                    { value: 'discord', label: 'Discord' },
                    { value: 'feishu', label: '飞书' },
                    { value: 'dingtalk', label: '钉钉' },
                    { value: 'wecom', label: '企业微信' },
                    { value: 'custom', label: 'Custom' },
                  ]}
                  hint="选择目标平台的消息格式；Custom 可自定义请求方法、Headers 与 Body 模板。"
                />
                <Field
                  label="Secret"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.webhook_secret_preview
                    ? `${settings.webhook_secret_preview}（留空则不修改）`
                    : (settings.webhook_secret_set === 'true' ? '已保存 Secret，留空则不修改' : '可选')}
                  value={settings.webhook_secret || ''}
                  onChange={(value) => updateSensitiveWebhookSetting('webhook_secret', value)}
                  hint={webhookSecretHint}
                />
                {webhookFormat === 'custom' && (
                  <>
                    <SelectField
                      label="请求方法"
                      value={settings.webhook_method || 'POST'}
                      onChange={(value) => updateSetting('webhook_method', value)}
                      options={[{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }]}
                      hint="GET 适合 URL 参数类接口，POST 适合请求体模板。"
                    />
                    <Field
                      label="Content-Type"
                      placeholder="application/json"
                      value={settings.webhook_content_type || 'application/json'}
                      onChange={(value) => updateSetting('webhook_content_type', value)}
                      hint="POST custom 请求使用。"
                    />
                    <SelectField
                      label="重试次数"
                      value={settings.webhook_retry_count || '1'}
                      onChange={(value) => updateSetting('webhook_retry_count', value)}
                      options={[
                        { value: '1', label: '1' },
                        { value: '2', label: '2' },
                        { value: '3', label: '3' },
                      ]}
                      hint="失败时最多重试 3 次。"
                    />
                    <Field
                      label="Basic Auth 用户名"
                      placeholder="username"
                      value={settings.webhook_username || ''}
                      onChange={(value) => updateSetting('webhook_username', value)}
                      hint="不需要认证可留空。"
                    />
                    <SettingTextarea
                      label="Headers JSON"
                      description={settings.webhook_headers_set === 'true'
                        ? '已保存 Headers，留空则不修改；键和值都必须是字符串，不要同时配置 Authorization 与 Basic Auth'
                        : '键和值都必须是字符串，不要同时配置 Authorization 与 Basic Auth'}
                      value={settings.webhook_headers_json || ''}
                      onChange={(value) => updateSensitiveWebhookSetting('webhook_headers_json', value)}
                      rows={3}
                      placeholder='{"X-Token":"token"}'
                    />
                    <SettingTextarea
                      label="Body 模板"
                      description="可用变量：{{title}} {{message}} {{event}} {{client}} {{time}} {{emoji}} {{source}}"
                      value={settings.webhook_body_template || '{"message":"{{message}}","title":"{{title}}"}'}
                      onChange={(value) => updateSetting('webhook_body_template', value)}
                      rows={4}
                    />
                    <Field
                      label="Basic Auth 密码"
                      type="password"
                      autoComplete="new-password"
                      placeholder={settings.webhook_password_preview
                        ? `${settings.webhook_password_preview}（留空则不修改）`
                        : (settings.webhook_password_set === 'true' ? '已保存密码，留空则不修改' : 'password')}
                      value={settings.webhook_password || ''}
                      onChange={(value) => updateSensitiveWebhookSetting('webhook_password', value)}
                    />
                  </>
                )}
                <SettingRow label="发送测试消息" description="用当前表单里的 Webhook 配置发送一条测试消息，无需先保存。">
                  <Button variant="outline" size="sm" onClick={() => void sendTestWebhook()} disabled={testWebhookSending}>
                    <Send size={14} /> {testWebhookSending ? '发送中…' : 'Webhook 测试'}
                  </Button>
                </SettingRow>
              </Rows>
            </CollapsibleCard>
          </div>
        )
      )}

      {/* ─── 离线通知 ─── */}
      {activeTab === 'offline' && (
        tabLoading.offline ? <Loading /> : (
          <Card>
            <div className="sa-toolbar">
              <div className="sa-toolbar-group">
                <div className="sa-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    className="sa-input"
                    style={{ width: 220 }}
                    placeholder="搜索服务器"
                    aria-label="搜索服务器"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </div>
                <span className="sa-muted">已选 {selectedClients.length}</span>
              </div>
              <div className="sa-toolbar-group">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openBatchDialog}
                  disabled={selectedClients.length === 0}
                >
                  <Pencil size={14} /> 批量编辑
                </Button>
              </div>
            </div>

            <div className="sa-table-scroll">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th className="sa-td-narrow">
                      <Checkbox
                        checked={selectedAll}
                        indeterminate={selectedClients.length > 0 && !selectedAll}
                        onCheckedChange={toggleSelectAll}
                        aria-label="全选服务器"
                      />
                    </th>
                    <th>服务器</th>
                    <th>状态</th>
                    <th className="sa-col-md">宽限期</th>
                    <th className="sa-col-lg">最后通知</th>
                    <th className="sa-td-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClients.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="sa-empty">
                        {searchTerm ? '没有匹配的服务器' : '暂无服务器'}
                      </td>
                    </tr>
                  ) : filteredClients.map((client) => {
                    const notification = notificationMap.get(client.uuid);
                    const displayIp = clientDisplayIp(client);
                    const enabled = notification?.enable || false;
                    const gracePeriod = notification?.grace_period || DEFAULT_GRACE_PERIOD_SEC;
                    return (
                      <tr key={client.uuid} className={`sa-tr${selectedClients.includes(client.uuid) ? ' is-selected' : ''}`}>
                        <td className="sa-td-narrow">
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => setClientSelected(client.uuid, checked)}
                            aria-label={`选择 ${client.name || '未命名'}`}
                          />
                        </td>
                        <td className="sa-td-name">
                          <span className="sa-name-cell">
                            <span className="sa-ellipsis sa-cell-name" title={client.name || '未命名'}>{client.name || '未命名'}</span>
                            {displayIp && <span className="sa-mono sa-muted sa-cell-ip sa-ellipsis" title={displayIp}>{displayIp}</span>}
                          </span>
                        </td>
                        <td>
                          <Switch
                            checked={enabled}
                            onCheckedChange={(value) => toggleOffline(client.uuid, value)}
                            disabled={pendingActions.has(`offline:${client.uuid}`)}
                            aria-label={`${client.name || '未命名'} 离线通知`}
                          />
                        </td>
                        <td className="sa-col-md">{gracePeriod} 秒</td>
                        <td className="sa-col-lg sa-muted">{formatLastNotified(notification?.last_notified)}</td>
                        <td className="sa-td-actions">
                          <span className="admin-row-actions">
                            <button
                              type="button"
                              className="admin-icon-button admin-row-action"
                              aria-label={`编辑 ${client.name || '未命名'}`}
                              title="编辑"
                              onClick={() => openEditDialog(client.uuid)}
                            >
                              <Pencil size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sa-table-footer">共 {filteredClients.length} 台服务器</div>
          </Card>
        )
      )}

      {/* ─── 到期通知 ─── */}
      {activeTab === 'expiry' && (
        tabLoading.expiry ? <Loading /> : (
          <Card>
            <div className="sa-toolbar">
              <div className="sa-toolbar-group">
                <div className="sa-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    className="sa-input"
                    style={{ width: 220 }}
                    placeholder="搜索服务器"
                    aria-label="搜索服务器"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </div>
                <span className="sa-muted">已选 {selectedClients.length}</span>
              </div>
              <div className="sa-toolbar-group">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openExpiryBatchDialog}
                  disabled={selectedClients.length === 0}
                >
                  <Pencil size={14} /> 批量编辑
                </Button>
              </div>
            </div>

            <div className="sa-table-scroll">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th className="sa-td-narrow">
                      <Checkbox
                        checked={selectedAll}
                        indeterminate={selectedClients.length > 0 && !selectedAll}
                        onCheckedChange={toggleSelectAll}
                        aria-label="全选服务器"
                      />
                    </th>
                    <th>服务器</th>
                    <th>状态</th>
                    <th className="sa-col-md">提前提醒</th>
                    <th className="sa-col-md">到期时间</th>
                    <th className="sa-col-lg">最后通知</th>
                    <th className="sa-td-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClients.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="sa-empty">
                        {searchTerm ? '没有匹配的服务器' : '暂无服务器'}
                      </td>
                    </tr>
                  ) : filteredClients.map((client) => {
                    const notification = expiryNotificationMap.get(client.uuid);
                    const displayIp = clientDisplayIp(client);
                    const enabled = notification?.enable || false;
                    const advanceDays = notification?.advance_days || DEFAULT_EXPIRY_ADVANCE_DAYS;
                    const expiredAtText = client.expired_at
                      ? new Date(client.expired_at).toLocaleDateString('zh-CN')
                      : '';
                    return (
                      <tr key={client.uuid} className={`sa-tr${selectedClients.includes(client.uuid) ? ' is-selected' : ''}`}>
                        <td className="sa-td-narrow">
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => setClientSelected(client.uuid, checked)}
                            aria-label={`选择 ${client.name || '未命名'}`}
                          />
                        </td>
                        <td className="sa-td-name">
                          <span className="sa-name-cell">
                            <span className="sa-ellipsis sa-cell-name" title={client.name || '未命名'}>{client.name || '未命名'}</span>
                            {displayIp && <span className="sa-mono sa-muted sa-cell-ip sa-ellipsis" title={displayIp}>{displayIp}</span>}
                          </span>
                        </td>
                        <td>
                          <Switch
                            checked={enabled}
                            onCheckedChange={(value) => toggleExpiry(client.uuid, value)}
                            disabled={pendingActions.has(`expiry:${client.uuid}`)}
                            aria-label={`${client.name || '未命名'} 到期通知`}
                          />
                        </td>
                        <td className="sa-col-md">{advanceDays} 天</td>
                        <td className="sa-col-md">
                          {expiredAtText ? <span className="sa-muted">{expiredAtText}</span> : <Badge variant="warning">未设置</Badge>}
                        </td>
                        <td className="sa-col-lg sa-muted">{formatLastNotified(notification?.last_notified)}</td>
                        <td className="sa-td-actions">
                          <span className="admin-row-actions">
                            <button
                              type="button"
                              className="admin-icon-button admin-row-action"
                              aria-label={`编辑 ${client.name || '未命名'}`}
                              title="编辑"
                              onClick={() => openExpiryEditDialog(client.uuid)}
                            >
                              <Pencil size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sa-table-footer">共 {filteredClients.length} 台服务器</div>
          </Card>
        )
      )}

      {/* ─── 负载通知 ─── */}
      {activeTab === 'load' && (
        tabLoading.load ? <Loading /> : (
          <Card>
            {loadNotifications.length === 0 ? (
              <div className="sa-empty-block">
                <TrendingUp size={28} aria-hidden="true" />
                <span>暂无负载通知规则</span>
                <Button size="sm" onClick={openLoadAdd}><Plus size={14} /> 新建规则</Button>
              </div>
            ) : (
              <>
                <div className="sa-table-scroll">
                  <table className="sa-table">
                    <thead>
                      <tr>
                        <th className="sa-td-name">名称</th>
                        <th>指标</th>
                        <th className="sa-col-md">阈值</th>
                        <th className="sa-col-md">达标率</th>
                        <th className="sa-col-lg">监测间隔</th>
                        <th>范围</th>
                        <th className="sa-td-actions">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadNotifications.map((item) => (
                        <tr key={item.id} className="sa-tr">
                          <td className="sa-td-name">
                            <span className="sa-ellipsis sa-cell-name" title={item.name || '未命名规则'}>{item.name || '未命名规则'}</span>
                          </td>
                          <td><Badge variant="outline">{loadMetricLabels[item.metric || 'cpu'] || item.metric || 'cpu'}</Badge></td>
                          <td className="sa-col-md">{item.threshold ?? 80}{loadMetricUnit(item.metric)}</td>
                          <td className="sa-col-md">{((item.ratio ?? 0.8) * 100).toFixed(0)}%</td>
                          <td className="sa-col-lg">{item.interval_min || 15} 分钟</td>
                          <td>
                            {item.all_clients || !item.clients || item.clients.length === 0
                              ? <Badge variant="info">全节点</Badge>
                              : <Badge variant="warning">{item.clients?.length || 0} 节点</Badge>}
                          </td>
                          <td className="sa-td-actions">
                            <span className="admin-row-actions">
                              <button
                                type="button"
                                className="admin-icon-button admin-row-action"
                                aria-label={`编辑 ${item.name || '未命名规则'}`}
                                title="编辑"
                                onClick={() => openLoadEdit(item)}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="admin-icon-button admin-row-action admin-row-action-danger"
                                aria-label={`删除 ${item.name || '未命名规则'}`}
                                title="删除"
                                onClick={() => void deleteLoadNotification(item.id)}
                                disabled={pendingActions.has(`load:delete:${item.id}`)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sa-table-footer">共 {loadNotifications.length} 条规则</div>
              </>
            )}
          </Card>
        )
      )}

      {/* ─── 公网 IP 变更通知 ─── */}
      {activeTab === 'ipchange' && (
        tabLoading.ipchange ? <Loading /> : (
          <div className="sa-page sa-page-narrow">
            <Card>
              <CardHeader title="公网 IP 变更通知" description="可选功能，默认关闭；通过「通知设置」中选择的全局渠道发送" />
              <Rows>
                <SettingRow
                  label="启用公网 IP 变更通知（全局）"
                  description="总闸开关：当节点上报的公网出口 IP 发生变化时发送通知（IPv4 / IPv6 分开比较）。检测依据是 Agent 通过 api.ipify.org 等公网接口探测到的出口 IP，即节点页面展示的 IP，不是连接 Worker 的源 IP，因此双栈机器在两个地址族之间切换不会误报。修改后需点击右上角「保存设置」。下方还必须开启对应服务器的开关，两处同时开启才会发送。"
                >
                  <Switch
                    checked={settings.enable_ip_change_notification === 'true'}
                    onCheckedChange={(checked) => updateSetting('enable_ip_change_notification', checked ? 'true' : 'false')}
                    aria-label="启用公网 IP 变更通知"
                  />
                </SettingRow>
              </Rows>
            </Card>

            <Card>
              <CardHeader title="服务器开关" description="选择要监控公网 IP 变更的服务器，与上方全局开关同时开启才生效" />
              <div className="sa-toolbar">
                <div className="sa-toolbar-group">
                  <div className="sa-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      className="sa-input"
                      style={{ width: 220 }}
                      placeholder="搜索服务器"
                      aria-label="搜索服务器"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div className="sa-table-scroll">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th className="sa-td-name">服务器</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClients.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="sa-empty">
                          {searchTerm ? '没有匹配的服务器' : '暂无服务器'}
                        </td>
                      </tr>
                    ) : filteredClients.map((client) => {
                      const enabled = ipChangeNotificationMap.get(client.uuid)?.enable || false;
                      const displayIp = clientDisplayIp(client);
                      return (
                        <tr key={client.uuid} className="sa-tr">
                          <td className="sa-td-name">
                            <span className="sa-name-cell">
                              <span className="sa-ellipsis sa-cell-name" title={client.name || '未命名'}>{client.name || '未命名'}</span>
                              {displayIp && <span className="sa-mono sa-muted sa-cell-ip sa-ellipsis" title={displayIp}>{displayIp}</span>}
                            </span>
                          </td>
                          <td>
                            <Switch
                              checked={enabled}
                              onCheckedChange={(value) => toggleIpChange(client.uuid, value)}
                              disabled={pendingActions.has(`ipchange:${client.uuid}`)}
                              aria-label={`${client.name || '未命名'} IP 变更通知`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="sa-table-footer">共 {filteredClients.length} 台服务器</div>
            </Card>
          </div>
        )
      )}

      {/* ─── 离线通知：单个编辑 ─── */}
      <Dialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        size="sm"
        title="编辑离线通知"
        description={editingOffline ? activeClientName(editingOffline) : undefined}
        footer={(
          <>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>取消</Button>
            <Button onClick={() => void saveSingleEdit()} disabled={pendingActions.has('offline:edit')}>
              {pendingActions.has('offline:edit') ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      >
        <FormSwitch
          label="状态"
          checked={editForm.enable}
          onCheckedChange={(value) => setEditForm({ ...editForm, enable: value })}
        />
        <FormInput
          label="宽限期（秒）"
          type="number"
          value={String(editForm.grace_period)}
          onChange={(value) => setEditForm({ ...editForm, grace_period: value === '' ? 0 : Number(value) })}
          hint="服务器离线超过该时间后才会发送通知，避免网络抖动误报。"
        />
      </Dialog>

      {/* ─── 离线通知：批量编辑 ─── */}
      <Dialog
        open={batchDialogOpen}
        onOpenChange={setBatchDialogOpen}
        size="sm"
        title="批量编辑离线通知"
        description={`将为 ${selectedClients.length} 个选中节点统一设置离线通知参数`}
        footer={(
          <>
            <Button variant="outline" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button onClick={() => void saveBatchEdit()} disabled={pendingActions.has('offline:batch')}>
              {pendingActions.has('offline:batch') ? '保存中…' : `保存（${selectedClients.length} 节点）`}
            </Button>
          </>
        )}
      >
        <FormSwitch
          label="状态"
          checked={batchForm.enable}
          onCheckedChange={(value) => setBatchForm({ ...batchForm, enable: value })}
        />
        <FormInput
          label="宽限期（秒）"
          type="number"
          value={String(batchForm.grace_period)}
          onChange={(value) => setBatchForm({ ...batchForm, grace_period: value === '' ? 0 : Number(value) })}
          hint="服务器离线超过该时间后才会发送通知。"
        />
        {batchGraceMixed && (
          <Notice tone="warning" title="选中节点当前值不一致">
            已填入出现最多的值；保存后将统一为该值。
          </Notice>
        )}
      </Dialog>

      {/* ─── 到期通知：单个编辑 ─── */}
      <Dialog
        open={expiryEditDialogOpen}
        onOpenChange={setExpiryEditDialogOpen}
        size="sm"
        title="编辑到期通知"
        description={editingExpiry ? activeClientName(editingExpiry) : undefined}
        footer={(
          <>
            <Button variant="outline" onClick={() => setExpiryEditDialogOpen(false)}>取消</Button>
            <Button onClick={() => void saveExpirySingleEdit()} disabled={pendingActions.has('expiry:edit')}>
              {pendingActions.has('expiry:edit') ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      >
        <FormSwitch
          label="状态"
          checked={expiryEditForm.enable}
          onCheckedChange={(value) => setExpiryEditForm({ ...expiryEditForm, enable: value })}
        />
        <FormInput
          label="提前天数"
          type="number"
          min={1}
          max={365}
          value={String(expiryEditForm.advance_days)}
          onChange={(value) => setExpiryEditForm({ ...expiryEditForm, advance_days: value === '' ? 0 : Number(value) })}
          hint="节点到期前进入该天数窗口时发送一次提醒。"
        />
      </Dialog>

      {/* ─── 到期通知：批量编辑 ─── */}
      <Dialog
        open={expiryBatchDialogOpen}
        onOpenChange={setExpiryBatchDialogOpen}
        size="sm"
        title="批量编辑到期通知"
        description={`将为 ${selectedClients.length} 个选中节点统一设置到期提醒参数`}
        footer={(
          <>
            <Button variant="outline" onClick={() => setExpiryBatchDialogOpen(false)}>取消</Button>
            <Button onClick={() => void saveExpiryBatchEdit()} disabled={pendingActions.has('expiry:batch')}>
              {pendingActions.has('expiry:batch') ? '保存中…' : `保存（${selectedClients.length} 节点）`}
            </Button>
          </>
        )}
      >
        <FormSwitch
          label="状态"
          checked={expiryBatchForm.enable}
          onCheckedChange={(value) => setExpiryBatchForm({ ...expiryBatchForm, enable: value })}
        />
        <FormInput
          label="提前天数"
          type="number"
          min={1}
          max={365}
          value={String(expiryBatchForm.advance_days)}
          onChange={(value) => setExpiryBatchForm({ ...expiryBatchForm, advance_days: value === '' ? 0 : Number(value) })}
          hint="节点到期前进入该天数窗口时发送一次提醒。"
        />
        {expiryBatchDaysMixed && (
          <Notice tone="warning" title="选中节点当前值不一致">
            已填入出现最多的值；保存后将统一为该值。
          </Notice>
        )}
      </Dialog>

      {/* ─── 负载通知：新建 / 编辑 ─── */}
      <Dialog
        open={loadDialogOpen}
        onOpenChange={setLoadDialogOpen}
        size="md"
        title={editingLoad ? '编辑负载通知规则' : '新建负载通知规则'}
        footer={(
          <>
            <Button variant="outline" onClick={() => setLoadDialogOpen(false)}>取消</Button>
            <Button onClick={() => void saveLoadNotification()} disabled={pendingActions.has('load:save')}>
              {pendingActions.has('load:save') ? '保存中…' : (editingLoad ? '保存' : '创建')}
            </Button>
          </>
        )}
      >
        <FormInput
          label="规则名称"
          placeholder="CPU 高负载告警"
          value={loadForm.name || ''}
          onChange={(value) => setLoadForm({ ...loadForm, name: value })}
        />
        <FormSelect
          label="监测指标"
          value={loadForm.metric || 'cpu'}
          onChange={(value) => setLoadForm({ ...loadForm, metric: value })}
          options={loadMetricOptions}
        />
        <div className="sa-form-grid">
          <FormInput
            label={`阈值${loadMetricUnit(loadForm.metric) ? `（${loadMetricUnit(loadForm.metric)}）` : ''}`}
            type="number"
            min={0}
            step="any"
            value={String(loadForm.threshold ?? 80)}
            onChange={(value) => setLoadForm({ ...loadForm, threshold: value === '' ? 0 : Number(value) })}
          />
          <FormInput
            label="达标率（0–1）"
            type="number"
            min={0}
            max={1}
            step="any"
            value={String(loadForm.ratio ?? 0.8)}
            onChange={(value) => setLoadForm({ ...loadForm, ratio: value === '' ? 0 : Number(value) })}
            hint="监测窗口内超标采样比例，0.8 表示 80% 采样超标时触发。"
          />
          <FormInput
            label="监测间隔（分钟）"
            type="number"
            min={1}
            max={240}
            value={String(loadForm.interval_min || 15)}
            onChange={(value) => setLoadForm({ ...loadForm, interval_min: value === '' ? 0 : Number(value) })}
          />
        </div>
        <FormSwitch
          label="应用到所有服务器"
          checked={loadForm.all_clients === true}
          onCheckedChange={(value) => setLoadForm({ ...loadForm, all_clients: value })}
        />
        {!loadForm.all_clients && (
          <div className="sa-form-field">
            <span className="sa-form-label">选择服务器（至少一台）</span>
            <div className="sa-client-picker">
              {clients.length === 0 && <span className="sa-muted">暂无服务器，请先添加服务器</span>}
              {clients.map((client) => {
                const selected = loadForm.clients?.includes(client.uuid) || false;
                return (
                  <label key={client.uuid} className={selected ? 'is-selected' : undefined}>
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) => setLoadForm((current) => ({
                        ...current,
                        clients: checked
                          ? [...new Set([...(current.clients || []), client.uuid])]
                          : (current.clients || []).filter((uuid) => uuid !== client.uuid),
                      }))}
                      aria-label={client.name || client.uuid}
                    />
                    <span className="sa-ellipsis">{client.name || client.uuid}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
