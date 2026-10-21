import { describe, expect, it } from 'vitest';
import { inTimeZone, makeTask } from '../test/taskFactory';
import { getReminderPayload } from './notification';

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
      expect(getReminderPayload(task, 'start-now').body).toMatch(/^Start Submit now to stay on track for (05:30|5:30)/);
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
