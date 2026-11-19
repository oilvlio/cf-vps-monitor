import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { LIVE_POLL_SETTINGS_UPDATED_EVENT } from '../../contexts/livePolling';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import { notifyPublicDataUpdated } from '../../utils/publicDataEvents';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Field,
  Rows,
  SwitchRow,
} from '../../components/ui/minimal';
import type { SettingsLayoutOutletContext } from './SettingsLayout';

// 默认值与允许范围需与 worker/src/settings/schema.ts 保持一致。
const DEFAULT_RETENTION_HOURS = 720;
const MAX_RETENTION_HOURS = 720;
const DEFAULT_ACTIVE_SAMPLE_SEC = 3;
const DEFAULT_IDLE_UPLOAD_SEC = 120;
const MIN_IDLE_UPLOAD_SEC = 60;
const DEFAULT_VIEWER_TTL_SEC = 120;
const DEFAULT_RECORD_PERSIST_SEC = 120;
const DEFAULT_PING_RECORD_PERSIST_SEC = 120;
const DEFAULT_RECORD_HIGH_WATERMARK_ROWS = 700_000;
const DEFAULT_RECORD_HIGH_WATERMARK_BYTES = 419_430_400;
const DEFAULT_OFFLINE_CONFIRM_ROUNDS = 3;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function formatInteger(value: number | undefined): string {
  return Math.ceil(Number(value || 0)).toLocaleString();
}

function formatBinaryBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.round(value)} B`;
}

function getSettingValue(settings: SettingsMap, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
}

function normalizeGeneralSettings(settings: SettingsMap): SettingsMap {
  return { ...settings };
}

/** 保存前把需要夹取范围的字段归一化；其余字段原样提交，由 worker 的 schema 校验。 */
function buildSavePayload(settings: SettingsMap): SettingsMap {
  const retentionHours = clampInteger(
    settings.record_preserve_time || settings.ping_record_preserve_time,
    DEFAULT_RETENTION_HOURS,
    1,
    MAX_RETENTION_HOURS,
  );
  return {
    ...settings,
    record_preserve_time: String(retentionHours),
    ping_record_preserve_time: String(retentionHours),
    live_poll_active_interval_sec: String(clampInteger(settings.live_poll_active_interval_sec, DEFAULT_ACTIVE_SAMPLE_SEC, 3, 300)),
    live_poll_idle_interval_sec: String(clampInteger(settings.live_poll_idle_interval_sec, DEFAULT_IDLE_UPLOAD_SEC, MIN_IDLE_UPLOAD_SEC, 3600)),
    live_poll_active_max_duration_sec: String(clampInteger(settings.live_poll_active_max_duration_sec, DEFAULT_VIEWER_TTL_SEC, 60, 3600)),
    record_persist_interval_sec: String(clampInteger(settings.record_persist_interval_sec, DEFAULT_RECORD_PERSIST_SEC, 3, 3600)),
    ping_record_persist_interval_sec: String(clampInteger(settings.ping_record_persist_interval_sec, DEFAULT_PING_RECORD_PERSIST_SEC, 60, 3600)),
    record_high_watermark_rows: String(clampInteger(settings.record_high_watermark_rows, DEFAULT_RECORD_HIGH_WATERMARK_ROWS, 1000, 10_000_000)),
  };
}

export default function SettingsGeneral() {
  const apiFetch = useApi();
  const { setAction, settingsCache, loadSettingsScope, setSettingsScope } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>(() => normalizeGeneralSettings(settingsCache.general || {}));
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>(() => settingsCache.general || {});
  const [loading, setLoading] = useState(!settingsCache.general);
  const [settingsReady, setSettingsReady] = useState(Boolean(settingsCache.general));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadSettingsScope('general')
      .then((settingsData) => {
        if (cancelled) return;
        setSettings(normalizeGeneralSettings(settingsData));
        setOriginalSettings(settingsData);
        setSettingsReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '读取设置失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadSettingsScope, reloadKey]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // 监控历史与 Ping 历史共用同一个保留时长。
  const updateRetentionHours = (value: string) => {
    setSettings((prev) => ({
      ...prev,
      record_preserve_time: value,
      ping_record_preserve_time: value,
    }));
  };

  const field = (key: string, fallback: number | string) => getSettingValue(settings, key, String(fallback));

  const handleSave = useCallback(async () => {
    if (!settingsReady || loading || loadError || saving) return;
    const payload = buildSavePayload(settings);
    const changedSettings = getChangedSettings(payload, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        setSettings(payload);
        setOriginalSettings(payload);
        setSettingsScope('general', payload);
        window.dispatchEvent(new CustomEvent(LIVE_POLL_SETTINGS_UPDATED_EVENT, { detail: payload }));
        notifyPublicDataUpdated();
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, originalSettings, setSettingsScope, settings, settingsReady, loading, loadError, saving]);

  const handleMaintenanceCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      const result = await apiFetch('/admin/maintenance/cleanup', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.success) {
        const deleted = result.deleted || {};
        const totalDeleted = ['records', 'gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots', 'audit_logs']
          .reduce((sum, key) => sum + Number(deleted[key] || 0), 0);
        if (result.has_more) toast.info(`已清理一批，删除 ${formatInteger(totalDeleted)} 行历史数据；仍有过期记录，可继续清理`);
        else toast.success(`维护清理完成，删除 ${formatInteger(totalDeleted)} 行历史数据`);
      } else {
        toast.error(result.error || '维护清理失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '维护清理失败');
    } finally {
      setCleaning(false);
    }
  }, [apiFetch]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={!settingsReady || loading || Boolean(loadError) || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, settingsReady, loading, loadError, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  if (loading) return <Loading />;

  const loadFailure = loadError && (
    <div className="sa-scope sa-alert" role="alert">
      <span>读取设置失败：{loadError}</span>
      <Button variant="outline" size="sm" onClick={() => setReloadKey((value) => value + 1)}>重试</Button>
    </div>
  );
  if (!settingsReady) return <div className="sa-scope sa-page">{loadFailure}</div>;

  const budgetBytes = Number(field('record_high_watermark_bytes', DEFAULT_RECORD_HIGH_WATERMARK_BYTES));
  const budgetReadable = Number.isFinite(budgetBytes) && budgetBytes > 0 ? `≈ ${formatBinaryBytes(budgetBytes)}` : '';

  return (
    <div className="sa-scope sa-page">
      {loadFailure}

      <Card>
        <CardHeader title="数据记录" description="是否写入历史，以及保留多久" />
        <Rows>
          <SwitchRow
            label="启用数据记录"
            description="关闭后不再写入历史记录，但不影响实时数据展示。"
            checked={settings.record_enabled !== 'false'}
            onCheckedChange={(checked) => updateSetting('record_enabled', checked ? 'true' : 'false')}
          />
          <Field
            label="历史保留时长（小时）"
            type="number"
            suffix="小时"
            placeholder={String(DEFAULT_RETENTION_HOURS)}
            value={getSettingValue(settings, 'record_preserve_time', getSettingValue(settings, 'ping_record_preserve_time', String(DEFAULT_RETENTION_HOURS)))}
            onChange={updateRetentionHours}
            hint="超过这个时长的历史自动删除，最多 720 小时（30 天），监控与 Ping 历史通用。最近 1 天保留原始精度，更早的合并为每小时一个点。保留越久占用的数据库空间越大（约与天数成正比），超过熔断线会暂停历史写入。"
          />
        </Rows>
      </Card>

      <Card>
        <CardHeader title="Agent 上报" description="每台机器向 Worker 汇报数据的频率" />
        <Rows>
          <Field
            label="有人观看时 · 上报间隔（秒）"
            type="number"
            suffix="秒"
            placeholder={String(DEFAULT_ACTIVE_SAMPLE_SEC)}
            value={field('live_poll_active_interval_sec', DEFAULT_ACTIVE_SAMPLE_SEC)}
            onChange={(value) => updateSetting('live_poll_active_interval_sec', value)}
            hint="有人开着页面时汇报的频率。越小数字跳得越勤，也越耗额度。"
          />
          <Field
            label="无人观看时 · 上报间隔（秒）"
            type="number"
            suffix="秒"
            placeholder={String(DEFAULT_IDLE_UPLOAD_SEC)}
            value={field('live_poll_idle_interval_sec', DEFAULT_IDLE_UPLOAD_SEC)}
            onChange={(value) => updateSetting('live_poll_idle_interval_sec', value)}
            hint="没人看页面时汇报 CPU、内存等资源数据的频率，最少 60 秒，积压的 Ping 结果随这次一起发出。平时基本处在这一档，历史曲线相邻两点的间隔主要由它决定。"
          />
          <Field
            label="观看状态保持时长（秒）"
            type="number"
            suffix="秒"
            placeholder={String(DEFAULT_VIEWER_TTL_SEC)}
            value={field('live_poll_active_max_duration_sec', DEFAULT_VIEWER_TTL_SEC)}
            onChange={(value) => updateSetting('live_poll_active_max_duration_sec', value)}
            hint="最后一个访客离开后，继续按「有人观看」的频率汇报多久再降回慢频率，避免刷新页面时快慢来回切换。"
          />
        </Rows>
      </Card>

      <Card>
        <CardHeader title="历史落库" description="汇报上来的数据多久存一次档" />
        <Rows>
          <Field
            label="历史落库最小间隔（秒）"
            type="number"
            suffix="秒"
            placeholder={String(DEFAULT_RECORD_PERSIST_SEC)}
            value={field('record_persist_interval_sec', DEFAULT_RECORD_PERSIST_SEC)}
            onChange={(value) => updateSetting('record_persist_interval_sec', value)}
            hint="两次存档之间至少间隔这么久。实际间隔取这一项与上面「上报间隔」中较大的那个，所以设得比上报间隔更小没有效果。"
          />
          <Field
            label="Ping 探测与落库间隔（秒）"
            type="number"
            suffix="秒"
            placeholder={String(DEFAULT_PING_RECORD_PERSIST_SEC)}
            value={field('ping_record_persist_interval_sec', DEFAULT_PING_RECORD_PERSIST_SEC)}
            onChange={(value) => updateSetting('ping_record_persist_interval_sec', value)}
            hint="每隔多久测一次网络延迟，最少 60 秒。Agent 严格按此间隔探测，结果先在本地积压，随下一次上报一起发出并按各自探测时间入库，因此上报间隔再长也不会少存。与监控数据的存档间隔互不影响。"
          />
        </Rows>
      </Card>

      <Card>
        <CardHeader title="写入保护与告警" description="历史增长到上限时暂停写入；机器离线多久才告警" />
        <Rows>
          <Field
            label="历史有效数据预算（字节）"
            type="number"
            suffix="B"
            aside={budgetReadable}
            placeholder={String(DEFAULT_RECORD_HIGH_WATERMARK_BYTES)}
            value={field('record_high_watermark_bytes', DEFAULT_RECORD_HIGH_WATERMARK_BYTES)}
            onChange={(value) => updateSetting('record_high_watermark_bytes', value)}
            hint="历史数据（含索引）的估算占用达到这个大小就暂停写入历史，实时展示不受影响。这是估算值，不等于数据库文件的实际大小。默认 400 MiB，给其他数据留出空间。"
          />
          <Field
            label="历史写入熔断行数（行）"
            type="number"
            suffix="行"
            placeholder={String(DEFAULT_RECORD_HIGH_WATERMARK_ROWS)}
            value={field('record_high_watermark_rows', DEFAULT_RECORD_HIGH_WATERMARK_ROWS)}
            onChange={(value) => updateSetting('record_high_watermark_rows', value)}
            hint="第二道保险：历史记录条数达到这个数同样暂停写入，与上一项谁先到谁生效。条数只是粗略估计，一般不用改。"
          />
          <Field
            label="离线确认轮数（轮）"
            type="number"
            suffix="轮"
            placeholder={String(DEFAULT_OFFLINE_CONFIRM_ROUNDS)}
            value={field('offline_confirm_rounds', DEFAULT_OFFLINE_CONFIRM_ROUNDS)}
            onChange={(value) => updateSetting('offline_confirm_rounds', value)}
            hint="后台每 2 分钟检查一次机器是否在线，连续这么多次没连上才发离线告警，中间连上一次就重新计数。默认 3 次，约持续离线 6 分钟才告警，避免网络抖一下就误报。"
          />
        </Rows>
      </Card>

      <Card>
        <CardHeader
          title="维护清理"
          description="按当前保留时长立即删除过期历史与审计日志"
          action={(
            <Button variant="outline" size="sm" onClick={() => setConfirmCleanup(true)} disabled={cleaning}>
              {cleaning ? '清理中…' : '立即清理'}
            </Button>
          )}
        />
      </Card>

      <ConfirmDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title="确认维护清理？"
        description="将按当前保留时长删除过期历史记录和过期审计日志，删除后无法恢复。不影响实时展示、节点配置或当前有效记录。"
        confirmLabel="确认清理"
        destructive
        onConfirm={() => { void handleMaintenanceCleanup(); }}
      />
    </div>
  );
}
