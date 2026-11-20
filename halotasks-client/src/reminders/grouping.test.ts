import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { groupTimedEvents, orderReminderTypes, REMINDER_PRECEDENCE, type ReminderType } from './grouping';

// Issue #14: the merge is a pure function of the events of one poll. These tests pin the rule, not the scheduler.

const permutations = <T,>(items: T[]): T[][] =>
  items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

describe('orderReminderTypes', () => {
  it('uses the fixed precedence start-now > due-soon > work-session-soon > overdue and drops repeats', () => {
    expect(REMINDER_PRECEDENCE).toEqual(['start-now', 'due-soon', 'work-session-soon', 'overdue']);
    expect(orderReminderTypes(['overdue', 'work-session-soon', 'due-soon', 'start-now', 'due-soon'])).toEqual([
      'start-now',
      'due-soon',
      'work-session-soon',
      'overdue',
    ]);
  });
});

describe('groupTimedEvents', () => {
  it('merges the simultaneous reminders of one task into one group led by the highest precedence', () => {
    const task = makeTask({ _id: 'a' });
    expect(groupTimedEvents([{ task, type: 'due-soon' }, { task, type: 'start-now' }])).toEqual([
      { task, type: 'start-now', merged: ['start-now', 'due-soon'] },
    ]);
    expect(groupTimedEvents([{ task, type: 'work-session-soon' }, { task, type: 'due-soon' }])).toEqual([
      { task, type: 'due-soon', merged: ['due-soon', 'work-session-soon'] },
    ]);
  });

  it('is the same for every order the events of one task arrive in', () => {
    const task = makeTask({ _id: 'a' });
    const types: ReminderType[] = ['work-session-soon', 'due-soon', 'start-now'];
    const results = permutations(types).map((order) => groupTimedEvents(order.map((type) => ({ task, type }))));
    for (const result of results) {
      expect(result).toEqual([{ task, type: 'start-now', merged: ['start-now', 'due-soon', 'work-session-soon'] }]);
    }
  });

  it('never merges different tasks, and lists groups in the order their task first appears', () => {
    const a = makeTask({ _id: 'a' });
    const b = makeTask({ _id: 'b' });
    const groups = groupTimedEvents([
      { task: b, type: 'due-soon' },
      { task: a, type: 'due-soon' },
      { task: b, type: 'start-now' },
    ]);
    expect(groups.map((g) => [g.task._id, g.merged])).toEqual([
      ['b', ['start-now', 'due-soon']],
      ['a', ['due-soon']],
    ]);
  });

  it('treats a task that was created offline and later synced as one task (same reminder identity)', () => {
    const local = makeTask({ _id: 'local-1' });
    const synced = { ...makeTask({ _id: 'server-1' }), clientKey: 'local-1' };
    expect(groupTimedEvents([{ task: local, type: 'due-soon' }, { task: synced, type: 'start-now' }])).toHaveLength(1);
  });

  it('a single reminder stays a group of one, and no events give no groups', () => {
    const task = makeTask({ _id: 'a' });
    expect(groupTimedEvents([{ task, type: 'overdue' }])).toEqual([{ task, type: 'overdue', merged: ['overdue'] }]);
    expect(groupTimedEvents([])).toEqual([]);
  });
});
