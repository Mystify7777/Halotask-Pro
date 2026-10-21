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
 * The exact deadline is derived, not stored: the due day plus dueTime, read in the VIEWER'S local zone
 * (`getExactDeadline`). A task with no dueTime has no exact deadline: it is due "sometime that day" and is never
 * turned into a midnight deadline. Daylight saving: a wall-clock time that does not exist on its day (the skipped hour
 * of spring-forward) resolves to the instant JavaScript picks (one hour later); an ambiguous one (the repeated hour of
 * fall-back) resolves to its first occurrence.
 */
import type { Task } from '../types/task';
import { isValidDateKey, localDateKeyOffset, toLocalDateKey } from './localDate';

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

/** The local instant (epoch ms) of a timed deadline; null for a date-only or unusable one. */
export const getExactDeadline = ({ dueDate, dueTime }: DueFields): number | null => {
  const day = dueDayKey(dueDate);
  if (!day || !isValidDueTime(dueTime)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const [hours, minutes] = dueTime.split(':').map(Number);
  const local = new Date(0);
  local.setFullYear(year, month - 1, date);
  local.setHours(hours, minutes, 0, 0);
  return local.getTime();
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
export const isPastDeadline = (task: DueFields, now: Date = new Date()): boolean => {
  const exact = getExactDeadline(task);
  if (exact !== null) return exact <= now.getTime();
  const day = dueDayKey(task.dueDate);
  return day !== null && day < toLocalDateKey(now);
};

export type DueState = 'none' | 'overdue' | 'today' | 'later';

export const getDueState = (task: DueFields, now: Date = new Date()): DueState => {
  const day = dueDayKey(task.dueDate);
  if (!day) return 'none';
  if (isPastDeadline(task, now)) return 'overdue';
  return day === toLocalDateKey(now) ? 'today' : 'later';
};

const localDateFromKey = (key: string): Date => {
  const [year, month, date] = key.split('-').map(Number);
  const local = new Date(0);
  local.setFullYear(year, month - 1, date);
  local.setHours(0, 0, 0, 0);
  return local;
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** "Due today", "Due tomorrow" or "Due Oct 20", plus ", 5:00 PM" when the task has a due time. */
export const formatDueLabel = (task: DueFields, now: Date = new Date()): string => {
  const day = dueDayKey(task.dueDate);
  if (!day) return '';

  const base =
    day === toLocalDateKey(now)
      ? 'Due today'
      : day === localDateKeyOffset(1, now)
        ? 'Due tomorrow'
        : `Due ${localDateFromKey(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  const exact = getExactDeadline(task);
  return exact === null ? base : `${base}, ${new Date(exact).toLocaleTimeString(undefined, TIME_FORMAT)}`;
};

/** "Starts Oct 20, 9:30 AM" (the viewer's local time), or '' when there is no usable start time. */
export const formatStartLabel = (startTime?: string | null): string => {
  const instant = getStartInstant(startTime);
  if (instant === null) return '';
  return `Starts ${new Date(instant).toLocaleString(undefined, { month: 'short', day: 'numeric', ...TIME_FORMAT })}`;
};

// ── Form <-> storage conversions ────────────────────────────────────────────────

const START_INPUT_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A `datetime-local` value (the user's local wall-clock time) as the ISO instant that is stored; null if empty or
 * invalid. Strict like the server: a date that does not exist (2026-02-30) is rejected, not rolled into March.
 */
export const startInputToIso = (input: string): string | null => {
  const match = START_INPUT_PATTERN.exec(input);
  if (!match || !isValidDateKey(match[1])) return null;
  const instant = new Date(input); // no zone in the string: read as local time
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
};

const pad = (value: number) => String(value).padStart(2, '0');

/** A stored start instant as a `datetime-local` value in the viewer's local zone; '' when absent or unparseable. */
export const isoToStartInput = (startTime?: string | null): string => {
  const instant = getStartInstant(startTime);
  if (instant === null) return '';
  const local = new Date(instant);
  return `${toLocalDateKey(local)}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
};
