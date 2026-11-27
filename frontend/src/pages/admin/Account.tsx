import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Download,
  KeyRound,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldOff,
  User,
} from 'lucide-react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { useApi, useAuth } from '../../contexts/AuthContext';
import { downloadRecoveryCodes, formatRecoveryCodesText, normalizeMfaCode, requestMfaStepUp } from '../../utils/mfa';
import { MIN_ADMIN_PASSWORD_LENGTH, validateAdminPasswordLength } from '../../utils/passwordPolicy';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  FormInput,
  Notice,
  Rows,
  Segmented,
} from '../../components/ui/minimal';

type AccountTab = 'username' | 'password' | 'security';

type MfaStatus = {
  enabled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
};

type MfaSetup = {
  setup_token: string;
  secret: string;
  uri: string;
};

export default function AdminAccount() {
  const apiFetch = useApi();
  const { user, updateUser } = useAuth();
  const [activeTab, setActiveTab] = useState<AccountTab>('username');
  const [username, setUsername] = useState(user?.username || '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [setupPassword, setSetupPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [showRebind, setShowRebind] = useState(false);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);

  useEffect(() => {
    setUsername(user?.username || '');
  }, [user?.username]);

  const loadMfaStatus = useCallback(async () => {
    try {
      setMfaStatus(await apiFetch('/admin/account/mfa'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法读取双重身份验证状态');
    }
  }, [apiFetch]);

  useEffect(() => {
    if (activeTab === 'security' && !mfaStatus) void loadMfaStatus();
  }, [activeTab, loadMfaStatus, mfaStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!setup?.uri) {
      setQrDataUrl('');
      return () => { cancelled = true; };
    }
    QRCode.toDataURL(setup.uri, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) toast.error('二维码生成失败，请手动输入密钥');
    });
    return () => { cancelled = true; };
  }, [setup?.uri]);

  const handleChangeUsername = async () => {
    const nextUsername = username.trim();
    if (!nextUsername) { toast.error('用户名不能为空'); return; }
    if (nextUsername === user?.username) { toast.info('用户名没有变化'); return; }

    setSavingUsername(true);
    try {
      const result = await apiFetch('/admin/account/username', {
        method: 'POST',
        body: JSON.stringify({ username: nextUsername }),
      });
      const nextUser = result.user || { username: nextUsername };
      updateUser(nextUser);
      setUsername(nextUser.username || nextUsername);
      toast.success('用户名修改成功');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSavingUsername(false);
    }
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) { toast.error('请填写所有字段'); return; }
    if (newPassword !== confirmPassword) { toast.error('两次输入的新密码不一致'); return; }
    const passwordError = validateAdminPasswordLength(newPassword);
    if (passwordError) { toast.error(passwordError); return; }

    setSaving(true);
    try {
      await apiFetch('/admin/account/chpasswd', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      });
      toast.success('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSaving(false);
    }
  };

  const startMfaSetup = async () => {
    if (!setupPassword) { toast.error('请输入当前密码'); return; }
    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ password: setupPassword }),
      });
      setSetup(result as MfaSetup);
      setSetupCode('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始绑定');
    } finally {
      setMfaLoading(false);
    }
  };

  const enableMfa = async () => {
    if (!setup) return;
    const code = normalizeMfaCode(setupCode, 'totp');
    if (!code) { toast.error('请输入 6 位动态验证码'); return; }

    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ setup_token: setup.setup_token, code }),
      });
      setRecoveryCodes(Array.isArray(result.recovery_codes) ? result.recovery_codes : []);
      setSetup(null);
      setSetupPassword('');
      setSetupCode('');
      await loadMfaStatus();
      toast.success('双重身份验证已启用');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启用失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const regenerateRecoveryCodes = async () => {
    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/recovery-codes', { method: 'POST' });
      setRecoveryCodes(Array.isArray(result.recovery_codes) ? result.recovery_codes : []);
      await loadMfaStatus();
      toast.success('恢复码已重新生成，旧恢复码已失效');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新生成失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const disableMfa = async () => {
    setDisableDialogOpen(false);
    if (!await requestMfaStepUp()) return;
    setMfaLoading(true);
    try {
      await apiFetch('/admin/account/mfa/disable', { method: 'POST' });
      setSetup(null);
      setSetupPassword('');
      await loadMfaStatus();
      toast.success('双重身份验证已关闭');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关闭失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const copyRecoveryCodes = async () => {
    await navigator.clipboard.writeText(formatRecoveryCodesText(recoveryCodes, user?.username || 'admin'));
    toast.success('恢复码已复制');
  };

  const usernameChanged = username.trim() !== (user?.username || '');

  return (
    <div className="sa-scope sa-page sa-page-narrow">
      <div className="admin-parent-title-row">
        <div className="sa-page-title">
          <User size={20} />
          <span>账户设置</span>
        </div>
      </div>

      <div className="sa-page-actions">
        <Segmented
          label="账户设置分类"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'username', label: '更改用户名' },
            { value: 'password', label: '更改密码' },
            { value: 'security', label: '身份验证' },
          ]}
        />
      </div>

      {activeTab === 'username' && (
        <Card>
          <CardHeader title="更改用户名" description="用于登录后台的用户名。" />
          <Rows>
            <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" />
          </Rows>
          <div className="sa-form-actions">
            <Button onClick={handleChangeUsername} disabled={savingUsername || !usernameChanged}>
              <Save size={16} /> {savingUsername ? '保存中…' : '修改用户名'}
            </Button>
          </div>
        </Card>
      )}

      {activeTab === 'password' && (
        <Card>
          <CardHeader title="更改密码" description="修改后需使用新密码重新登录。" />
          <Rows>
            <Field label="旧密码" type="password" value={oldPassword} onChange={setOldPassword} autoComplete="current-password" />
            <Field label="新密码" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" hint={`至少 ${MIN_ADMIN_PASSWORD_LENGTH} 位字符。`} />
            <Field label="确认新密码" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
          </Rows>
          <div className="sa-form-actions">
            <Button onClick={handleChangePassword} disabled={saving}>
              <Save size={16} /> {saving ? '保存中…' : '修改密码'}
            </Button>
          </div>
        </Card>
      )}

      {activeTab === 'security' && (
        <Card>
          <CardHeader
            title="TOTP 双重身份验证"
            description="兼容 Google Authenticator、Microsoft Authenticator、1Password 等验证器。"
            action={<Badge variant={mfaStatus?.enabled ? 'success' : 'secondary'}>{mfaStatus?.enabled ? '已启用' : '未启用'}</Badge>}
          />
          <div className="sa-card-body sa-mfa-body">
            {!mfaStatus ? (
              <p className="sa-muted" style={{ margin: 0 }}>正在读取状态…</p>
            ) : mfaStatus.enabled && !setup ? (
              <>
                <Notice tone="success" title="双重身份验证已开启">
                  账户已受双重身份验证保护，敏感操作确认在通过后 5 分钟内有效。
                </Notice>
                <dl className="sa-mfa-status">
                  <dt>启用时间</dt>
                  <dd>{mfaStatus.enabled_at ? new Date(mfaStatus.enabled_at).toLocaleString() : '-'}</dd>
                  <dt>剩余恢复码</dt>
                  <dd>{mfaStatus.recovery_codes_remaining} 个</dd>
                </dl>
                <div className="sa-toolbar-group">
                  <Button variant="outline" onClick={() => setShowRebind((value) => !value)} disabled={mfaLoading}>
                    <QrCode size={16} /> 重新绑定验证器
                  </Button>
                  <Button variant="outline" onClick={() => void regenerateRecoveryCodes()} disabled={mfaLoading}>
                    <RefreshCw size={16} /> 重新生成恢复码
                  </Button>
                  <Button variant="destructive" onClick={() => setDisableDialogOpen(true)} disabled={mfaLoading}>
                    <ShieldOff size={16} /> 关闭双重验证
                  </Button>
                </div>
                {showRebind && (
                  <div className="sa-mfa-rebind">
                    <div className="sa-form-label">重新绑定验证器</div>
                    <p className="sa-form-hint" style={{ marginTop: 2 }}>输入当前密码后生成新密钥；完成绑定前，现有验证器继续有效。</p>
                    <FormInput
                      label="当前密码"
                      type="password"
                      value={setupPassword}
                      onChange={setSetupPassword}
                      autoComplete="current-password"
                    />
                    <div className="sa-form-actions">
                      <Button onClick={() => void startMfaSetup()} disabled={mfaLoading || !setupPassword}>
                        <KeyRound size={16} /> 开始重新绑定
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : setup ? (
              <>
                <Notice tone="warning" title="请扫描二维码">
                  扫描二维码后输入当前动态验证码。验证成功前不会替换现有配置。
                </Notice>
                <div className="sa-mfa-layout">
                  <div className="sa-qr-box">
                    {qrDataUrl ? <img src={qrDataUrl} alt="TOTP 二维码" /> : <span className="sa-muted">正在生成二维码…</span>}
                  </div>
                  <div className="sa-mfa-fields">
                    <div>
                      <div className="sa-form-label">无法扫码时手动输入</div>
                      <code className="sa-secret">{setup.secret}</code>
                    </div>
                    <FormInput
                      label="6 位动态验证码"
                      value={setupCode}
                      onChange={setSetupCode}
                      placeholder="000000"
                      autoComplete="one-time-code"
                    />
                    <div className="sa-toolbar-group">
                      <Button onClick={() => void enableMfa()} disabled={mfaLoading}>
                        <ShieldCheck size={16} /> {mfaLoading ? '验证中…' : '确认启用'}
                      </Button>
                      <Button variant="outline" onClick={() => { setSetup(null); setSetupCode(''); }} disabled={mfaLoading}>
                        取消
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Notice title="启用双重身份验证">
                  启用后，登录后台及执行敏感操作时需要动态验证码或恢复码。
                </Notice>
                <FormInput
                  label="当前密码"
                  type="password"
                  value={setupPassword}
                  onChange={setSetupPassword}
                  autoComplete="current-password"
                  placeholder="验证当前密码后开始绑定"
                />
                <div className="sa-form-actions">
                  <Button onClick={() => void startMfaSetup()} disabled={mfaLoading || !setupPassword}>
                    <QrCode size={16} /> {mfaLoading ? '处理中…' : '开始设置'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={disableDialogOpen}
        onOpenChange={(open) => { if (!mfaLoading) setDisableDialogOpen(open); }}
        title="确认关闭双重身份验证"
        description="关闭后，登录和敏感操作将不再需要动态验证码，现有恢复码也会立即失效。"
        confirmLabel="确认关闭"
        destructive
        keepOpenOnConfirm
        confirmDisabled={mfaLoading}
        onConfirm={() => { void disableMfa(); }}
      />

      <Dialog
        open={recoveryCodes.length > 0}
        onOpenChange={(open) => { if (!open) setRecoveryCodes([]); }}
        size="md"
        title="保存恢复码"
        description="恢复码只显示这一次。每个恢复码只能使用一次，请离线安全保存。"
        footer={(
          <>
            <Button variant="outline" onClick={() => void copyRecoveryCodes()}><Copy size={16} /> 复制</Button>
            <Button variant="outline" onClick={() => downloadRecoveryCodes(recoveryCodes, user?.username || 'admin')}>
              <Download size={16} /> 下载文本
            </Button>
            <Button onClick={() => setRecoveryCodes([])}>我已保存</Button>
          </>
        )}
      >
        <div className="sa-recovery-grid">
          {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
        </div>
      </Dialog>
    </div>
  );
}
