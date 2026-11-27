import { toast } from 'sonner';
import {
  BILLING_CYCLE_OPTIONS,
  COMMON_CURRENCIES,
  formatBillingCycle,
  getLongTermDateValue,
} from '../../utils/billing';
import { Button, FormField, FormSelect } from '../ui/minimal';

export function CurrencySymbols({ onPick }: { onPick: (symbol: string) => void }) {
  return (
    <div className="sa-chip-list" role="group" aria-label="常用货币符号">
      {COMMON_CURRENCIES.map(({ symbol, name }) => (
        <button
          key={`${symbol}-${name}`}
          type="button"
          className="sa-chip-btn"
          aria-label={`选择${name}`}
          title={name}
          onClick={() => {
            onPick(symbol);
            toast.success(`已设置为${name}`);
          }}
        >
          {symbol}
        </button>
      ))}
    </div>
  );
}

export function BillingCycleSelect({
  value,
  onChange,
  label = '计费周期',
}: {
  value: number | string | null | undefined;
  onChange: (value: number) => void;
  label?: string;
}) {
  const selectedValue = String(value || 30);
  const hasPreset = BILLING_CYCLE_OPTIONS.some((option) => String(option.value) === selectedValue);
  const options = [
    ...(hasPreset ? [] : [{ value: selectedValue, label: formatBillingCycle(Number(selectedValue)) || `${selectedValue}天` }]),
    ...BILLING_CYCLE_OPTIONS.map((option) => ({ value: String(option.value), label: option.label })),
  ];

  return (
    <FormSelect
      label={label}
      value={selectedValue}
      onChange={(next) => onChange(parseInt(next, 10))}
      options={options}
    />
  );
}

export function ExpiryDateInput({
  value,
  onChange,
  label = '到期时间',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <FormField label={label}>
      <div className="sa-inline-row">
        <input
          className="sa-input"
          type="date"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button variant="outline" size="sm" onClick={() => onChange(getLongTermDateValue())}>设置长期</Button>
      </div>
    </FormField>
  );
}
