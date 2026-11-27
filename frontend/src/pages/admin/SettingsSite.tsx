import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { RotateCcw, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { SettingInput, SettingRow } from '../../components/admin/SettingCard';
import { Button, Card, CardHeader, Rows } from '../../components/ui/minimal';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import { notifyPublicDataUpdated } from '../../utils/publicDataEvents';
import type { SettingsLayoutOutletContext } from './SettingsLayout';

const MAX_LOGO_BYTES = 1024 * 1024;

export default function SettingsSite() {
  const apiFetch = useApi();
  const { setAction, settingsCache, loadSettingsScope, setSettingsScope } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>(() => settingsCache.site || {});
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>(() => settingsCache.site || {});
  const [loading, setLoading] = useState(!settingsCache.site);
  const [settingsReady, setSettingsReady] = useState(Boolean(settingsCache.site));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadSettingsScope('site')
      .then((nextSettings) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setOriginalSettings(nextSettings);
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

  const handleSave = useCallback(async () => {
    if (!settingsReady || loading || loadError || saving) return;
    const changedSettings = getChangedSettings(settings, originalSettings);
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
        setOriginalSettings((prev) => ({ ...prev, ...changedSettings }));
        setSettingsScope('site', confirmed => ({ ...confirmed, ...changedSettings }));
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

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={!settingsReady || loading || Boolean(loadError) || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, settingsReady, loading, loadError, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  const handleUploadLogo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Logo 只支持 PNG、JPG、WebP');
      event.target.value = '';
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Logo 不能超过 1MB');
      event.target.value = '';
      return;
    }

    const form = new FormData();
    form.append('file', file);
    setLogoSaving(true);
    try {
      const result = await apiFetch('/admin/site-logo', { method: 'POST', body: form });
      const siteLogoUrl = typeof result.site_logo_url === 'string' ? result.site_logo_url : '';
      setSettings((prev) => ({ ...prev, site_logo_url: siteLogoUrl }));
      setOriginalSettings((prev) => ({ ...prev, site_logo_url: siteLogoUrl }));
      setSettingsScope('site', confirmed => ({ ...confirmed, site_logo_url: siteLogoUrl }));
      notifyPublicDataUpdated();
      toast.success('Logo 已上传');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Logo 上传失败');
    } finally {
      setLogoSaving(false);
      event.target.value = '';
    }
  };

  const handleResetLogo = async () => {
    setLogoSaving(true);
    try {
      await apiFetch('/admin/site-logo/reset', { method: 'POST' });
      setSettings((prev) => ({ ...prev, site_logo_url: '' }));
      setOriginalSettings((prev) => ({ ...prev, site_logo_url: '' }));
      setSettingsScope('site', confirmed => ({ ...confirmed, site_logo_url: '' }));
      notifyPublicDataUpdated();
      toast.success('已恢复默认 Logo');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复默认 Logo 失败');
    } finally {
      setLogoSaving(false);
    }
  };

  if (loading) return <Loading />;

  const loadFailure = loadError && (
    <div className="sa-scope sa-alert" role="alert">
      <span>读取设置失败：{loadError}</span>
      <Button variant="outline" size="sm" onClick={() => setReloadKey(value => value + 1)}>重试</Button>
    </div>
  );
  if (!settingsReady) return <div className="sa-scope sa-page">{loadFailure}</div>;

  return (
    <div className="sa-scope sa-page">
      {loadFailure}

      <Card>
        <CardHeader title="基本信息" description="站点名称、描述、语言与安装脚本域名" />
        <Rows>
          <SettingRow label="站点 Logo" description="显示在前台导航栏和后台登录页，支持 PNG、JPG、WebP，最大 1MB。">
            <span className="site-logo-preview sa-logo-preview">
              <img src={settings.site_logo_url || '/app-icon.webp'} alt="" />
            </span>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={handleUploadLogo}
            />
            <Button variant="outline" size="sm" disabled={logoSaving} onClick={() => logoInputRef.current?.click()}>
              <Upload size={14} /> {logoSaving ? '处理中...' : '上传 Logo'}
            </Button>
            <Button variant="outline" size="sm" disabled={logoSaving || !settings.site_logo_url} onClick={handleResetLogo}>
              <RotateCcw size={14} /> 恢复默认
            </Button>
          </SettingRow>
          <SettingInput
            label="站点标题"
            description="显示在导航栏和浏览器标签页"
            value={settings.site_title || ''}
            onChange={(value) => updateSetting('site_title', value)}
            placeholder="CF VPS Monitor"
          />
          <SettingInput
            label="站点副标题"
            description="显示在首页标题区"
            value={settings.site_subtitle || ''}
            onChange={(value) => updateSetting('site_subtitle', value)}
            placeholder="Cloudflare server monitor"
          />
          <SettingInput
            label="站点描述"
            description="用于页脚与元信息"
            value={settings.site_description || ''}
            onChange={(value) => updateSetting('site_description', value)}
            placeholder="服务器监控探针"
          />
          <SettingInput
            label="语言"
            description="界面语言设置"
            value={settings.language || 'zh-CN'}
            onChange={(value) => updateSetting('language', value)}
            placeholder="zh-CN"
          />
          <SettingInput
            label="脚本域名"
            description="生成安装命令时使用的站点地址；留空则使用当前域名"
            value={settings.script_domain || ''}
            onChange={(value) => updateSetting('script_domain', value)}
            placeholder={window.location.origin}
          />
        </Rows>
      </Card>
    </div>
  );
}
