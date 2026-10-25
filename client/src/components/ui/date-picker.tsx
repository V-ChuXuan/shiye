import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from '@base-ui/react/popover';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { calendarMonthDays, isCalendarDateAllowed, parseCalendarDate, shanghaiToday, shiftCalendarDays, shiftCalendarMonths } from '../../lib/calendar';
import { Button } from './button';
import { Input } from './input';

interface DatePickerProps { value: string; onValueChange: (value: string) => void; label: string; min?: string; max?: string }
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const spokenDate = (value: string) => { const [year, month, day] = value.split('-').map(Number); return `${year}年${month}月${day}日`; };

export function DatePicker({ value, onValueChange, label, min, max }: DatePickerProps) {
  const today = shanghaiToday();
  const clamp = (day: string) => {
    if (Number(day.split('-')[0]) > 9999) return max || '9999-12-31';
    if (Number(day.split('-')[0]) < 1) return min || '0001-01-01';
    return day < (min || '0001-01-01') ? min || '0001-01-01' : day > (max || '9999-12-31') ? max || '9999-12-31' : day;
  };
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(value || clamp(today));
  const [focused, setFocused] = useState(value || clamp(today));
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const popup = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const inputId = useId(), titleId = useId(), errorId = useId();
  useEffect(() => { setDraft(value); setError(''); }, [value]);
  useEffect(() => {
    if (!open || !moveFocus.current) return;
    popup.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus(); moveFocus.current = false;
  }, [focused, month, open]);
  function openCalendar(next: boolean) {
    if (next) { const day = clamp(value || today); setMonth(day); setFocused(day); setDraft(value); setError(''); }
    setOpen(next);
  }
  function choose(day: string) { if (!day || isCalendarDateAllowed(day, min, max)) { onValueChange(day); setOpen(false); } }
  function apply() {
    if (!draft) { choose(''); return; }
    if (!parseCalendarDate(draft)) { setError('请输入有效日期，格式为 YYYY-MM-DD。'); return; }
    if (!isCalendarDateAllowed(draft, min, max)) { setError('日期超出可选范围。'); return; }
    choose(draft);
  }
  function navigateDay(event: KeyboardEvent, day: string) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string;
    if (event.key in step) next = shiftCalendarDays(day, step[event.key]);
    else if (event.key === 'Home') next = shiftCalendarDays(day, -(parseCalendarDate(day)!.getUTCDay() + 6) % 7);
    else if (event.key === 'End') next = shiftCalendarDays(day, 6 - (parseCalendarDate(day)!.getUTCDay() + 6) % 7);
    else if (event.key === 'PageUp' || event.key === 'PageDown') next = shiftCalendarMonths(day, event.key === 'PageUp' ? -1 : 1);
    else return;
    event.preventDefault(); next = clamp(next); moveFocus.current = true; setFocused(next); setMonth(next);
  }
  function changeMonth(offset: number) { const day = clamp(shiftCalendarMonths(focused, offset)); setMonth(day); setFocused(day); }
  const days = calendarMonthDays(month), shownMonth = parseCalendarDate(month)!;
  const canChangeMonth = (offset: number) => {
    const next = shiftCalendarMonths(month, offset);
    return Boolean(parseCalendarDate(next)) && (!min || next.slice(0, 7) >= min.slice(0, 7)) && (!max || next.slice(0, 7) <= max.slice(0, 7));
  };
  return <Popover.Root open={open} onOpenChange={openCalendar}>
    <Popover.Trigger render={<Button variant="outline" />} className="date-picker-trigger" aria-label={label}><span>{value || '年 / 月 / 日'}</span><CalendarDays aria-hidden="true" /></Popover.Trigger>
    <Popover.Portal><Popover.Positioner className="calendar-positioner" sideOffset={6} align="start" collisionPadding={12}>
      <Popover.Popup className="calendar-popup" ref={popup} aria-labelledby={titleId} initialFocus={() => popup.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`) || true}>
        <div className="calendar-heading"><Popover.Title id={titleId}>{label}</Popover.Title><Popover.Close render={<Button variant="ghost" size="icon-sm" />} aria-label="关闭日历"><X aria-hidden="true" /></Popover.Close></div>
        <div className="calendar-month"><Button variant="ghost" size="icon-sm" aria-label="上个月" disabled={!canChangeMonth(-1)} onClick={() => changeMonth(-1)}><ChevronLeft aria-hidden="true" /></Button><strong aria-live="polite">{shownMonth.getUTCFullYear()}年{shownMonth.getUTCMonth() + 1}月</strong><Button variant="ghost" size="icon-sm" aria-label="下个月" disabled={!canChangeMonth(1)} onClick={() => changeMonth(1)}><ChevronRight aria-hidden="true" /></Button></div>
        <div className="calendar-grid" role="grid" aria-label={`${shownMonth.getUTCFullYear()}年${shownMonth.getUTCMonth() + 1}月`}><div className="calendar-week" role="row">{weekdays.map(day => <span role="columnheader" key={day}>{day}</span>)}</div>{Array.from({ length: 6 }, (_, week) => <div className="calendar-week" role="row" key={week}>{days.slice(week * 7, week * 7 + 7).map(day => <div role="gridcell" aria-selected={day === value} key={day}><button type="button" data-day={day} data-outside={day.slice(0, 7) !== month.slice(0, 7)} data-selected={day === value} aria-current={day === today ? 'date' : undefined} aria-label={spokenDate(day)} disabled={!isCalendarDateAllowed(day, min, max)} tabIndex={day === focused ? 0 : -1} onFocus={() => setFocused(day)} onKeyDown={event => navigateDay(event, day)} onClick={() => choose(day)}>{Number(day.slice(-2))}</button></div>)}</div>)}</div>
        <div className="calendar-entry"><label className="sr-only" htmlFor={inputId}>输入{label}</label><Input id={inputId} value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} placeholder="YYYY-MM-DD" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }} /><Button variant="outline" size="sm" onClick={apply}>应用日期</Button></div>
        {error && <p className="calendar-error" id={errorId} role="alert">{error}</p>}
        <div className="calendar-footer"><Button variant="ghost" size="sm" onClick={() => choose('')}>清空</Button><Button variant="ghost" size="sm" disabled={!isCalendarDateAllowed(today, min, max)} onClick={() => choose(today)}>今天</Button></div>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
