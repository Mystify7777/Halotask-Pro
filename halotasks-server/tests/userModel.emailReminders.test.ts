import { describe, expect, it } from 'vitest';
import User from '../src/models/User.model';

// Issue #29, section S2 — the schema is the second line behind the route's parser. validateSync needs no database.

const make = (emailReminders: Record<string, unknown>) =>
  new User({ name: 'A', email: 'a@x.test', passwordHash: 'h', emailReminders });

describe('User.emailReminders schema', () => {
  it('a new account stores NO emailReminders at all (absent = defaults)', () => {
    const doc = new User({ name: 'A', email: 'a@x.test', passwordHash: 'h' });
    expect(doc.toObject().emailReminders ?? {}).toEqual({});
    expect(doc.validateSync()).toBeUndefined();
  });

  it('accepts every valid field', () => {
    const doc = make({ enabled: true, dueSoonEnabled: false, bufferMinutes: 90, quietHoursStart: '22:00', digestTime: '06:15', timeZone: 'Asia/Kolkata' });
    expect(doc.validateSync()).toBeUndefined();
  });

  it.each([
    ['a bad buffer', { bufferMinutes: 45 }],
    ['a bad time', { quietHoursEnd: '7am' }],
    ['a bad digest time', { digestTime: '24:00' }],
    ['an offset zone', { timeZone: '+05:30' }],
  ])('a direct write with %s fails validation', (_name, fields) => {
    expect(make(fields).validateSync()).toBeDefined();
  });

  it('has no path that could hold a destination address', () => {
    const paths = Object.keys(User.schema.paths).filter((p) => p.startsWith('emailReminders.'));
    expect(paths.sort()).toEqual(
      [
        'emailReminders.bufferMinutes',
        'emailReminders.digestEnabled',
        'emailReminders.digestTime',
        'emailReminders.dueSoonEnabled',
        'emailReminders.enabled',
        'emailReminders.overdueEnabled',
        'emailReminders.quietHoursEnd',
        'emailReminders.quietHoursStart',
        'emailReminders.startNowEnabled',
        'emailReminders.timeZone',
        'emailReminders.workSessionSoonEnabled',
      ].sort(),
    );
  });
});
