/**
 * Deadline model shared by sorting, smart sections, task cards and reminders (Issues #9 and #10).
 *
 * Stored fields (see halotasks-server/src/models/Task.model.ts):
 *   dueDate   the due DAY. The client sends YYYY-MM-DD and the server stores it as UTC midnight, so the calendar day
 *             the user picked is the UTC date part of the stored instant (`dueDayKey`). It is NEVER read through the
 *             viewer's local zone: that shifts the day by one for anyone west of UTC.
 *   dueTime   optional wall-clock "HH:mm" on that day.
 *   startTime optional absolute instant (ISO 8601).
 *
 * The exact deadline is derived, not stored: the due day plus dueTime, read in the user's EFFECTIVE time zone
 * (`getExactDeadline`, utils/timeZone.ts: the saved IANA preference, else the device's zone). A task with no dueTime
 * has no exact deadline: it is due "sometime that day" and is never turned into a midnight deadline. Daylight saving
 * (utils/timeZone.ts): a wall-clock time that does not exist on its day (the skipped hour of spring-forward) resolves
 * to the instant one hour later; an ambiguous one (the repeated hour of fall-back) resolves to its first occurrence.
 *
 * Changing the zone moves NO stored value. `startTime` is an instant: it stays the same instant and is only displayed
 * differently. `dueDate` and `dueTime` stay the same calendar day and clock reading, so the deadline instant they name
 * moves with the zone. "Today", "tomorrow" and overdue are judged against the current day in the same zone.
 */
import type { Task } from '../types/task';
import { isValidDateKey } from './localDate';
import { dateKeyInZone, dateKeyOffsetInZone, getEffectiveTimeZone, timeOfDayInZone, zonedWallClockToInstant } from './timeZone';

export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidDueTime = (value: unknown): value is string =>
  typeof value === 'string' && DUE_TIME_PATTERN.test(value);

const MINUTES_PER_DAY = 24 * 60;

type DueFields = Pick<Task, 'dueDate' | 'dueTime'>;

/** The calendar day (YYYY-MM-DD) a due date names, or null when absent or unparseable. */
export const dueDayKey = (dueDate?: string | null): string | null => {
  if (!dueDate) return null;
  const time = new Date(dueDate).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

const minutesOfDay = (dueTime: string): number => {
  const [hours, minutes] = dueTime.split(':').map(Number);
  return hours * 60 + minutes;
};

/** The instant (epoch ms) of a timed deadline in `timeZone`; null for a date-only or unusable one. */
export const getExactDeadline = (
  { dueDate, dueTime }: DueFields,
  timeZone: string = getEffectiveTimeZone(),
): number | null => {
  const day = dueDayKey(dueDate);
  if (!day || !isValidDueTime(dueTime)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const [hours, minutes] = dueTime.split(':').map(Number);
  const instant = zonedWallClockToInstant(year, month, date, hours, minutes, timeZone);
  return Number.isNaN(instant) ? null : instant;
};

/** The instant a start time names, or null when absent or unparseable. */
export const getStartInstant = (startTime?: string | null): number | null => {
  if (!startTime) return null;
  const time = new Date(startTime).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * Orders deadlines: by due day, then by time of day. A date-only task sorts after the timed tasks of its own day
 * (it is due by the end of that day), and date-only tasks keep their established order among themselves (by day).
 * Tasks without a due date return null (callers put them last).
 */
const deadlineOrder = ({ dueDate, dueTime }: DueFields): { day: string; minutes: number } | null => {
  const day = dueDayKey(dueDate);
  if (!day) return null;
  return { day, minutes: isValidDueTime(dueTime) ? minutesOfDay(dueTime) : MINUTES_PER_DAY };
};

export const compareDeadlines = (a: DueFields, b: DueFields): number => {
  const first = deadlineOrder(a);
  const second = deadlineOrder(b);
  if (first === null && second === null) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  if (first.day !== second.day) return first.day < second.day ? -1 : 1;
  return first.minutes - second.minutes;
};

/** True once a task's deadline has passed: the exact instant for a timed task, the end of the day before today otherwise. */
export const isPastDeadline = (
  task: DueFields,
  now: Date = new Date(),
  timeZone: string = getEffectiveTimeZone(),
): boolean => {
  const exact = getExactDeadline(task, timeZone);
  if (exact !== null) return exact <= now.getTime();
  const day = dueDayKey(task.dueDate);
  return day !== null && day < dateKeyInZone(now, timeZone);
};

export type DueState = 'none' | 'overdue' | 'today' | 'later';

export const getDueState = (
  task: DueFields,
  now: Date = new Date(),
  timeZone: string = getEffectiveTimeZone(),
): DueState => {
  const day = dueDayKey(task.dueDate);
  if (!day) return 'none';
  if (isPastDeadline(task, now, timeZone)) return 'overdue';
  return day === dateKeyInZone(now, timeZone) ? 'today' : 'later';
};

/** A calendar day as a Date whose UTC fields are that day, so formatting it with timeZone 'UTC' cannot shift it. */
const utcDateFromKey = (key: string): Date => {
  const [year, month, date] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
};

/** "Oct 20": a due day (YYYY-MM-DD) as text, independent of the device's and the preferred zone. */
export const formatDayKey = (key: string): string =>
  utcDateFromKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** "Due today", "Due tomorrow" or "Due Oct 20", plus ", 5:00 PM" when the task has a due time. */
export const formatDueLabel = (
  task: DueFields,
  now: Date = new Date(),
  timeZone: string = getEffectiveTimeZone(),
): string => {
  const day = dueDayKey(task.dueDate);
  if (!day) return '';

  const base =
    day === dateKeyInZone(now, timeZone)
      ? 'Due today'
      : day === dateKeyOffsetInZone(1, now, timeZone)
        ? 'Due tomorrow'
        : `Due ${formatDayKey(day)}`;

  const exact = getExactDeadline(task, timeZone);
  return exact === null ? base : `${base}, ${new Date(exact).toLocaleTimeString(undefined, { ...TIME_FORMAT, timeZone })}`;
};

/** "Starts Oct 20, 9:30 AM" in `timeZone`, or '' when there is no usable start time. */
export const formatStartLabel = (startTime?: string | null, timeZone: string = getEffectiveTimeZone()): string => {
  const instant = getStartInstant(startTime);
  if (instant === null) return '';
  return `Starts ${new Date(instant).toLocaleString(undefined, { month: 'short', day: 'numeric', ...TIME_FORMAT, timeZone })}`;
};

// ── Form <-> storage conversions ────────────────────────────────────────────────

const START_INPUT_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A `datetime-local` value (a wall-clock reading in `timeZone`) as the ISO instant that is stored; null if empty or
 * invalid. Strict like the server: a date that does not exist (2026-02-30) is rejected, not rolled into March. The
 * zone is explicit, never the machine's: a nonexistent reading (spring-forward gap) resolves one hour later and a
 * repeated one (fall-back) to its first occurrence (utils/timeZone.ts).
 */
export const startInputToIso = (input: string, timeZone: string = getEffectiveTimeZone()): string | null => {
  const match = START_INPUT_PATTERN.exec(input);
  if (!match || !isValidDateKey(match[1])) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  const instant = zonedWallClockToInstant(year, month, day, Number(match[2]), Number(match[3]), timeZone);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
};

/** A stored start instant as a `datetime-local` value in `timeZone`; '' when absent or unparseable. */
export const isoToStartInput = (startTime?: string | null, timeZone: string = getEffectiveTimeZone()): string => {
  const instant = getStartInstant(startTime);
  if (instant === null) return '';
  return `${dateKeyInZone(instant, timeZone)}T${timeOfDayInZone(instant, timeZone)}`;
};
