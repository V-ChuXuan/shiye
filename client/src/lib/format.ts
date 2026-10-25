const dateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const number = new Intl.NumberFormat('zh-CN');

export function formatDateTime(value?: string): string {
  if (!value) return '尚无记录';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? dateTime.format(milliseconds) : '日期无效';
  }
  return value.slice(0, 16);
}

export const formatNumber = (value: number) => number.format(value);
