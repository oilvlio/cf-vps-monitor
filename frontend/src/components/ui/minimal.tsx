/**
 * 极简后台基础组件，API 与视觉对齐 shadcn-admin（Button / Card / Input / Switch / AlertDialog）。
 * 样式见 styles/minimal-admin.css；没有引入 Tailwind，避免与 Radix Themes 的 CSS 变量冲突。
 * 后续迁移其他后台页面时直接复用这里的组件。
 */
import React, { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { AlertDialog, Switch as SwitchPrimitive, Tooltip } from 'radix-ui';

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
  type?: 'text' | 'number';
  placeholder?: string;
  /** 输入框内右侧的单位，例如「秒」。仅作视觉提示，不参与无障碍名称。 */
  suffix?: string;
  disabled?: boolean;
}

export function Field({ label, hint, aside, value, onChange, type = 'text', placeholder, suffix, disabled }: FieldProps) {
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
interface SwitchRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SwitchRow({ label, description, checked, onCheckedChange }: SwitchRowProps) {
  const id = useId();
  return (
    <div className="sa-scope sa-row">
      <div className="sa-row-label">
        <label htmlFor={id} className="sa-label">{label}</label>
        {description && <InfoTip text={description} />}
      </div>
      <SwitchPrimitive.Root
        id={id}
        className="sa-switch"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={description ? `${id}-description` : undefined}
      >
        <SwitchPrimitive.Thumb className="sa-switch-thumb" />
      </SwitchPrimitive.Root>
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
export function Badge({ variant = 'secondary', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: 'secondary' | 'outline' | 'warning' }) {
  return <span className={cx('sa-scope sa-badge', `sa-badge-${variant}`, className)} {...props} />;
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
