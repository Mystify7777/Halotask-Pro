import { Task } from '../types/task';
import { dueDayKey } from '../utils/deadline';
import { dateKeyInZone, dateKeyOffsetInZone, getEffectiveTimeZone } from '../utils/timeZone';
import {
  getDateOnlyTasksInPhase,
  getSmartStartWindows,
  getTasksDueInNextHour,
  getTasksOverdueNow,
  reminderSchedulePart,
} from './deadlineLogic';
import { reminderIdentity } from './identity';
import { isWithinQuietHours, ReminderSettings } from './settings';

type ReminderType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

type ReminderEvent = {
  task: Task;
  type: ReminderType;
};

type ReminderSchedulerOptions = {
  getTasks: () => Task[];
  getSettings: () => ReminderSettings;
  /**
   * Delivers a reminder. For a date-only task's calendar-day reminder (Issue #42) a thrown error or a `false` return
   * means "not delivered": its receipt is withdrawn so the next poll inside the same day can try again (see
   * MAX_DAY_ATTEMPTS). Any other return value counts as delivered, and every other reminder ignores the result.
   */
  onReminder: (event: ReminderEvent) => unknown;
  intervalMs?: number;
};

const SESSION_KEY = 'halotask_notified';

// Calendar-day reminders of date-only tasks (Issue #42) are remembered across restarts, not just for the session: they
// are tied to a calendar day, so opening the app again the same day must not repeat them. A receipt records the due
// day (what lets old receipts be pruned) and the instant it was sent (what lets a time zone change be told apart from
// the day simply passing, see deliverDayReminder).
const DAY_RECEIPTS_KEY = 'halotask_day_reminders';
const DAY_RECEIPT_RETENTION_DAYS = 3;
/** The Web Lock that serialises the receipt check, the write and the delivery across the tabs of one browser. */
const DAY_LOCK_NAME = 'halotask-day-reminders';
/**
 * Delivery attempts for one calendar-day reminder before it is dropped for good. A failed attempt withdraws the receipt
 * so the next poll may retry, but only inside the reminder's own day (a due-today reminder is eligible on the due day
 * only, an overdue one on the day after only), so a reminder that never got through is never replayed afterwards. The
 * cap keeps a persistent failure (blocked permission, a throwing Notification constructor) from retrying every minute
 * and from re-relaying to the server each time.
 */
const MAX_DAY_ATTEMPTS = 3;
/**
 * Failed delivery attempts per calendar-day reminder, kept in localStorage so the cap survives a page reload, a
 * recreated scheduler and every other tab. It is a separate key from the receipts on purpose: the receipts keep
 * exactly the format they have always had, so another build reading them can never mistake a retry record for a sent
 * reminder. Entries use the receipts' keys (`day:<type>:<identity>:<due day>`), so due-today and overdue have separate
 * budgets, and are pruned with the same retention.
 */
const DAY_ATTEMPTS_KEY = 'halotask_day_reminder_attempts';

type DayReceipt = { day: string; at?: number };
type DayReceipts = Record<string, DayReceipt>;

/** One stored receipt. The first draft of this feature stored the bare due day; that still reads (without a time). */
const readReceipt = (value: unknown): DayReceipt | null => {
  if (typeof value === 'string') {
    return { day: value };
  }
  if (value && typeof value === 'object' && typeof (value as DayReceipt).day === 'string') {
    const { day, at } = value as DayReceipt;
    return typeof at === 'number' && Number.isFinite(at) ? { day, at } : { day };
  }
  return null;
};

const loadDayReceipts = (): DayReceipts => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DAY_RECEIPTS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const receipts: DayReceipts = {};
    for (const [key, value] of Object.entries(parsed)) {
      const receipt = readReceipt(value);
      if (receipt) {
        receipts[key] = receipt;
      }
    }
    return receipts;
  } catch {
    return {};
  }
};

/** true when the receipts were stored; false when localStorage refused them (see the fallback below). */
const saveDayReceipts = (receipts: DayReceipts): boolean => {
  try {
    localStorage.setItem(DAY_RECEIPTS_KEY, JSON.stringify(receipts));
    return true;
  } catch {
    return false;
  }
};

type DayAttempt = { day: string; n: number };
type DayAttempts = Record<string, DayAttempt>;

const loadDayAttempts = (): DayAttempts => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DAY_ATTEMPTS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const attempts: DayAttempts = {};
    for (const [key, value] of Object.entries(parsed)) {
      const { day, n } = (value ?? {}) as Partial<DayAttempt>;
      // Anything that is not a due day with a positive whole count is ignored, i.e. read as "no failures yet".
      if (typeof day === 'string' && typeof n === 'number' && Number.isInteger(n) && n > 0) {
        attempts[key] = { day, n };
      }
    }
    return attempts;
  } catch {
    return {};
  }
};

/** true when the attempts were stored; false when localStorage refused them (see the fallback below). */
const saveDayAttempts = (attempts: DayAttempts): boolean => {
  try {
    localStorage.setItem(DAY_ATTEMPTS_KEY, JSON.stringify(attempts));
    return true;
  } catch {
    return false;
  }
};

// When localStorage will not take a write (disabled, full, a restricted browsing mode) the state is kept here instead,
// for the lifetime of this JavaScript context. It is module-scoped on purpose: every scheduler created in this page
// shares it, so recreating a scheduler (an effect re-running, a remount) neither repeats a reminder that was sent nor
// resets the attempt budget. It is filled only while writes fail and emptied by the next write that succeeds, so with
// working storage it is always empty and storage alone is the truth. It does not survive a page reload and is not
// shared with other tabs: without usable storage nothing can be.
let fallbackReceipts: DayReceipts = {};
let fallbackAttempts: DayAttempts = {};
// Receipts this context withdrew (a failed delivery) or pruned whose removal localStorage refused, so the stale stored
// copy is still there. Remembered with the exact receipts that were withdrawn (a reminder can be withdrawn more than
// once, each time with a different `at`, so this is a list per reminder), so only THOSE copies are hidden: a newer
// receipt for the same reminder (another tab delivered it) is a different `at` and still counts.
let fallbackWithdrawn: Record<string, DayReceipt[]> = {};

/** Forgets the in-memory fallback, as a page reload would. Only tests need this. */
export const resetDayReminderFallback = (): void => {
  fallbackReceipts = {};
  fallbackAttempts = {};
  fallbackWithdrawn = {};
};

/**
 * Stores `receipts`. `withdrawn` are the receipts this call removed (the caller holds the exact copies). If storage
 * refuses the write, they are remembered so the stale stored copies cannot come back. They are taken from the caller,
 * never rediscovered by reading storage: a read can fail while a write fails, and the knowledge must survive that. The
 * record accumulates until a write succeeds.
 */
const sameReceipt = (a: DayReceipt, b: DayReceipt): boolean => a.day === b.day && a.at === b.at;

const persistReceipts = (receipts: DayReceipts, withdrawn: DayReceipts = {}): void => {
  if (saveDayReceipts(receipts)) {
    fallbackReceipts = {};
    fallbackWithdrawn = {};
    return;
  }

  // Also keep what a successful read shows storage holding that `receipts` no longer has (pruned receipts).
  const gone: Record<string, DayReceipt[]> = {};
  for (const [key, list] of Object.entries(fallbackWithdrawn)) {
    gone[key] = [...list];
  }
  const remember = (key: string, receipt: DayReceipt) => {
    gone[key] ??= [];
    if (!gone[key].some((known) => sameReceipt(known, receipt))) {
      gone[key].push(receipt);
    }
  };
  for (const [key, receipt] of Object.entries(withdrawn)) {
    remember(key, receipt);
  }
  for (const [key, stored] of Object.entries(loadDayReceipts())) {
    if (!(key in receipts)) {
      remember(key, stored);
    }
  }
  fallbackReceipts = receipts;
  fallbackWithdrawn = gone;
};

const persistAttempts = (attempts: DayAttempts): void => {
  fallbackAttempts = saveDayAttempts(attempts) ? {} : attempts;
};

const currentReceipts = (): DayReceipts => {
  const stored = loadDayReceipts();
  for (const [key, gone] of Object.entries(fallbackWithdrawn)) {
    // Hide the stored copy only while it is still one that was withdrawn.
    if (stored[key] && gone.some((known) => sameReceipt(known, stored[key]))) {
      delete stored[key];
    }
  }
  return { ...fallbackReceipts, ...stored };
};

/**
 * Stored attempts merged with the fallback, keeping the HIGHER count per reminder. A stale stored count (a write that
 * failed after it) must never lower what this context has already counted, or the cap could be outrun.
 */
const currentAttempts = (): DayAttempts => {
  const merged = loadDayAttempts();
  for (const [key, attempt] of Object.entries(fallbackAttempts)) {
    if ((merged[key]?.n ?? 0) < attempt.n) {
      merged[key] = attempt;
    }
  }
  return merged;
};

/** Drops entries whose due day is before `oldest`; true when something was dropped. */
const pruneBefore = (entries: Record<string, { day: string }>, oldest: string): boolean => {
  let pruned = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.day < oldest) {
      delete entries[key];
      pruned = true;
    }
  }
  return pruned;
};

const loadFiredKeys = (): Set<string> => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
};

const saveFiredKeys = (keys: Set<string>): void => {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...keys]));
  } catch {
    // ignore storage failures
  }
};

export const createReminderScheduler = ({
  getTasks,
  getSettings,
  onReminder,
  intervalMs = 60_000,
}: ReminderSchedulerOptions) => {
  let timer: number | null = null;
  const notifiedInSession = loadFiredKeys();

  const makeKey = (task: Task, type: ReminderType) => {
    return `${type}:${reminderIdentity(task)}:${reminderSchedulePart(task)}`;
  };

  const dispatchIfNeeded = (task: Task, type: ReminderType) => {
    const key = makeKey(task, type);
    if (notifiedInSession.has(key)) {
      return;
    }

    notifiedInSession.add(key);
    saveFiredKeys(notifiedInSession);
    onReminder({ task, type });
  };

  // A date-only task reminds by calendar day: "due today" on its due day, "overdue" on the day after, in the effective
  // zone (deadlineLogic.getDateOnlyReminderPhase). The receipt key names the task and its due day only, never the
  // zone, a start time or any other field, so a time zone change, an edit, a sync or a restart cannot send the same
  // reminder twice. Two further rules keep a time zone change from producing BOTH reminders for one due day:
  //  - once "overdue" has gone out, a later "due today" for that day (the zone moved back) is never sent;
  //  - "overdue" is not sent when the due-today reminder went out at an instant that the CURRENT zone already reads as
  //    after the due day: the zone moved forward and the day "ended" at once, and the user has just been told it is
  //    due. When the day simply passes (the due-today reminder was sent on or before the due day as the current zone
  //    reads it), "due today" then "overdue" on the next day is the normal sequence and both are sent.
  //
  // Delivery failures are budgeted per reminder (MAX_DAY_ATTEMPTS) and the count is persisted (DAY_ATTEMPTS_KEY), so
  // the budget holds across reloads, recreated schedulers and tabs. A failed attempt records itself first and then
  // withdraws the receipt, so an interruption between the two writes leaves the reminder suppressed, never retried
  // beyond its budget. Success retires the count.
  //
  // The whole sequence (read receipts and attempts, decide, write the receipt, deliver, record the outcome) is one
  // synchronous critical section, run under a Web Lock when the browser has one, so two tabs cannot interleave it.
  const deliverDayReminder = (task: Task, type: 'due-soon' | 'overdue', nowTime: number) => {
    const day = dueDayKey(task.dueDate);
    if (day === null) {
      return;
    }

    const zone = getEffectiveTimeZone();
    const keyFor = (kind: ReminderType) => `day:${kind}:${reminderIdentity(task)}:${day}`;
    const key = keyFor(type);

    // Other tabs' state is read fresh every time; the module's fallback covers a localStorage that refuses writes.
    const receipts = currentReceipts();
    const attempts = currentAttempts();
    if (receipts[key]) {
      return;
    }
    if ((attempts[key]?.n ?? 0) >= MAX_DAY_ATTEMPTS) {
      return; // the budget is spent (and the receipt may be gone): never try again for this reminder
    }
    if (type === 'due-soon' && receipts[keyFor('overdue')]) {
      return;
    }
    if (type === 'overdue') {
      const told = receipts[keyFor('due-soon')]?.at;
      if (told !== undefined && dateKeyInZone(told, zone) > day) {
        return;
      }
    }

    const oldest = dateKeyOffsetInZone(-DAY_RECEIPT_RETENTION_DAYS, nowTime, zone);
    pruneBefore(receipts, oldest);
    if (pruneBefore(attempts, oldest)) {
      persistAttempts(attempts);
    }

    receipts[key] = { day, at: nowTime };
    persistReceipts(receipts);

    let delivered = true;
    try {
      delivered = onReminder({ task, type }) !== false;
    } catch {
      delivered = false; // one task's failure must not stop the other reminders of this poll
    }

    if (delivered) {
      if (attempts[key]) {
        delete attempts[key]; // retire the retry state: the reminder went out
        persistAttempts(attempts);
      }
      return;
    }

    const failed = (attempts[key]?.n ?? 0) + 1;
    attempts[key] = { day, n: failed };
    persistAttempts(attempts); // count it BEFORE withdrawing the receipt (see above)
    if (failed >= MAX_DAY_ATTEMPTS) {
      return; // give up for this day: the receipt stays, so it is never replayed later
    }
    const withdrawn = receipts[key]; // the exact receipt being withdrawn
    delete receipts[key]; // withdrawn: the next poll in the same day may try again
    persistReceipts(receipts, { [key]: withdrawn });
  };

  const dispatchDayReminder = (task: Task, type: 'due-soon' | 'overdue', nowTime: number) => {
    const section = () => deliverDayReminder(task, type, nowTime);
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;

    // Without the Web Locks API (or if it fails) the same steps run directly. That is best-effort across tabs: two
    // tabs polling in the same instant can both pass the check. The notification's tag still makes the browser show
    // one notification for the pair, so the worst case is a second alert, not a second reminder on screen.
    if (!locks || typeof locks.request !== 'function') {
      section();
      return;
    }

    let ran = false;
    const run = () => {
      ran = true;
      section();
    };
    try {
      locks.request(DAY_LOCK_NAME, run).catch(() => {
        if (!ran) {
          section();
        }
      });
    } catch {
      if (!ran) {
        section();
      }
    }
  };

  const runNow = () => {
    const tasks = getTasks();
    const settings = getSettings();
    const nowTime = Date.now();

    if (!settings.enabled) {
      return;
    }

    if (isWithinQuietHours(new Date(nowTime), settings)) {
      return;
    }

    const dueSoon = settings.dueSoonEnabled ? getTasksDueInNextHour(tasks, nowTime, 60) : [];
    const overdue = getTasksOverdueNow(tasks, nowTime);
    const smartStartWindows = getSmartStartWindows(tasks, nowTime, settings.bufferMinutes);

    dueSoon.forEach((task) => dispatchIfNeeded(task, 'due-soon'));
    if (settings.overdueEnabled) {
      overdue.forEach((task) => dispatchIfNeeded(task, 'overdue'));
    }

    if (settings.dueSoonEnabled) {
      getDateOnlyTasksInPhase(tasks, 'due-today', nowTime).forEach((task) => dispatchDayReminder(task, 'due-soon', nowTime));
    }
    if (settings.overdueEnabled) {
      getDateOnlyTasksInPhase(tasks, 'overdue', nowTime).forEach((task) => dispatchDayReminder(task, 'overdue', nowTime));
    }

    smartStartWindows.forEach(({ task, latestStartTime, notifyAtTime, windowEndTime }) => {
      if (settings.workSessionSoonEnabled && nowTime >= notifyAtTime && nowTime < latestStartTime) {
        dispatchIfNeeded(task, 'work-session-soon');
      }

      if (settings.startNowEnabled && nowTime >= latestStartTime && nowTime < windowEndTime) {
        dispatchIfNeeded(task, 'start-now');
      }
    });
  };

  const start = () => {
    if (timer !== null) {
      return;
    }

    runNow();
    timer = window.setInterval(runNow, intervalMs);
  };

  const stop = () => {
    if (timer === null) {
      return;
    }

    window.clearInterval(timer);
    timer = null;
  };

  const resetSession = () => {
    notifiedInSession.clear();
  };

  return {
    start,
    stop,
    runNow,
    resetSession,
  };
};
