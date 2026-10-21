import type { Task } from '../types/task';

let counter = 0;

/** A task with sensible defaults; override only what a test is about. */
export const makeTask = (overrides: Partial<Task> = {}): Task => {
  counter += 1;
  return {
    _id: `task-${counter}`,
    userId: 'user-1',
    title: `Task ${counter}`,
    description: '',
    completed: false,
    priority: 'medium',
    tags: [],
    estimatedMinutes: 0,
    reminderSent: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
};

/** The timezones the deadline code is exercised in: UTC, east, west, the two extremes, and one with DST. */
export const TIME_ZONES = [
  'UTC',
  'Asia/Kolkata', // +05:30, no DST
  'America/Los_Angeles', // -07:00 / -08:00, DST
  'America/New_York', // -04:00 / -05:00, DST
  'Pacific/Kiritimati', // +14:00 (the furthest east)
  'Pacific/Pago_Pago', // -11:00 (among the furthest west)
] as const;

// The client has no Node typings (and gains no dependency for tests): reach the process environment through a narrow type.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

/** Runs `fn` with the process timezone set to `tz`, restoring it afterwards, and proves the switch took effect. */
export const inTimeZone = <T>(tz: string, fn: () => T): T => {
  const original = env.TZ;
  env.TZ = tz;
  try {
    // Sanity: a fixed winter instant must show this zone's offset, or the test below would silently run in UTC.
    const probe = new Date('2026-01-15T12:00:00Z').getTimezoneOffset();
    if (tz === 'Asia/Kolkata' && probe !== -330) throw new Error(`TZ switch to ${tz} did not take effect (offset ${probe})`);
    if (tz === 'America/Los_Angeles' && probe !== 480) throw new Error(`TZ switch to ${tz} did not take effect (offset ${probe})`);
    return fn();
  } finally {
    if (original === undefined) delete env.TZ;
    else env.TZ = original;
  }
};
