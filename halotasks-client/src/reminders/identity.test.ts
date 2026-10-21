import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { keepReminderIdentity, reminderIdentity } from './identity';
import { getReminderPayload } from './notification';

describe('reminder identity', () => {
  it('is the server id for a task that was never local (every existing key and tag is unchanged)', () => {
    expect(reminderIdentity(makeTask({ _id: 'srv-9' }))).toBe('srv-9');
  });
  it('is the original local id once the task has synced', () => {
    expect(reminderIdentity(makeTask({ _id: 'srv-9', clientKey: 'local-1' }))).toBe('local-1');
  });
  it('keepReminderIdentity remembers the local id on create, and keeps it through later server replacements', () => {
    const local = makeTask({ _id: 'local-1' });
    const afterCreate = keepReminderIdentity(makeTask({ _id: 'srv-1' }), local, 'local-1');
    expect(afterCreate.clientKey).toBe('local-1');
    expect(keepReminderIdentity(makeTask({ _id: 'srv-1' }), afterCreate).clientKey).toBe('local-1');
  });
  it('adds nothing when there is nothing to remember (same object, no clientKey)', () => {
    const server = makeTask({ _id: 'srv-1' });
    expect(keepReminderIdentity(server, makeTask({ _id: 'srv-1' }))).toBe(server);
    expect(keepReminderIdentity(server, undefined, 'srv-1')).toBe(server);
  });
  it('the notification tag uses the stable identity', () => {
    const task = makeTask({ _id: 'srv-1', clientKey: 'local-1' });
    expect(getReminderPayload(task, 'overdue').tag).toContain('-local-1-');
    expect(getReminderPayload(task, 'overdue').tag).not.toContain('srv-1');
  });
});
