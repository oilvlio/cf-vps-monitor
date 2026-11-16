/**
 * 后台表单的通用卡片 / 行 / 输入组件（极简风）。
 * API 与旧版保持一致，站点设置、通知管理等页面无需改动调用处即可换肤：
 * 长说明（description）收进标签旁的 ⓘ 悬浮提示，同时以隐藏文本挂到 aria-describedby。
 */
import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { InfoTip } from '../ui/minimal';

/* ========== Collapsible SettingCard ========== */
interface SettingCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingCard({
  title,
  description,
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
}: SettingCardProps) {
  const contentId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const toggle = () => {
    const next = !open;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setInternalOpen(next);
      onOpenChange?.(next);
    }
  };

  return (
    <section className="sa-scope sa-card sa-setting-card">
      <button
        type="button"
        className="setting-card-toggle sa-card-header sa-card-toggle"
        aria-label={title}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        <span className="sa-card-heading">
          <span className="sa-card-title">{title}</span>
          {description && <span className="sa-card-description">{description}</span>}
        </span>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button>
      <div id={contentId} hidden={!open} className="sa-card-body">
        {children}
      </div>
    </section>
  );
}

/* ========== Setting Row（左：标签 + ⓘ，右：控件） ========== */
interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  controlId?: string;
}

export function SettingRow({ label, description, children, controlId }: SettingRowProps) {
  return (
    <div className="sa-scope sa-row">
      <div className="sa-row-label">
        {controlId ? <label htmlFor={controlId} className="sa-label">{label}</label> : <span className="sa-label">{label}</span>}
        {description && <InfoTip text={description} />}
      </div>
      <div className="sa-control">{children}</div>
      {description && <span id={controlId ? `${controlId}-description` : undefined} className="sa-sr-only">{description}</span>}
    </div>
  );
}

/* ========== Setting Toggle ========== */
interface SettingToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingToggle({ label, description, checked, onCheckedChange }: SettingToggleProps) {
  const id = useId();
  return (
    <SettingRow label={label} description={description} controlId={id}>
      <SwitchPrimitive.Root
        id={id}
        className="sa-switch"
        aria-describedby={description ? `${id}-description` : undefined}
        checked={checked}
        onCheckedChange={onCheckedChange}
      >
        <SwitchPrimitive.Thumb className="sa-switch-thumb" />
      </SwitchPrimitive.Root>
    </SettingRow>
  );
}

/* ========== Setting Input ========== */
interface SettingInputProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  width?: number | string;
}

export function SettingInput({ label, description, value, onChange, type, placeholder, width }: SettingInputProps) {
  const id = useId();
  return (
    <SettingRow label={label} description={description} controlId={id}>
      <div className="sa-input-wrap" style={width ? { width } : undefined}>
        <input
          id={id}
          className="sa-input"
          aria-describedby={description ? `${id}-description` : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={type || 'text'}
          placeholder={placeholder}
        />
      </div>
    </SettingRow>
  );
}

/* ========== Setting Textarea（标签在上，文本框占满整行） ========== */
interface SettingTextareaProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}

export function SettingTextarea({ label, description, value, onChange, rows, placeholder }: SettingTextareaProps) {
  const id = useId();
  return (
    <div className="sa-scope sa-row sa-row-stack">
      <div className="sa-row-label">
        <label htmlFor={id} className="sa-label">{label}</label>
        {description && <InfoTip text={description} />}
      </div>
      <textarea
        id={id}
        className="sa-input sa-textarea"
        aria-describedby={description ? `${id}-description` : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows || 3}
        placeholder={placeholder}
      />
      {description && <span id={`${id}-description`} className="sa-sr-only">{description}</span>}
    </div>
  );
}
