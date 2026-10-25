import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDate, calendarMonthDays, isCalendarDateAllowed, parseCalendarDate, shanghaiToday, shiftCalendarDays, shiftCalendarMonths } from '../client/src/lib/calendar.js';

test('calendar validates actual Gregorian dates without local timezone conversion', () => {
  for (const value of ['2024-02-29', '2000-02-29', '0001-01-01', '0099-12-31', '9999-12-31']) assert.equal(calendarDate(parseCalendarDate(value)!), value);
  for (const value of ['2023-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-12', '0000-01-01', '2026-1-01', '2026-01-00', 'garbage']) assert.equal(parseCalendarDate(value), null);
});
test('calendar day/month movement handles leaps, year boundaries and month-day clamps', () => {
  assert.equal(shiftCalendarDays('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftCalendarDays('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftCalendarMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftCalendarMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(shiftCalendarMonths('2026-01-31', -1), '2025-12-31');
  assert.equal(shiftCalendarDays('2026-03-08', 1), '2026-03-09');
});
test('calendar weeks start Monday and range bounds remain date-only and inclusive', () => {
  const dates = calendarMonthDays('2026-10-24');
  assert.equal(dates.length, 42); assert.equal(dates[0], '2026-09-28'); assert.equal(dates.at(-1), '2026-11-08');
  assert.equal(isCalendarDateAllowed('2026-10-24', '2026-10-24', '2026-10-24'), true);
  assert.equal(isCalendarDateAllowed('2026-10-23', '2026-10-24'), false);
  assert.equal(isCalendarDateAllowed('2026-10-25', undefined, '2026-10-24'), false);
  assert.equal(isCalendarDateAllowed('2026-02-30'), false);
});
test('today follows Shanghai midnight rather than host timezone or UTC date', () => {
  assert.equal(shanghaiToday(new Date('2026-10-23T15:59:59Z')), '2026-10-23');
  assert.equal(shanghaiToday(new Date('2026-10-23T16:00:00Z')), '2026-10-24');
});
