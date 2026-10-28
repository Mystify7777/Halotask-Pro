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

const saveDayReceipts = (receipts: DayReceipts): void => {
  try {
    localStorage.setItem(DAY_RECEIPTS_KEY, JSON.stringify(receipts));
  } catch {
    // ignore storage failures: the in-memory copy still prevents repeats while this tab stays open
  }
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
  // This tab's own copy of the receipts: what keeps it from repeating itself when localStorage is unavailable.
  let memoryReceipts: DayReceipts = loadDayReceipts();
  const dayAttempts = new Map<string, number>();

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
  // The whole sequence (read receipts, decide, write the receipt, deliver, withdraw it if delivery failed) is one
  // synchronous critical section, run under a Web Lock when the browser has one, so two tabs cannot interleave it.
  const deliverDayReminder = (task: Task, type: 'due-soon' | 'overdue', nowTime: number) => {
    const day = dueDayKey(task.dueDate);
    if (day === null) {
      return;
    }

    const zone = getEffectiveTimeZone();
    const keyFor = (kind: ReminderType) => `day:${kind}:${reminderIdentity(task)}:${day}`;
    const key = keyFor(type);

    // Another tab's receipts are read fresh every time; this tab's own copy covers an unavailable localStorage.
    const receipts: DayReceipts = { ...memoryReceipts, ...loadDayReceipts() };
    if (receipts[key]) {
      return;
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
    for (const [staleKey, receipt] of Object.entries(receipts)) {
      if (receipt.day < oldest) {
        delete receipts[staleKey];
      }
    }

    receipts[key] = { day, at: nowTime };
    memoryReceipts = receipts;
    saveDayReceipts(receipts);

    let delivered = true;
    try {
      delivered = onReminder({ task, type }) !== false;
    } catch {
      delivered = false; // one task's failure must not stop the other reminders of this poll
    }

    if (delivered) {
      dayAttempts.delete(key);
      return;
    }

    const attempts = (dayAttempts.get(key) ?? 0) + 1;
    if (attempts >= MAX_DAY_ATTEMPTS) {
      dayAttempts.delete(key); // give up for this day: the receipt stays, so it is never replayed later
      return;
    }
    dayAttempts.set(key, attempts);
    delete receipts[key]; // withdrawn: the next poll in the same day may try again
    memoryReceipts = receipts;
    saveDayReceipts(receipts);
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
