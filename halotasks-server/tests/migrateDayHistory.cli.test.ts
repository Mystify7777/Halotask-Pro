import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/scripts/migrateDayHistory';
import { supportsTransactions } from '../src/utils/completionMigration';

// Issue #47, Phase 2B: the migration CLI is a dry run unless explicitly told to write.
describe('migrate:history arguments', () => {
  it('defaults to a dry run over every account, without the writable days', () => {
    expect(parseArgs([])).toEqual({ apply: false, includeWritableDays: false });
  });
  it('writes only with --apply', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--include-writable-days']).apply).toBe(false);
  });
  it('accepts one account and the writable-days switch', () => {
    expect(parseArgs(['--apply', '--user=665f1c2e9b1e8a00000000aa', '--include-writable-days'])).toEqual({
      apply: true,
      includeWritableDays: true,
      userId: '665f1c2e9b1e8a00000000aa',
    });
  });
  it('rejects anything it does not know instead of silently running a broader migration', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--user=abc'])).toThrow(/24-character/);
  });
});

describe('migrate:history refuses to apply where a day cannot be written atomically', () => {
  it('replica set members and mongos support transactions; a standalone server does not', () => {
    expect(supportsTransactions({ setName: 'rs0' })).toBe(true);
    expect(supportsTransactions({ msg: 'isdbgrid' })).toBe(true);
    expect(supportsTransactions({})).toBe(false);
    expect(supportsTransactions({ isWritablePrimary: true })).toBe(false);
    expect(supportsTransactions(null)).toBe(false);
    expect(supportsTransactions(undefined)).toBe(false);
  });
});
