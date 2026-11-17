import { describe, expect, it } from 'vitest';
import { computeReminderEvents } from '../src/utils/emailReminderEngine';

// Issue #29, section S3 — PARITY VECTORS. The same table is in halotasks-client/src/reminders/emailParity.test.ts, where
// it is checked against the BROWSER's reminder logic. If both tests pass, the server's email decisions and the browser's
// notification decisions agree on every case here. Change a vector in BOTH files or in neither.
// Settings: every reminder type on, buffer 60 minutes. The overdue email window (24 h) is a server-only bound and is
// tested in tests/emailReminderEngine.test.ts, so no vector here is more than a day past its deadline.
// A date-only dueDate is the calendar day (stored as UTC midnight).

type Vector = {
  name: string;
  zone: string;
  now: string;
  task: { dueDate?: string; dueTime?: string; startTime?: string; estimatedMinutes?: number; completed?: boolean };
  expect: string[];
};

const VECTORS: Vector[] = [
  // name, zone, now (ISO), task, expected event types (sorted)
  { name: 'timed, due in 30 min', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '15:00' }, expect: ['due-soon'] },
  { name: 'timed, due exactly 60 min away (inclusive)', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '15:30' }, expect: ['due-soon'] },
  { name: 'timed, due 61 min away', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '15:31' }, expect: [] },
  { name: 'timed, 30 min overdue', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '14:00' }, expect: ['overdue'] },
  { name: 'timed, deadline is exactly now (overdue, not due-soon)', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '14:30' }, expect: ['overdue'] },
  { name: 'date-only, due today in the zone', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05' }, expect: ['due-soon'] },
  { name: 'date-only, due yesterday', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-04' }, expect: ['overdue'] },
  { name: 'date-only, due two days ago', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-03' }, expect: [] },
  { name: 'date-only, due tomorrow', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-06' }, expect: [] },
  { name: 'date-only "today" follows the zone, not UTC (it is already Oct 6 in Kiritimati)', zone: 'Pacific/Kiritimati', now: '2026-10-05T12:00:00Z', task: { dueDate: '2026-10-06' }, expect: ['due-soon'] },
  { name: 'explicit start, heads-up window opens now', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T09:30:00Z' }, expect: ['work-session-soon'] },
  { name: 'explicit start, one minute before the heads-up', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T10:01:00Z' }, expect: [] },
  { name: 'explicit start has passed, no deadline: start-now for the buffer', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T08:59:00Z' }, expect: ['start-now'] },
  { name: 'explicit start passed more than the buffer ago, no deadline', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T07:59:00Z' }, expect: [] },
  { name: 'start AND timed due together: start-now until the deadline, and not due-soon at 90 min', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T08:00:00Z', dueDate: '2026-10-05', dueTime: '16:00' }, expect: ['start-now'] },
  { name: 'start AND timed due together, due within the hour', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { startTime: '2026-10-05T08:00:00Z', dueDate: '2026-10-05', dueTime: '15:00' }, expect: ['due-soon', 'start-now'] },
  { name: 'estimate, no start: latest start = deadline - estimate (start-now begins exactly then)', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '16:00', estimatedMinutes: 90 }, expect: ['start-now'] },
  { name: 'estimate, heads-up before the latest start', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '17:00', estimatedMinutes: 120 }, expect: ['work-session-soon'] },
  { name: 'estimate on a date-only task makes no smart-start reminder (Issue #42)', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', estimatedMinutes: 60 }, expect: ['due-soon'] },
  { name: 'completed task', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: { dueDate: '2026-10-05', dueTime: '15:00', completed: true }, expect: [] },
  { name: 'no dates at all', zone: 'Asia/Kolkata', now: '2026-10-05T09:00:00Z', task: {}, expect: [] },
  { name: 'DST spring-forward: 02:30 does not exist in Los Angeles, it means 03:30 PDT (10:30Z)', zone: 'America/Los_Angeles', now: '2026-03-08T10:00:00Z', task: { dueDate: '2026-03-08', dueTime: '02:30' }, expect: ['due-soon'] },
  { name: 'DST fall-back: 01:30 occurs twice in Los Angeles, the FIRST one (08:30Z) is the deadline', zone: 'America/Los_Angeles', now: '2026-11-01T08:15:00Z', task: { dueDate: '2026-11-01', dueTime: '01:30' }, expect: ['due-soon'] },
  { name: 'DST fall-back: the second 01:30 (09:30Z) is not the deadline, so the task is already overdue then', zone: 'America/Los_Angeles', now: '2026-11-01T09:30:00Z', task: { dueDate: '2026-11-01', dueTime: '01:30' }, expect: ['overdue'] },
];

describe('server reminder engine, parity vectors', () => {
  it.each(VECTORS)('$name', ({ zone, now, task, expect: expected }) => {
    const events = computeReminderEvents(
      [{ id: 't', title: 'Task', completed: task.completed ?? false, dueDate: task.dueDate ? new Date(`${task.dueDate}T00:00:00Z`) : null, dueTime: task.dueTime ?? null, startTime: task.startTime ? new Date(task.startTime) : null, estimatedMinutes: task.estimatedMinutes ?? null }],
      { dueSoonEnabled: true, overdueEnabled: true, workSessionSoonEnabled: true, startNowEnabled: true, bufferMinutes: 60 },
      zone,
      Date.parse(now),
    );
    expect(events.map((e) => e.type).sort()).toEqual([...expected].sort());
  });
});
