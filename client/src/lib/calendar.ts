export function parseCalendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(12, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function calendarDate(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function shiftCalendarDays(value: string, days: number): string {
  const date = parseCalendarDate(value)!;
  date.setUTCDate(date.getUTCDate() + days);
  return calendarDate(date);
}

export function shiftCalendarMonths(value: string, months: number): string {
  const date = parseCalendarDate(value)!, day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(date); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return calendarDate(date);
}

export function calendarMonthDays(value: string): string[] {
  const first = `${value.slice(0, 7)}-01`, date = parseCalendarDate(first)!;
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => shiftCalendarDays(first, index - mondayOffset));
}

export function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

export function isCalendarDateAllowed(value: string, min?: string, max?: string): boolean {
  return Boolean(parseCalendarDate(value)) && (!min || value >= min) && (!max || value <= max);
}
