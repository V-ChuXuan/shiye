// Local Nova control using the installed Base UI Select primitive.
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function SelectControl({ value, onValueChange, options, label, disabled, id, className = '' }: SelectControlProps) {
  return <Select.Root value={value} onValueChange={next => { if (next !== null) onValueChange(next); }} disabled={disabled} items={options}>
    <Select.Trigger id={id} aria-label={label} className={`select-control ${className}`}><Select.Value /><Select.Icon><ChevronDown aria-hidden="true" /></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Positioner className="select-positioner" align="start" sideOffset={6} alignItemWithTrigger={false} collisionPadding={12}>
      <Select.Popup className="select-popup"><Select.List className="select-list">{options.map(option => <Select.Item key={option.value} value={option.value} label={option.label} className="select-option"><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}</Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}
