import { afterEach, describe, expect, it, vi } from 'vitest';
import { clockOf } from '../test/localeText';
import { inTimeZone, makeTask } from '../test/taskFactory';
import { getReminderPayload, getTimedReminderPayload, reminderPayloadFor, sendReminderNotification } from './notification';

// The server's push relay validator caps the tag (halotasks-server/src/utils/pushValidators.ts: PUSH_TAG_MAX_LENGTH).
const PUSH_TAG_MAX_LENGTH = 200;
const OBJECT_ID = '507f1f77bcf86cd799439011';

describe('reminder notification payload', () => {
  it('keeps the exact tag and body it always had for a task without a due time or start time', () => {
    const task = makeTask({ _id: OBJECT_ID, title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z' });
    expect(getReminderPayload(task, 'overdue')).toEqual({
      title: 'Task overdue',
      body: 'Write report is now overdue.',
      tag: `halotask-overdue-${OBJECT_ID}-2026-10-20T00:00:00.000Z`,
    });
    expect(getReminderPayload(makeTask({ _id: OBJECT_ID, title: 'x' }), 'due-soon').tag).toBe(`halotask-due-soon-${OBJECT_ID}-no-due-date`);
  });

  it('puts the due time and start time in the tag so a changed schedule is not swallowed as a duplicate', () => {
    const base = makeTask({ _id: OBJECT_ID, dueDate: '2026-10-20T00:00:00.000Z' });
    const tags = new Set([
      getReminderPayload(base, 'start-now').tag,
      getReminderPayload({ ...base, dueTime: '17:30' }, 'start-now').tag,
      getReminderPayload({ ...base, startTime: '2026-10-20T09:00:00.000Z' }, 'start-now').tag,
    ]);
    expect(tags.size).toBe(3);
  });

  it('fits the server\'s tag limit with the longest schedule a task can have', () => {
    const task = makeTask({
      _id: OBJECT_ID,
      dueDate: '2026-10-20T00:00:00.000Z',
      dueTime: '23:59',
      startTime: '2026-10-20T23:59:59.999Z',
    });
    for (const type of ['due-soon', 'overdue', 'work-session-soon', 'start-now'] as const) {
      expect(getReminderPayload(task, type).tag.length).toBeLessThanOrEqual(PUSH_TAG_MAX_LENGTH);
    }
  });

  it('"start now" names the exact deadline time for a task with a due time', () => {
    inTimeZone('Asia/Kolkata', () => {
      const task = makeTask({ title: 'Submit', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' });
      const body = getReminderPayload(task, 'start-now').body;
      expect(body).toMatch(/^Start Submit now to stay on track for /);
      expect(clockOf(body)).toBe('17:30'); // 12h or 24h, any day-period case: the locale only changes the presentation
    });
  });

  it('"start now" shows no clock time for a date-only task: its stored UTC-midnight date is not a time the user chose', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      inTimeZone(zone, () => {
        const body = getReminderPayload(makeTask({ title: 'Submit', dueDate: '2026-10-20T00:00:00.000Z' }), 'start-now').body;
        expect(body).toBe('Start Submit now to stay on track.');
      });
    }
    expect(getReminderPayload(makeTask({ title: 'Submit' }), 'start-now').body).toBe('Start Submit now to stay on track.');
    expect(getReminderPayload(makeTask({ title: 'Submit', startTime: '2026-10-20T09:00:00.000Z' }), 'start-now').body).toBe(
      'Start Submit now to stay on track.',
    );
  });

  it('"planned work session" does not invent a duration for a task that has a start time but no estimate', () => {
    const body = getReminderPayload(makeTask({ title: 'Plan trip', startTime: '2026-10-20T09:00:00.000Z' }), 'work-session-soon').body;
    expect(body).toBe('Plan trip is planned to start soon.');
    expect(body).not.toMatch(/0m|0h/);
  });

  it('keeps the estimate wording when there is one', () => {
    expect(getReminderPayload(makeTask({ title: 'Plan trip', estimatedMinutes: 90 }), 'work-session-soon').body).toBe(
      'You planned 2h for Plan trip. Consider starting soon.',
    );
  });
});

describe('sendReminderNotification reports whether the reminder was shown', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'Notification', original);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  const stubNotification = (permission: string, onCreate: (title: string, options: unknown) => void = () => {}) => {
    class Fake {
      static permission = permission;
      constructor(title: string, options: unknown) {
        onCreate(title, options);
      }
    }
    Object.defineProperty(globalThis, 'Notification', { value: Fake, configurable: true, writable: true });
  };

  it('is true, with the same title, body and tag as before, when it asked the browser to show it', () => {
    const created = vi.fn();
    stubNotification('granted', created);
    const task = makeTask({ _id: OBJECT_ID, title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z' });

    expect(sendReminderNotification(task, 'overdue')).toBe(true);
    expect(created).toHaveBeenCalledWith('Task overdue', {
      body: 'Write report is now overdue.',
      tag: `halotask-overdue-${OBJECT_ID}-2026-10-20T00:00:00.000Z`,
    });
  });

  it('is false, and shows nothing, when permission is not granted', () => {
    const created = vi.fn();
    for (const permission of ['default', 'denied']) {
      stubNotification(permission, created);
      expect(sendReminderNotification(makeTask({ dueDate: '2026-10-20T00:00:00.000Z' }), 'overdue')).toBe(false);
    }
    expect(created).not.toHaveBeenCalled();
  });

  it('is false when the browser has no Notification API', () => {
    Reflect.deleteProperty(globalThis, 'Notification');
    expect(sendReminderNotification(makeTask(), 'due-soon')).toBe(false);
  });

  it('lets a failing Notification constructor throw, so the caller can tell it was not delivered', () => {
    stubNotification('granted', () => {
      throw new TypeError('Illegal constructor');
    });
    expect(() => sendReminderNotification(makeTask(), 'due-soon')).toThrow('Illegal constructor');
  });
});

describe('merged timed reminder notification (Issue #14)', () => {
  const task = makeTask({ _id: OBJECT_ID, title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', estimatedMinutes: 60 });

  it('a single reminder has the title and sentence it always had, under the per-task tag', () => {
    const payload = getTimedReminderPayload(task, ['due-soon']);
    const legacy = getReminderPayload(task, 'due-soon');
    expect(payload.title).toBe(legacy.title);
    expect(payload.body).toBe(legacy.body);
    expect(payload.tag).toBe(`halotask-task-${OBJECT_ID}`);
  });

  it('merges with the fixed template: lead sentence, then one clause per other type in precedence order', () => {
    inTimeZone('Asia/Kolkata', () => {
      const merged = getTimedReminderPayload(task, ['due-soon', 'start-now']);
      expect(merged.title).toBe('Start now to finish on time');
      expect(merged.body).toMatch(/^Start Write report now to stay on track for .+\. Due within the next hour\.$/);
    });
    expect(getTimedReminderPayload(task, ['work-session-soon', 'due-soon']).body).toBe(
      'Write report is due within the next hour. A planned work session starts soon.',
    );
  });

  it('depends only on the task and the set of types, not on the order they are listed in', () => {
    const a = getTimedReminderPayload(task, ['work-session-soon', 'due-soon', 'start-now']);
    const b = getTimedReminderPayload(task, ['start-now', 'work-session-soon', 'due-soon']);
    expect(a).toEqual(b);
  });

  it('the tag is the stable identity: not the title, not the schedule, and the same for every type', () => {
    const tags = new Set([
      getTimedReminderPayload(task, ['due-soon']).tag,
      getTimedReminderPayload({ ...task, title: 'Renamed, with "odd" chars / ✓' }, ['start-now']).tag,
      getTimedReminderPayload({ ...task, dueTime: '09:00', startTime: '2026-10-20T01:00:00.000Z' }, ['overdue']).tag,
    ]);
    expect([...tags]).toEqual([`halotask-task-${OBJECT_ID}`]);
  });

  it('keeps a task\'s identity across the offline-created to synced id change', () => {
    const synced = { ...task, _id: 'server-1', clientKey: 'local-1' };
    expect(getTimedReminderPayload(synced, ['due-soon']).tag).toBe('halotask-task-local-1');
  });

  it('fits the relay limits with the longest title and every type merged', () => {
    const long = makeTask({ _id: OBJECT_ID, title: 'x'.repeat(200), dueDate: '2026-10-20T00:00:00.000Z', dueTime: '23:59', estimatedMinutes: 600 });
    const payload = getTimedReminderPayload(long, ['start-now', 'due-soon', 'work-session-soon', 'overdue']);
    expect(payload.title.length).toBeLessThanOrEqual(100); // PUSH_TITLE_MAX_LENGTH
    expect(payload.body.length).toBeLessThanOrEqual(500); // PUSH_BODY_MAX_LENGTH
    expect(payload.tag.length).toBeLessThanOrEqual(PUSH_TAG_MAX_LENGTH);
  });

  it('needs at least one type', () => {
    expect(() => getTimedReminderPayload(task, [])).toThrow();
  });

  it('reminderPayloadFor picks the merged payload only when a merge is given (date-only day reminders keep theirs)', () => {
    expect(reminderPayloadFor(task, 'due-soon', ['due-soon']).tag).toBe(`halotask-task-${OBJECT_ID}`);
    expect(reminderPayloadFor(task, 'due-soon')).toEqual(getReminderPayload(task, 'due-soon'));
  });
});

describe('sendReminderNotification for a merged reminder', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'Notification', original);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  const stub = (onCreate: (title: string, options: unknown) => void) => {
    class Fake {
      static permission = 'granted';
      constructor(title: string, options: unknown) {
        onCreate(title, options);
      }
    }
    Object.defineProperty(globalThis, 'Notification', { value: Fake, configurable: true, writable: true });
  };

  it('shows ONE notification under the per-task tag and asks to be re-announced when it replaces an earlier one', () => {
    const created = vi.fn();
    stub(created);
    const task = makeTask({ _id: OBJECT_ID, title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' });
    expect(sendReminderNotification(task, 'start-now', ['start-now', 'due-soon'])).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][1]).toMatchObject({ tag: `halotask-task-${OBJECT_ID}`, renotify: true });
  });

  it('a calendar-day reminder (no merge) keeps its per-type tag and no renotify', () => {
    const created = vi.fn();
    stub(created);
    const task = makeTask({ _id: OBJECT_ID, title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z' });
    sendReminderNotification(task, 'due-soon');
    expect(created.mock.calls[0][1]).toEqual({
      body: 'Write report is due today.',
      tag: `halotask-due-soon-${OBJECT_ID}-2026-10-20T00:00:00.000Z`,
    });
  });
});
