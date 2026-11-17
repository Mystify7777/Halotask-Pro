import { isPlainObject } from './requestBody';
import { isValidTimeZone, TIME_ZONE_INVALID_MESSAGE } from './timeZone';
import { wallClockAt } from './zonedTime';

/**
 * Email reminder preferences (Issue #29). Stored on the user as `emailReminders`; EVERY field is optional in storage and
 * an absent field reads as its default, so existing accounts need no migration and nothing writes a default.
 *
 * Email is OFF until the user turns it on (`enabled`). The toggles, the smart-start buffer and the quiet hours mirror the
 * browser reminder settings of the same names (client `reminders/settings.ts`), kept as a separate server-side copy
 * because the server cannot read the browser's localStorage and must decide without the browser open.
 *
 * Time zone: `timeZone` is an optional email-only override. Absent ("use account time zone") the email follows the
 * account's saved zone, including when that changes later; set, it stays fixed. With neither, UTC. The server has no
 * device zone, so it never guesses one.
 */

export const BUFFER_MINUTES = [15, 30, 60, 90] as const;
export type BufferMinutes = (typeof BUFFER_MINUTES)[number];
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type EmailReminderPrefs = {
  enabled: boolean;
  dueSoonEnabled: boolean;
  overdueEnabled: boolean;
  workSessionSoonEnabled: boolean;
  startNowEnabled: boolean;
  bufferMinutes: BufferMinutes;
  quietHoursStart: string;
  quietHoursEnd: string;
  digestEnabled: boolean;
  digestTime: string;
  /** The email-only override, or null = follow the account time zone. */
  timeZone: string | null;
};

export const DEFAULT_EMAIL_PREFS: EmailReminderPrefs = {
  enabled: false,
  dueSoonEnabled: true,
  overdueEnabled: true,
  workSessionSoonEnabled: true,
  startNowEnabled: true,
  bufferMinutes: 60,
  quietHoursStart: '22:30',
  quietHoursEnd: '07:00',
  digestEnabled: false,
  digestTime: '07:30',
  timeZone: null,
};

const BOOLEAN_FIELDS = ['enabled', 'dueSoonEnabled', 'overdueEnabled', 'workSessionSoonEnabled', 'startNowEnabled', 'digestEnabled'] as const;
const TIME_FIELDS = ['quietHoursStart', 'quietHoursEnd', 'digestTime'] as const;
export const EMAIL_PREF_KEYS = [...BOOLEAN_FIELDS, ...TIME_FIELDS, 'bufferMinutes', 'timeZone'] as const;

/** Reads stored preferences, filling every missing or unusable field with its default. Never throws. */
export const resolveEmailPrefs = (stored: unknown): EmailReminderPrefs => {
  const raw = isPlainObject(stored) ? stored : {};
  const prefs: EmailReminderPrefs = { ...DEFAULT_EMAIL_PREFS };
  for (const key of BOOLEAN_FIELDS) {
    if (typeof raw[key] === 'boolean') prefs[key] = raw[key];
  }
  for (const key of TIME_FIELDS) {
    const value = raw[key];
    if (typeof value === 'string' && HH_MM_PATTERN.test(value)) prefs[key] = value;
  }
  if (BUFFER_MINUTES.includes(raw.bufferMinutes as BufferMinutes)) prefs.bufferMinutes = raw.bufferMinutes as BufferMinutes;
  if (isValidTimeZone(raw.timeZone)) prefs.timeZone = raw.timeZone;
  return prefs;
};

/** The zone email scheduling reads in: the override, else the account's saved zone, else UTC. */
export const effectiveEmailTimeZone = (prefs: EmailReminderPrefs, accountTimeZone: unknown): string =>
  prefs.timeZone ?? (isValidTimeZone(accountTimeZone) ? accountTimeZone : 'UTC');

export type PrefsUpdate =
  | { ok: true; set: Record<string, unknown>; unset: string[] }
  | { ok: false; message: string };

/**
 * A PUT body: a partial object of the preference fields. Strict: an unknown key, a wrong type or an unusable value is
 * rejected whole (nothing is written), and so is an empty object, so a request cannot silently do nothing.
 * `timeZone: null` removes the override.
 */
export const parseEmailPrefsUpdate = (body: unknown): PrefsUpdate => {
  if (!isPlainObject(body)) return { ok: false, message: 'Request body must be a JSON object.' };

  const keys = Object.keys(body);
  if (keys.length === 0) return { ok: false, message: 'Send at least one email reminder preference to change.' };

  const known = new Set<string>(EMAIL_PREF_KEYS);
  const unknown = keys.find((key) => !known.has(key));
  if (unknown !== undefined) return { ok: false, message: `Unknown email reminder preference "${unknown.slice(0, 40)}".` };

  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  for (const key of keys) {
    const value = body[key];
    if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return { ok: false, message: `${key} must be true or false.` };
      set[`emailReminders.${key}`] = value;
    } else if ((TIME_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || !HH_MM_PATTERN.test(value)) return { ok: false, message: `${key} must be a time as HH:mm (00:00 to 23:59).` };
      set[`emailReminders.${key}`] = value;
    } else if (key === 'bufferMinutes') {
      if (!BUFFER_MINUTES.includes(value as BufferMinutes)) return { ok: false, message: `bufferMinutes must be one of ${BUFFER_MINUTES.join(', ')}.` };
      set['emailReminders.bufferMinutes'] = value;
    } else {
      // timeZone
      if (value === null) unset.push('emailReminders.timeZone');
      else if (isValidTimeZone(value)) set['emailReminders.timeZone'] = value;
      else return { ok: false, message: TIME_ZONE_INVALID_MESSAGE };
    }
  }

  return { ok: true, set, unset };
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Whether `instant` falls inside the quiet hours, read on the clock of `timeZone`. Same rule as the browser's
 * `isWithinQuietHours`: the end is exclusive, a window that crosses midnight wraps, and start == end means "no quiet hours".
 */
export const isInQuietHours = (instant: number, timeZone: string, start: string, end: string): boolean => {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === endMinutes) return false;

  const { hour, minute } = wallClockAt(instant, timeZone);
  const now = hour * 60 + minute;
  return startMinutes < endMinutes ? now >= startMinutes && now < endMinutes : now >= startMinutes || now < endMinutes;
};
