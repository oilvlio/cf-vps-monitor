/**
 * 极简后台基础组件，API 与视觉对齐 shadcn-admin
 * （Button / Card / Input / Switch / AlertDialog / Dialog）。
 * 样式见 styles/minimal-admin.css；没有引入 Tailwind，避免与 Radix Themes 的 CSS 变量冲突。
 * 后续迁移其他后台页面时直接复用这里的组件。
 */
import React, { useId, useState } from 'react';
import { ChevronRight, Info, X } from 'lucide-react';
import { AlertDialog, Dialog as DialogPrimitive, Switch as SwitchPrimitive, Tooltip } from 'radix-ui';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ========== Button ========== */
type ButtonVariant = 'default' | 'outline' | 'destructive';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'default' | 'sm';
}

export function Button({ variant = 'default', size = 'default', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('sa-scope sa-btn', `sa-btn-${variant}`, size === 'sm' && 'sa-btn-sm', className)}
      {...props}
    />
  );
}

/* ========== Card ========== */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cx('sa-scope sa-card', className)} {...props} />;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <header className="sa-card-header">
      <div className="sa-card-heading">
        <h3 className="sa-card-title">{title}</h3>
        {description && <p className="sa-card-description">{description}</p>}
      </div>
      {action}
    </header>
  );
}

/* ========== CollapsibleCard（默认收起的渠道卡片，对齐 Monitor 默认主题） ==========
 * 标题行：旋转箭头 + 标题 + 简述，右侧放状态徽标（如「已配置 / 当前通道」），
 * 这样收起时也能一眼看出状态。原生 <details>，键盘与读屏开箱即用。
 */
export function CollapsibleCard({
  title,
  description,
  badges,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description?: string;
  badges?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="sa-collapsible">
      <details open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <summary className="sa-card-header sa-collapsible-summary">
          <span className="sa-card-heading">
            <ChevronRight className="sa-chevron" size={16} aria-hidden="true" />
            <span className="sa-card-title">{title}</span>
            {description && <span className="sa-card-description">{description}</span>}
          </span>
          {badges && <span className="sa-collapsible-badges">{badges}</span>}
        </summary>
        {children}
      </details>
    </Card>
  );
}

/** 行列表容器：每个 Field / SwitchRow 是一行，左标签右控件。 */
export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="sa-rows">{children}</div>;
}

/* ========== ⓘ 悬浮提示（hover / 键盘聚焦 / 点按都能打开） ========== */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={300}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <button type="button" className="sa-info" aria-label="查看说明" onClick={() => setOpen((value) => !value)}>
            <Info size={15} aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="sa-scope sa-tooltip" side="top" align="start" sideOffset={6} collisionPadding={12}>
            {text}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/* ========== Field（左：Label + ⓘ，右：Input） ========== */
interface FieldProps {
  label: string;
  /** 长说明，只在悬浮提示里显示；同时通过隐藏文本挂到 aria-describedby 供读屏使用。 */
  hint?: string;
  /** 输入框左侧的一小段常驻补充信息，例如「≈ 400.0 MiB」。 */
  aside?: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'password';
  placeholder?: string;
  /** 输入框内右侧的单位，例如「秒」。仅作视觉提示，不参与无障碍名称。 */
  suffix?: string;
  disabled?: boolean;
  autoComplete?: string;
}

export function Field({ label, hint, aside, value, onChange, type = 'text', placeholder, suffix, disabled, autoComplete }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="sa-scope sa-row">
      <div className="sa-row-label">
        <label htmlFor={id} className="sa-label">{label}</label>
        {hint && <InfoTip text={hint} />}
      </div>
      <div className="sa-control">
        {aside && <span className="sa-aside">{aside}</span>}
        <div className={cx('sa-input-wrap', suffix && 'has-suffix')}>
          <input
            id={id}
            className="sa-input"
            type={type}
            inputMode={type === 'number' ? 'numeric' : undefined}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete={autoComplete}
            aria-describedby={hint ? hintId : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
          {suffix && <span className="sa-input-suffix" aria-hidden="true">{suffix}</span>}
        </div>
      </div>
      {hint && <span id={hintId} className="sa-sr-only">{hint}</span>}
    </div>
  );
}

/* ========== Switch 行 ========== */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      className="sa-switch"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      onCheckedChange={onCheckedChange}
    >
      <SwitchPrimitive.Thumb className="sa-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

/** 弹窗里的开关字段：标签在上，开关在下方（带状态文字）。 */
export function FormSwitch({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="sa-scope sa-form-field">
      <label htmlFor={id} className="sa-form-label">{label}</label>
      <div className="sa-control">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
        <span className="sa-muted">{checked ? '已开启' : '已关闭'}</span>
      </div>
      {hint && <span className="sa-form-hint">{hint}</span>}
    </div>
  );
}

export function SwitchRow({ label, description, checked, onCheckedChange }: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="sa-scope sa-row">
      <div className="sa-row-label">
        <label htmlFor={id} className="sa-label">{label}</label>
        {description && <InfoTip text={description} />}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={description ? `${id}-description` : undefined}
      />
      {description && <span id={`${id}-description`} className="sa-sr-only">{description}</span>}
    </div>
  );
}

/* ========== Segmented（分段单选，等价于 Radix SegmentedControl） ========== */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cx('sa-scope sa-segmented', className)} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-state={value === option.value ? 'on' : 'off'}
          className="sa-segmented-item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ========== Checkbox（原生 input，支持半选） ========== */
export function Checkbox({
  checked,
  indeterminate,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <input
      type="checkbox"
      className="sa-scope sa-checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-checked={indeterminate ? 'mixed' : checked}
      ref={(element) => { if (element) element.indeterminate = Boolean(indeterminate) && !checked; }}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  );
}

/* ========== Badge ========== */
export function Badge({ variant = 'secondary', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: 'secondary' | 'outline' | 'warning' | 'success' | 'danger' | 'info' }) {
  return <span className={cx('sa-scope sa-badge', `sa-badge-${variant}`, className)} {...props} />;
}

/* ========== Notice（行内提示条） ========== */
export function Notice({
  tone = 'default',
  title,
  children,
}: {
  tone?: 'default' | 'warning' | 'success';
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cx('sa-scope sa-notice', tone !== 'default' && `sa-notice-${tone}`)}>
      {title && <strong>{title}</strong>}
      {children && <span>{children}</span>}
    </div>
  );
}

/* ========== SelectField（一行：标签 + ⓘ + 原生下拉） ========== */
export function SelectField<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  width = 300,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  width?: number | string;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="sa-scope sa-row">
      <div className="sa-row-label">
        <label htmlFor={id} className="sa-label">{label}</label>
        {hint && <InfoTip text={hint} />}
      </div>
      <div className="sa-control">
        <select
          id={id}
          className="sa-input sa-select"
          style={{ width }}
          value={value}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {hint && <span id={hintId} className="sa-sr-only">{hint}</span>}
    </div>
  );
}

/* ========== FormInput（弹窗里的字段：标签在上，输入框占满整行） ========== */
interface FormInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'password' | 'email' | 'tel' | 'url' | 'date';
  placeholder?: string;
  /** 常驻输入框下方的说明文字（弹窗里不隐藏，便于边填边看）。 */
  hint?: string;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  spellCheck?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  textarea?: boolean;
  rows?: number;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'none' | 'tel' | 'search' | 'email' | 'url';
}

export function FormInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  autoComplete,
  disabled,
  required,
  spellCheck,
  min,
  max,
  step,
  textarea,
  rows = 3,
  inputMode,
}: FormInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <label className="sa-scope sa-form-field" htmlFor={id}>
      <span className="sa-form-label">{label}</span>
      {textarea ? (
        <textarea
          id={id}
          className="sa-input sa-textarea"
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="sa-input"
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          required={required}
          spellCheck={spellCheck}
          min={min}
          max={max}
          step={step}
          inputMode={inputMode}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint && <span id={hintId} className="sa-form-hint">{hint}</span>}
    </label>
  );
}

/* ========== FormSelect（弹窗里的下拉：标签在上，下拉占满整行） ========== */
export function FormSelect<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <label className="sa-scope sa-form-field" htmlFor={id}>
      <span className="sa-form-label">{label}</span>
      <select
        id={id}
        className="sa-input sa-select"
        style={{ width: '100%' }}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {hint && <span id={hintId} className="sa-form-hint">{hint}</span>}
    </label>
  );
}

/* ========== Dialog（通用弹窗：标题 / 可滚动内容 / 底部按钮） ========== */
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: DialogSize;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sa-scope sa-overlay" />
        <DialogPrimitive.Content
          className={cx('sa-scope sa-modal', `sa-modal-${size}`, className)}
          aria-describedby={undefined}
        >
          <header className="sa-modal-header">
            <div className="sa-modal-heading">
              <DialogPrimitive.Title className="sa-modal-title">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="sa-modal-description">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="sa-modal-close" aria-label="关闭">
                <X size={16} aria-hidden="true" />
              </button>
            </DialogPrimitive.Close>
          </header>
          {children && <div className="sa-modal-body">{children}</div>}
          {footer && <div className="sa-modal-footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ========== 确认弹窗 ========== */
interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** 异步确认时置为 true：点确认后弹窗保持打开，由调用方在成功后自行关闭，失败时仍可重试。 */
  keepOpenOnConfirm?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  keepOpenOnConfirm,
  confirmDisabled,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sa-scope sa-overlay" />
        <AlertDialog.Content className="sa-scope sa-dialog">
          <AlertDialog.Title className="sa-dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="sa-dialog-description">{description}</AlertDialog.Description>
          <div className="sa-dialog-footer">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">取消</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={destructive ? 'destructive' : 'default'}
                disabled={confirmDisabled}
                onClick={(event) => {
                  if (keepOpenOnConfirm) event.preventDefault();
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/* ========== StatGrid（页面顶部统计卡） ========== */
export interface StatItem {
  label: string;
  value: string;
  detail?: string;
  icon?: React.ReactNode;
  title?: string;
}

export function StatGrid({ items, label }: { items: StatItem[]; label: string }) {
  return (
    <section className="sa-scope sa-stats" aria-label={label}>
      {items.map((item) => (
        <div className="sa-stat admin-overview-item" key={item.label} title={item.title}>
          <div className="sa-stat-head">
            <span className="sa-stat-label admin-overview-label">{item.label}</span>
            {item.icon && <span className="sa-stat-icon" aria-hidden="true">{item.icon}</span>}
          </div>
          <div className="sa-stat-value admin-overview-value">{item.value}</div>
          {item.detail && <div className="sa-stat-detail">{item.detail}</div>}
        </div>
      ))}
    </section>
  );
}
