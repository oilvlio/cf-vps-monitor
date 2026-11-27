import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Palette, Plus, RotateCcw, Settings, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useDisplayTheme } from '../../contexts/DisplayThemeContext';
import { clearCachedPublicSettings } from '../../utils/publicSettings';
import { normalizeDisplayTheme } from '../../utils/displayTheme';
import { notifyThemeUpdated } from '../../utils/themeEvents';
import { fetchPublicBootstrap, type PublicBootstrapPayload } from '../../utils/publicBootstrap';
import ThemePreviewFrame from '../../components/ThemePreviewFrame';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  FormInput,
  FormSelect,
  FormSwitch,
  Notice,
  Switch,
} from '../../components/ui/minimal';

type ThemeConfigItem = {
  key?: string;
  name?: string;
  type: 'title' | 'switch' | 'select' | 'number' | 'string' | 'richtext' | 'color' | 'image' | 'range';
  options?: string;
  default?: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
};

type ThemeManifest = {
  name: string;
  short: string;
  configuration?: {
    data?: ThemeConfigItem[];
  };
};

type ThemeCard = {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  preview_url: string;
  active: boolean;
  deletable: boolean;
  configurable: boolean;
  manifest: ThemeManifest | null;
  config: Record<string, unknown>;
  custom_css: string;
};

type ThemesResponse = {
  active_theme: string;
  data: ThemeCard[];
};

function refreshActiveThemeStylesheet() {
  const link = document.getElementById('cf-monitor-active-theme-css') as HTMLLinkElement | null;
  if (link) link.href = `/api/theme/active.css?v=${Date.now()}`;
}

function configLabel(item: ThemeConfigItem) {
  return item.name || item.key || '';
}

const cssExampleSnippets = [
  {
    name: '背景/字体',
    css: `/* 全局背景和字体 */
.layout {
  background: #f8fafc;
  color: #111827;
}`,
  },
  {
    name: '导航栏',
    css: `/* 顶部导航栏 */
.nav-bar {
  background: rgba(255, 255, 255, 0.86);
  border-color: rgba(15, 23, 42, 0.12);
}`,
  },
  {
    name: '节点卡片',
    css: `/* 节点卡片 */
.node-card {
  border-radius: 16px;
  box-shadow: 0 14px 38px rgba(15, 23, 42, 0.1);
}`,
  },
  {
    name: '统计卡片',
    css: `/* 统计卡片 */
.monitor-stat-card {
  background: #ffffff;
}`,
  },
  {
    name: '进度条',
    css: `/* 进度条和状态色 */
.usage-bar-fill {
  background: linear-gradient(90deg, #22c55e, #0ea5e9);
}`,
  },
  {
    name: '移动端',
    css: `/* 移动端 */
@media (max-width: 640px) {
  .node-card {
    border-radius: 12px;
  }
}`,
  },
];

const themeCssExamples = cssExampleSnippets.map(item => item.css).join('\n\n');

type ThirdPartyThemeProbe = {
  ok: boolean;
  status: number;
  version: string;
  error: string;
};

type ThirdPartyThemeState = {
  enabled: boolean;
  theme_url: string;
  raw_base: string;
  probe: ThirdPartyThemeProbe | null;
};

const emptyThirdPartyTheme: ThirdPartyThemeState = { enabled: false, theme_url: '', raw_base: '', probe: null };

function readThirdPartyThemeState(result: unknown): ThirdPartyThemeState {
  if (!result || typeof result !== 'object') return emptyThirdPartyTheme;
  const record = result as Record<string, unknown>;
  const rawProbe = record.probe;
  let probe: ThirdPartyThemeProbe | null = null;
  if (rawProbe && typeof rawProbe === 'object') {
    const value = rawProbe as Record<string, unknown>;
    probe = {
      ok: value.ok === true,
      status: Number(value.status) || 0,
      version: String(value.version || ''),
      error: String(value.error || ''),
    };
  }
  return {
    enabled: record.enabled === true,
    theme_url: String(record.theme_url || ''),
    raw_base: String(record.raw_base || ''),
    probe,
  };
}

export default function AdminThemes() {
  const apiFetch = useApi();
  const { setDisplayTheme } = useDisplayTheme();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [themes, setThemes] = useState<ThemeCard[]>([]);
  const [editing, setEditing] = useState<ThemeCard | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [customCss, setCustomCss] = useState('');
  const [deleting, setDeleting] = useState<ThemeCard | null>(null);
  const [preview, setPreview] = useState<{ bootstrap: PublicBootstrapPayload; css: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewRequestRef = useRef(0);
  const [thirdPartyTheme, setThirdPartyTheme] = useState<ThirdPartyThemeState>(emptyThirdPartyTheme);
  const [thirdPartySaving, setThirdPartySaving] = useState(false);
  const [thirdPartyRefreshing, setThirdPartyRefreshing] = useState(false);

  function clearPreviewCss() {
    previewRequestRef.current += 1;
    setPreview(null);
    setPreviewing(false);
    document.getElementById('cf-monitor-theme-css-preview')?.remove();
  }

  async function loadThemes() {
    setLoading(true);
    try {
      const result = await apiFetch('/admin/themes') as ThemesResponse;
      setThemes(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '主题列表加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadThirdPartyTheme() {
    try {
      const result = await apiFetch('/admin/third-party-theme');
      setThirdPartyTheme(readThirdPartyThemeState(result));
    } catch {
      // 主题管理页的其他功能不因第三方主题配置读取失败而不可用。
    }
  }

  async function saveThirdPartyTheme() {
    setThirdPartySaving(true);
    try {
      const result = await apiFetch('/admin/third-party-theme', {
        method: 'POST',
        body: JSON.stringify({
          enabled: thirdPartyTheme.enabled,
          theme_url: thirdPartyTheme.theme_url,
        }),
      });
      if (result?.success) {
        const next = readThirdPartyThemeState(result);
        setThirdPartyTheme(next);
        if (next.enabled && next.probe && !next.probe.ok) {
          toast.error(`已保存，但上游不可用：${next.probe.error}`);
        } else {
          toast.success('第三方主题配置已保存');
        }
      } else {
        toast.error(result?.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setThirdPartySaving(false);
    }
  }

  async function refreshThirdPartyTheme() {
    setThirdPartyRefreshing(true);
    try {
      const result = await apiFetch('/admin/third-party-theme/refresh', { method: 'POST' });
      if (result?.success) {
        const next = readThirdPartyThemeState(result);
        setThirdPartyTheme(current => ({ ...current, probe: next.probe }));
        if (next.probe && !next.probe.ok) toast.error(`上游不可用：${next.probe.error}`);
        else toast.success('已刷新第三方主题缓存');
      } else {
        toast.error(result?.error || '刷新失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '刷新失败');
    } finally {
      setThirdPartyRefreshing(false);
    }
  }

  useEffect(() => {
    void loadThemes();
    void loadThirdPartyTheme();
  }, []);

  useEffect(() => {
    return () => { previewRequestRef.current += 1; };
  }, []);

  async function handleUpload(file: File | null) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setSaving(true);
    try {
      await apiFetch('/admin/themes/upload', { method: 'POST', body: form });
      toast.success('主题已上传');
      await loadThemes();
      refreshActiveThemeStylesheet();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSetTheme(theme: ThemeCard) {
    setSaving(true);
    try {
      await apiFetch('/admin/themes/set', {
        method: 'POST',
        body: JSON.stringify({ short: theme.short }),
      });
      const nextActiveTheme = theme.short;
      setThemes(items => items.map(item => ({ ...item, active: item.short === nextActiveTheme })));
      setDisplayTheme(normalizeDisplayTheme(nextActiveTheme));
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
      toast.success('主题已启用');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启用失败');
    } finally {
      setSaving(false);
    }
  }

  function openConfig(theme: ThemeCard) {
    clearPreviewCss();
    setEditing(theme);
    setEditConfig(theme.config || {});
    setCustomCss(theme.custom_css || '');
  }

  function closeConfig() {
    clearPreviewCss();
    setEditing(null);
  }

  function insertCssSnippet(css: string) {
    setCustomCss(current => [current.trimEnd(), css].filter(Boolean).join('\n\n'));
  }

  async function previewCustomCss() {
    const request = ++previewRequestRef.current;
    setPreviewing(true);
    try {
      const bootstrap = await fetchPublicBootstrap({ cacheBust: true });
      if (request !== previewRequestRef.current) return;
      setPreview({ bootstrap, css: customCss });
      toast.success('前台主题预览已更新');
    } catch (error) {
      if (request === previewRequestRef.current) toast.error(error instanceof Error ? error.message : '预览加载失败');
    } finally {
      if (request === previewRequestRef.current) setPreviewing(false);
    }
  }

  function restoreCustomCss() {
    setCustomCss(editing?.custom_css || '');
    clearPreviewCss();
    toast.success('已恢复为保存前内容');
  }

  async function saveConfig() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch('/admin/themes/settings', {
        method: 'POST',
        body: JSON.stringify({ short: editing.short, config: editConfig, custom_css: customCss }),
      });
      toast.success('主题配置已保存');
      closeConfig();
      await loadThemes();
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await apiFetch('/admin/themes/delete', {
        method: 'POST',
        body: JSON.stringify({ short: deleting.short }),
      });
      setDeleting(null);
      await loadThemes();
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
      toast.success('主题已删除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setSaving(false);
    }
  }

  function updateConfig(key: string, value: unknown) {
    setEditConfig(current => ({ ...current, [key]: value }));
  }

  function renderConfigField(item: ThemeConfigItem) {
    if (item.type === 'title') {
      return <div key={item.name || 'title'} className="sa-theme-config-title">{item.name}</div>;
    }
    if (!item.key) return null;
    const value = editConfig[item.key] ?? item.default ?? '';

    if (item.type === 'switch') {
      return (
        <FormSwitch
          key={item.key}
          label={configLabel(item)}
          hint={item.help}
          checked={Boolean(value)}
          onCheckedChange={checked => updateConfig(item.key!, checked)}
        />
      );
    }
    if (item.type === 'select') {
      const options = (item.options || '').split(',').map(option => option.trim()).filter(Boolean);
      return (
        <FormSelect
          key={item.key}
          label={configLabel(item)}
          hint={item.help}
          value={String(value)}
          options={options.map(option => ({ value: option, label: option }))}
          onChange={next => updateConfig(item.key!, next)}
        />
      );
    }
    if (item.type === 'richtext') {
      return (
        <FormInput
          key={item.key}
          label={configLabel(item)}
          hint={item.help}
          value={String(value)}
          textarea
          rows={4}
          onChange={next => updateConfig(item.key!, next)}
        />
      );
    }
    if (item.type === 'color') {
      return (
        <label key={item.key} className="sa-scope sa-form-field">
          <span className="sa-form-label">{configLabel(item)}</span>
          <input
            className="sa-theme-color"
            type="color"
            value={String(value || '#000000')}
            onChange={event => updateConfig(item.key!, event.target.value)}
          />
          {item.help && <span className="sa-form-hint">{item.help}</span>}
        </label>
      );
    }
    if (item.type === 'range') {
      const min = item.min ?? 0;
      const max = item.max ?? 100;
      const step = item.step ?? 1;
      const numberValue = Number(value || min);
      return (
        <label key={item.key} className="sa-scope sa-form-field">
          <span className="sa-form-label sa-form-label-row">
            <span>{configLabel(item)}</span>
            <span className="sa-muted sa-mono">{numberValue}</span>
          </span>
          <input
            className="sa-theme-range"
            type="range"
            min={min}
            max={max}
            step={step}
            value={numberValue}
            onChange={event => updateConfig(item.key!, Number(event.target.value))}
          />
          {item.help && <span className="sa-form-hint">{item.help}</span>}
        </label>
      );
    }
    return (
      <FormInput
        key={item.key}
        label={configLabel(item)}
        hint={item.help}
        type={item.type === 'number' ? 'number' : 'text'}
        placeholder={item.type === 'image' ? 'https://example.com/bg.webp 或 /api/theme/assets/主题ID/bg.webp' : undefined}
        value={String(value)}
        onChange={next => updateConfig(item.key!, item.type === 'number' ? Number(next) : next)}
      />
    );
  }

  function renderThemePreview(theme: ThemeCard) {
    return theme.preview_url ? <img src={theme.preview_url} alt="" /> : <Palette size={34} />;
  }

  if (loading) return <Loading />;

  return (
    <div className="sa-scope sa-page admin-themes-page">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <Palette size={20} />
          <span>主题管理</span>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={event => void handleUpload(event.target.files?.[0] || null)}
      />

      <div className="sa-page-actions">
        <p>
          主题包根目录需要 cf-monitor-theme.json；支持 CSS、图片、JSON 和 .woff2 字体；配置项支持 title、switch、select、number、string、richtext、color、image、range。
        </p>
        <Button variant="outline" disabled={saving} onClick={() => fileInputRef.current?.click()}>
          <Upload size={16} /> {saving ? '上传中…' : '上传主题包'}
        </Button>
      </div>

      <div className="sa-theme-grid">
        {themes.map(theme => (
          <Card key={theme.short} className="sa-theme-card">
            <div className="sa-theme-preview">
              {renderThemePreview(theme)}
            </div>
            <div className="sa-theme-head">
              <div style={{ minWidth: 0 }}>
                <div className="sa-theme-name">{theme.name}</div>
                <div className="sa-theme-meta">{theme.author || 'Unknown'}{theme.version ? ` · ${theme.version}` : ''}</div>
              </div>
              {theme.active ? <Badge variant="success"><Check size={12} /> 当前</Badge> : null}
            </div>
            <p className="sa-theme-description">{theme.description || '暂无描述'}</p>
            <div className="sa-theme-actions">
              <Button size="sm" variant={theme.active ? 'outline' : 'default'} disabled={saving || theme.active} onClick={() => void handleSetTheme(theme)}>
                <Check size={14} /> {theme.active ? '已启用' : '启用'}
              </Button>
              <Button size="sm" variant="outline" disabled={!theme.configurable} onClick={() => openConfig(theme)}>
                <Settings size={14} /> 配置
              </Button>
              <Button size="sm" variant="destructive" disabled={!theme.deletable} onClick={() => setDeleting(theme)}>
                <Trash2 size={14} /> 删除
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="第三方主题"
          action={thirdPartyTheme.enabled ? <Badge variant="success">已启用</Badge> : <Badge variant="secondary">未启用</Badge>}
        />
        <div className="sa-card-body sa-thirdparty-body">
          <div className="sa-row">
            <div className="sa-row-label">
              <span className="sa-label">启用第三方主题</span>
            </div>
            <div className="sa-control">
              <Switch
                checked={thirdPartyTheme.enabled}
                onCheckedChange={(checked) => setThirdPartyTheme(current => ({ ...current, enabled: checked }))}
                aria-label="启用第三方主题"
              />
            </div>
          </div>
          <p className="sa-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: 0 }}>
            启用后首页与详情页由 Monitor 主题接管，后台 <code>/admin</code> 保持原样。粘贴主题的 GitHub 仓库地址即可；系统会像原版 Monitor 一样读取最新 Release 的 <code>theme.tar.gz</code>（不是源码压缩包），无需补 <code>/tree/dist</code>。主题需要发布包含 <code>dist/index.html</code> 的 <code>theme.tar.gz</code>。
          </p>
          <FormInput
            label="主题仓库地址"
            placeholder="https://github.com/owner/repo"
            value={thirdPartyTheme.theme_url}
            onChange={(next) => setThirdPartyTheme(current => ({ ...current, theme_url: next }))}
          />
          {thirdPartyTheme.raw_base ? (
            <p className="sa-muted" style={{ fontSize: 12, margin: 0 }}>上游地址：{thirdPartyTheme.raw_base}</p>
          ) : null}
          {thirdPartyTheme.enabled && thirdPartyTheme.probe ? (
            thirdPartyTheme.probe.ok ? (
              <Notice tone="success" title="上游探活正常">
                HTTP {thirdPartyTheme.probe.status}
                {thirdPartyTheme.probe.version ? ` · ${thirdPartyTheme.probe.version}` : ''}
              </Notice>
            ) : (
              <Notice tone="warning" title="上游不可用">
                {thirdPartyTheme.probe.error}
                {thirdPartyTheme.probe.status ? `（HTTP ${thirdPartyTheme.probe.status}）` : ''}。首页会继续显示内置主题。
              </Notice>
            )
          ) : null}
          <div className="sa-page-actions">
            <Button disabled={thirdPartySaving} onClick={() => void saveThirdPartyTheme()}>
              {thirdPartySaving ? '保存中…' : '保存配置'}
            </Button>
            <Button variant="outline" disabled={thirdPartyRefreshing} onClick={() => void refreshThirdPartyTheme()}>
              <RotateCcw size={14} /> {thirdPartyRefreshing ? '刷新中…' : '刷新缓存'}
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={open => { if (!open) closeConfig(); }}
        size="xl"
        title={editing ? `配置主题 · ${editing.name}` : '配置主题'}
        footer={(
          <>
            <Button variant="outline" onClick={() => void previewCustomCss()} disabled={previewing}>
              <Eye size={14} /> {previewing ? '加载预览…' : '预览'}
            </Button>
            <Button variant="outline" onClick={restoreCustomCss}>
              <RotateCcw size={14} /> 恢复
            </Button>
            <Button variant="outline" onClick={closeConfig}>取消</Button>
            <Button disabled={saving} onClick={() => void saveConfig()}>{saving ? '保存中…' : '保存'}</Button>
          </>
        )}
      >
        <div className="sa-theme-config">
          {(editing?.manifest?.configuration?.data || []).map(renderConfigField)}
          <div className="sa-form-label">自定义 CSS</div>
          <p className="sa-form-hint" style={{ marginTop: -4 }}>
            可以调整前台页面的颜色、背景、字体、间距、圆角、阴影、导航栏、节点卡片、统计卡片、按钮、徽章和响应式样式；不能修改后台页面、数据来源、接口逻辑、通知规则或新增交互功能。
          </p>
          <textarea
            className="sa-input sa-textarea sa-theme-css-input"
            rows={10}
            spellCheck={false}
            value={customCss}
            onChange={event => setCustomCss(event.target.value)}
          />
          <div className="sa-theme-css-guide">
            <div className="sa-form-label">可改区域示例</div>
            <p className="sa-form-hint" style={{ marginTop: -4 }}>复制需要的片段到上方自定义 CSS 后修改数值即可。</p>
            <div className="sa-theme-snippets">
              {cssExampleSnippets.map(item => (
                <Button key={item.name} size="sm" variant="outline" onClick={() => insertCssSnippet(item.css)}>
                  <Plus size={12} /> 插入{item.name}
                </Button>
              ))}
            </div>
            <pre className="sa-code-block">{themeCssExamples}</pre>
          </div>
          {preview && <ThemePreviewFrame bootstrap={preview.bootstrap} css={preview.css} />}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="删除主题"
        description={<>确定删除 <strong>{deleting?.name}</strong> 吗？删除后主题资源会被移除。若正在启用，会切回 Monitor 主题。</>}
        confirmLabel="删除"
        destructive
        keepOpenOnConfirm
        confirmDisabled={saving}
        onConfirm={() => { void confirmDelete(); }}
      />
    </div>
  );
}
