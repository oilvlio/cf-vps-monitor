import {
  BANDWIDTH_UNITS,
  TRAFFIC_LIMIT_TYPES,
  TRAFFIC_LIMIT_UNITS,
  TrafficLimitFormValue,
  TrafficLimitMode,
} from '../../utils/traffic';
import { FormField } from '../ui/minimal';

export function TrafficLimitEditor({
  value,
  onChange,
}: {
  value: TrafficLimitFormValue;
  onChange: (value: TrafficLimitFormValue) => void;
}) {
  const update = (patch: Partial<TrafficLimitFormValue>) => onChange({ ...value, ...patch });

  return (
    <FormField label="流量限制" span>
      <div className="sa-traffic-controls">
        <select
          className="sa-input sa-select"
          aria-label="流量限制方式"
          value={value.mode}
          onChange={(event) => update({ mode: event.target.value as TrafficLimitMode })}
        >
          <option value="quota">固定流量</option>
          <option value="unlimited">无限流量</option>
          <option value="bandwidth">带宽无限</option>
        </select>

        {value.mode === 'quota' && (
          <>
            <input
              className="sa-input"
              type="number"
              min="0"
              step="0.01"
              aria-label="流量额度"
              value={value.value}
              onChange={(event) => update({ value: event.target.value })}
            />
            <select
              className="sa-input sa-select"
              aria-label="流量单位"
              value={value.unit}
              onChange={(event) => update({ unit: event.target.value as TrafficLimitFormValue['unit'] })}
            >
              {TRAFFIC_LIMIT_UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>{unit.label}</option>
              ))}
            </select>
            <select
              className="sa-input sa-select"
              aria-label="统计口径"
              value={value.type}
              onChange={(event) => update({ type: event.target.value })}
            >
              {TRAFFIC_LIMIT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </>
        )}

        {value.mode === 'bandwidth' && (
          <>
            <input
              className="sa-input"
              type="number"
              min="0"
              step="0.01"
              aria-label="带宽数值"
              value={value.bandwidthValue}
              onChange={(event) => update({ bandwidthValue: event.target.value })}
            />
            <select
              className="sa-input sa-select"
              aria-label="带宽单位"
              value={value.bandwidthUnit}
              onChange={(event) => update({ bandwidthUnit: event.target.value as TrafficLimitFormValue['bandwidthUnit'] })}
            >
              {BANDWIDTH_UNITS.map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </>
        )}
      </div>
    </FormField>
  );
}
