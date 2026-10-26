import { describe, expect, it } from 'vitest';
import User from '../src/models/User.model';

// Issue #41 — the model itself refuses a bad time zone, so a direct Mongoose write cannot store one even though it
// never passes through the preferences route. DB-less (validateSync); the stored shape is checked against a real
// MongoDB in tests/userPreferences.realmongo.test.ts.

const base = { name: 'A', email: 'a@x.test', passwordHash: 'x' };

describe('User.timeZone', () => {
  it('is optional: an account without it is valid and has no default', () => {
    const user = new User(base);

    expect(user.validateSync()).toBeUndefined();
    expect(user.timeZone).toBeUndefined();
    expect(user.toObject()).not.toHaveProperty('timeZone');
  });

  it.each(['Asia/Kolkata', 'America/Los_Angeles', 'UTC', 'Pacific/Kiritimati'])('accepts %s', (timeZone) => {
    expect(new User({ ...base, timeZone }).validateSync()).toBeUndefined();
  });

  it.each(['+05:30', '-08:00', 'UTC+05:30', 'Mars/Olympus_Mons', ''])('rejects %j', (timeZone) => {
    const error = new User({ ...base, timeZone }).validateSync();

    expect(error?.errors.timeZone?.message).toBe('timeZone must be a valid IANA time zone identifier');
  });
});
