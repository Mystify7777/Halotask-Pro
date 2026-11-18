import { HH_MM_PATTERN, type EmailReminderPrefs } from './emailReminderPrefs';
import { dateKeyInZone, dateKeyOffsetInZone, wallClockAt, zonedWallClockToInstant } from './zonedTime';

/**
 * The reminder engine (Issue #29, sections S3 and S6): PURE functions that say which reminder events are due for one
 * user's tasks at one instant. It decides WHEN, nothing else: no database, no clock of its own, no email, no state.
 *
 * It applies the SAME rules as the browser reminders (halotasks-client/src/reminders/deadlineLogic.ts and scheduler.ts)
 * so email never has its own reading of a deadline:
 *   - `dueDate` is a calendar day (its UTC date part); `dueTime` is a wall-clock "HH:mm" read in the zone; the exact
 *     deadline is that day and time in the zone (a task with no valid dueTime has NO deadline instant);
 *   - 'due-soon'      an exact deadline within the next 60 minutes;
 *   - 'overdue'       an exact deadline that has passed;
 *   - date-only task  'due-soon' ("due today") on its due day and 'overdue' on the day after, never any other day;
 *   - 'work-session-soon' / 'start-now'  the smart-start window: from an explicit `startTime` (instant), or else from
 *                     the deadline minus the estimate; the window ends at the exact deadline, or `bufferMinutes` after
 *                     an explicit start when there is no deadline.
 * tests/emailReminderParity.test.ts pins this module and the client's to the same vectors.
 *
 * Differences from the browser, and why (each is documented in docs/context.md "Email delivery"):
 *   - the 24 h bound on an exact-deadline 'overdue' email (OVERDUE_EMAIL_WINDOW_MS) is shared: since Issue #14 the browser
 *     bounds its timed-overdue notification the same way (OVERDUE_NOTIFICATION_WINDOW_MS), so this is no longer a
 *     difference. A server run has no session, so the bound is what stops it mailing every old overdue task.
 *   - the browser's rule that a time zone change must not produce BOTH the due-today and the overdue reminder of one
 *     date-only task is not ported. Both can be emailed if the zone is changed in between (at most one extra email).
 *
 * Event KEYS are the durable identity (the idempotency key in the delivery ledger). They name the task id, the reminder
 * type and the schedule that produced it, so a retry, a replayed run or a restart yields the same key, while changing
 * the due date, due time, start time or zone is a new schedule that may remind again, like the browser's.
 */

export const DUE_SOON_WINDOW_MINUTES = 60;
export const OVERDUE_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type ReminderType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

/** A task as the engine reads it: only what timing needs, plus the title and priority the message shows. */
export type EngineTask = {
  id: string;
  title: string;
  completed: boolean;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: Date | string | null;
  dueTime?: string | null;
  startTime?: Date | string | null;
  estimatedMinutes?: number | null;
};

export type ReminderEvent = {
  /** The durable idempotency key. */
  key: string;
  type: ReminderType;
  task: EngineTask;
  /** The exact deadline instant (epoch ms), or null for a date-only task. */
  deadline: number | null;
  /** The explicit start instant, or null. */
  start: number | null;
};

const instantOf = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/** The calendar day a stored due date names: its UTC date part (the client's `dueDayKey`). null when absent or unusable. */
export const dueDayKey = (dueDate: Date | string | null | undefined): string | null => {
  const time = instantOf(dueDate);
  return time === null ? null : new Date(time).toISOString().slice(0, 10);
};

/** The instant of a timed deadline in `timeZone`; null for a date-only or unusable one. */
export const exactDeadline = (task: Pick<EngineTask, 'dueDate' | 'dueTime'>, timeZone: string): number | null => {
  const day = dueDayKey(task.dueDate);
  if (!day || typeof task.dueTime !== 'string' || !HH_MM_PATTERN.test(task.dueTime)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const [hours, minutes] = task.dueTime.split(':').map(Number);
  const instant = zonedWallClockToInstant(year, month, date, hours, minutes, timeZone);
  return Number.isNaN(instant) ? null : instant;
};

/** What a reminder's identity depends on; the client's `reminderSchedulePart`, with the zone only where it matters. */
const schedulePart = (task: EngineTask, timeZone: string): string => {
  const start = instantOf(task.startTime);
  return (
    `${dueDayKey(task.dueDate) ?? 'no-due-date'}` +
    `${task.dueTime ? `:t${task.dueTime}@${timeZone}` : ''}` +
    `${start !== null ? `:s${new Date(start).toISOString()}` : ''}`
  );
};

const event = (type: ReminderType, task: EngineTask, key: string, timeZone: string): ReminderEvent => ({
  key,
  type,
  task,
  deadline: exactDeadline(task, timeZone),
  start: instantOf(task.startTime),
});

/**
 * Every reminder event that is due for `tasks` at `now`, in a deterministic order (type, then task id). It does not
 * apply quiet hours or the user's on/off switch: the caller decides whether to send. It does apply the per-type toggles
 * and `bufferMinutes`, because those change WHICH events exist.
 */
export const computeReminderEvents = (
  tasks: readonly EngineTask[],
  prefs: Pick<EmailReminderPrefs, 'dueSoonEnabled' | 'overdueEnabled' | 'workSessionSoonEnabled' | 'startNowEnabled' | 'bufferMinutes'>,
  timeZone: string,
  now: number,
): ReminderEvent[] => {
  const today = dateKeyInZone(now, timeZone);
  const yesterday = dateKeyOffsetInZone(-1, now, timeZone);
  const bufferMs = prefs.bufferMinutes * MINUTE_MS;
  const events: ReminderEvent[] = [];

  for (const task of tasks) {
    if (task.completed) continue;

    const deadline = exactDeadline(task, timeZone);
    const day = dueDayKey(task.dueDate);
    const part = schedulePart(task, timeZone);

    if (deadline !== null) {
      if (prefs.dueSoonEnabled && deadline > now && deadline <= now + DUE_SOON_WINDOW_MINUTES * MINUTE_MS) {
        events.push(event('due-soon', task, `task:due-soon:${task.id}:${part}`, timeZone));
      }
      if (prefs.overdueEnabled && deadline <= now && now - deadline <= OVERDUE_EMAIL_WINDOW_MS) {
        events.push(event('overdue', task, `task:overdue:${task.id}:${part}`, timeZone));
      }
    } else if (day !== null) {
      // A date-only task: calendar-day reminders only (Issue #42). The key names the task and its due day, nothing else.
      if (prefs.dueSoonEnabled && day === today) events.push(event('due-soon', task, `day:due-soon:${task.id}:${day}`, timeZone));
      if (prefs.overdueEnabled && day === yesterday) events.push(event('overdue', task, `day:overdue:${task.id}:${day}`, timeZone));
    }

    // The smart-start window: one per task.
    const explicitStart = instantOf(task.startTime);
    let latestStart: number | null = null;
    let notifyAt = 0;
    let windowEnd = 0;

    if (explicitStart !== null) {
      windowEnd = deadline ?? explicitStart + bufferMs;
      if (windowEnd > now) {
        latestStart = explicitStart;
        notifyAt = explicitStart - bufferMs;
      }
    } else if (deadline !== null && deadline > now && typeof task.estimatedMinutes === 'number' && task.estimatedMinutes > 0) {
      latestStart = deadline - task.estimatedMinutes * MINUTE_MS;
      notifyAt = latestStart - bufferMs;
      windowEnd = deadline;
    }

    if (latestStart !== null) {
      if (prefs.workSessionSoonEnabled && now >= notifyAt && now < latestStart) {
        events.push(event('work-session-soon', task, `task:work-session-soon:${task.id}:${part}`, timeZone));
      }
      if (prefs.startNowEnabled && now >= latestStart && now < windowEnd) {
        events.push(event('start-now', task, `task:start-now:${task.id}:${part}`, timeZone));
      }
    }
  }

  const order: Record<ReminderType, number> = { 'due-soon': 0, overdue: 1, 'work-session-soon': 2, 'start-now': 3 };
  return events.sort((a, b) => order[a.type] - order[b.type] || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0));
};

// ── Daily digest ───────────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many tasks per digest section; the rest are counted ("and N more"), never listed. */
export const DIGEST_SECTION_CAP = 10;
/** The digest looks this many days past today for "upcoming". */
export const DIGEST_UPCOMING_DAYS = 3;

export type DigestSection = { tasks: EngineTask[]; more: number };
export type Digest = {
  /** The idempotency key: one digest per user per local calendar day. */
  key: string;
  day: string;
  overdue: DigestSection;
  today: DigestSection;
  upcoming: DigestSection;
};

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const priorityRank = (task: EngineTask) => PRIORITY_RANK[task.priority ?? 'medium'] ?? 1;
const byId = (a: EngineTask, b: EngineTask) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byTitle = (a: EngineTask, b: EngineTask) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

/** A deadline's sort position: the due day, then the time (a date-only task sorts after the timed tasks of its day). */
const deadlineOrder = (task: EngineTask): string => `${dueDayKey(task.dueDate) ?? '9999-12-31'}T${task.dueTime && HH_MM_PATTERN.test(task.dueTime) ? task.dueTime : '24:00'}`;

const section = (tasks: EngineTask[]): DigestSection => ({ tasks: tasks.slice(0, DIGEST_SECTION_CAP), more: Math.max(0, tasks.length - DIGEST_SECTION_CAP) });

/**
 * The digest for the user's local day of `now`, or null when it should not be sent: digest off, before its time of day,
 * or nothing to say (an empty digest is never sent). Deterministic: the same tasks, preferences, zone and instant always
 * give the same digest, with every list in a fixed order (see below) and capped.
 *   overdue   incomplete tasks past their deadline (an exact deadline that has passed, or a due day before today),
 *             most overdue first
 *   today     incomplete tasks due today and not yet past, highest priority first, then by time of day
 *   upcoming  incomplete tasks due on each of the next DIGEST_UPCOMING_DAYS days, soonest first
 * Ties break on title, then id. It does not apply quiet hours: the caller defers a digest that falls inside them.
 */
export const computeDigest = (
  tasks: readonly EngineTask[],
  prefs: Pick<EmailReminderPrefs, 'digestEnabled' | 'digestTime'>,
  timeZone: string,
  now: number,
): Digest | null => {
  if (!prefs.digestEnabled) return null;

  const { hour, minute } = wallClockAt(now, timeZone);
  const [digestHour, digestMinute] = prefs.digestTime.split(':').map(Number);
  if (hour * 60 + minute < digestHour * 60 + digestMinute) return null;

  const day = dateKeyInZone(now, timeZone);
  const lastUpcoming = dateKeyOffsetInZone(DIGEST_UPCOMING_DAYS, now, timeZone);

  const overdue: EngineTask[] = [];
  const today: EngineTask[] = [];
  const upcoming: EngineTask[] = [];

  for (const task of tasks) {
    if (task.completed) continue;
    const dueDay = dueDayKey(task.dueDate);
    if (dueDay === null) continue;

    const deadline = exactDeadline(task, timeZone);
    const past = deadline !== null ? deadline <= now : dueDay < day;

    if (past) overdue.push(task);
    else if (dueDay === day) today.push(task);
    else if (dueDay > day && dueDay <= lastUpcoming) upcoming.push(task);
  }

  if (overdue.length + today.length + upcoming.length === 0) return null;

  overdue.sort((a, b) => deadlineOrder(a).localeCompare(deadlineOrder(b)) || byTitle(a, b) || byId(a, b));
  today.sort((a, b) => priorityRank(a) - priorityRank(b) || deadlineOrder(a).localeCompare(deadlineOrder(b)) || byTitle(a, b) || byId(a, b));
  upcoming.sort((a, b) => deadlineOrder(a).localeCompare(deadlineOrder(b)) || priorityRank(a) - priorityRank(b) || byTitle(a, b) || byId(a, b));

  return { key: `digest:${day}`, day, overdue: section(overdue), today: section(today), upcoming: section(upcoming) };
};
