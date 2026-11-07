import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import CompletionRecord from '../src/models/CompletionRecord.model';

// Issue #47 — the CompletionRecord schema: the indexes that carry the guarantees, and the cross-field rules that keep a
// stored record from contradicting itself. No database needed: this validates documents without connecting. (That the
// indexes really exist in MongoDB and are enforced is checked by completionRecord.realmongo.test.ts.)

const USER = new mongoose.Types.ObjectId();
const NOW = new Date('2026-11-05T04:00:00Z');

const client = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  completionId: 'c1',
  taskId: '665f1c2e9b1e8a0012345678',
  titleSnapshot: 'Write report',
  estimatedMinutesSnapshot: 30,
  completedAt: new Date('2026-11-04T20:00:00Z'),
  utcOffsetMinutes: 330,
  localDate: '2026-11-05',
  receivedAt: NOW,
  status: 'active',
  source: 'live',
  completedAtSource: 'client',
  ...over,
});

// validate() (not validateSync()) on purpose: only the async path runs the pre('validate') hook that holds the cross-field rules.
const errorsOf = async (doc: Record<string, unknown>) => {
  try {
    await new CompletionRecord(doc).validate();
    return {};
  } catch (error) {
    return (error as { errors?: Record<string, unknown> }).errors ?? {};
  }
};

describe('indexes', () => {
  const indexes = CompletionRecord.schema.indexes();
  const find = (name: string) => indexes.find(([, options]) => options?.name === name);

  it('(userId, completionId) is unique: the idempotency key', () => {
    const found = find('completion_id_per_user');
    expect(found?.[0]).toEqual({ userId: 1, completionId: 1 });
    expect(found?.[1]).toMatchObject({ unique: true });
  });

  it('one ACTIVE LIVE completion per task: a partial unique index on (userId, taskId)', () => {
    const found = find('one_active_live_completion_per_task');
    expect(found?.[0]).toEqual({ userId: 1, taskId: 1 });
    expect(found?.[1]).toMatchObject({ unique: true, partialFilterExpression: { status: 'active', source: 'live' } });
  });

  it('has the query indexes for days and for a task', () => {
    expect(find('completions_by_local_date')?.[0]).toEqual({ userId: 1, localDate: 1, status: 1 });
    expect(find('completions_by_task')?.[0]).toEqual({ userId: 1, taskId: 1, completedAt: 1 });
  });
});

describe('a valid record', () => {
  it('client-observed, active', async () => {
    expect(await errorsOf(client())).toEqual({});
  });

  it('server-observed (legacy client): receipt time, no known local day', async () => {
    expect(
      await errorsOf(client({ completionId: 'srv-1', completedAtSource: 'server', completedAt: NOW, utcOffsetMinutes: null, localDate: null })),
    ).toEqual({});
  });

  it('migrated: unknown completion instant', async () => {
    expect(
      await errorsOf(client({ completionId: 'm-1', source: 'migrated', completedAtSource: 'migrated', completedAt: null, utcOffsetMinutes: null, localDate: '2026-10-30' })),
    ).toEqual({});
  });

  it('revoked (uncompleted) and revoked (superseded)', async () => {
    const revoked = { status: 'revoked', revokeReceivedAt: NOW };
    expect(await errorsOf(client({ ...revoked, revokedAt: new Date('2026-11-05T01:00:00Z'), revokedReason: 'uncompleted' }))).toEqual({});
    expect(await errorsOf(client({ ...revoked, revokedAt: null, revokedReason: 'superseded' }))).toEqual({});
  });

  it('accepts a local-* task id exactly as sent', async () => {
    expect(await errorsOf(client({ taskId: 'local-1730000000000-ab12cd' }))).toEqual({});
  });
});

describe('records that contradict themselves are refused', () => {
  it.each([
    ['a localDate that is not the calendar date of completedAt at the offset', { localDate: '2026-11-04' }, 'localDate'],
    ['a client record with no offset', { utcOffsetMinutes: null, localDate: null }, 'completedAt'],
    ['a client record with no completedAt', { completedAt: null }, 'completedAt'],
    ['a client record from a migrated source', { source: 'migrated' }, 'source'],
    ['a server-observed record that claims a local day', { completedAtSource: 'server', utcOffsetMinutes: 330, localDate: '2026-11-05' }, 'localDate'],
    ['a server-observed record with no time', { completedAtSource: 'server', completedAt: null, utcOffsetMinutes: null, localDate: null }, 'completedAt'],
    ['a migrated record that invents a completion instant', { source: 'migrated', completedAtSource: 'migrated', completedAt: NOW, utcOffsetMinutes: null }, 'completedAt'],
    ['a migrated completedAtSource on a live record', { completedAtSource: 'migrated', completedAt: null }, 'source'],
    ['an active record carrying revoke fields', { revokedReason: 'uncompleted' }, 'status'],
    ['a revoked record with no reason', { status: 'revoked', revokeReceivedAt: NOW }, 'status'],
    ['a revoked record with no receipt time', { status: 'revoked', revokedReason: 'uncompleted' }, 'status'],
  ])('%s', async (_label, over, path) => {
    expect(Object.keys(await errorsOf(client(over)))).toContain(path);
  });

  it.each([
    ['an unknown status', { status: 'quarantined' }, 'status'],
    ['an unknown revoke reason', { status: 'revoked', revokeReceivedAt: NOW, revokedReason: 'oops' }, 'revokedReason'],
    ['an offset above 840', { utcOffsetMinutes: 841 }, 'utcOffsetMinutes'],
    ['a fractional offset', { utcOffsetMinutes: 330.5 }, 'utcOffsetMinutes'],
    ['a malformed localDate', { localDate: '5 Nov' }, 'localDate'],
    ['a completionId with a space', { completionId: 'a b' }, 'completionId'],
    ['a taskId with a slash', { taskId: 'a/b' }, 'taskId'],
    ['a title over 200 characters', { titleSnapshot: 'x'.repeat(201) }, 'titleSnapshot'],
    ['a negative estimate', { estimatedMinutesSnapshot: -1 }, 'estimatedMinutesSnapshot'],
    ['an estimate over the limit', { estimatedMinutesSnapshot: 100_001 }, 'estimatedMinutesSnapshot'],
    ['no receivedAt', { receivedAt: undefined }, 'receivedAt'],
    ['no userId', { userId: undefined }, 'userId'],
  ])('%s', async (_label, over, path) => {
    expect(Object.keys(await errorsOf(client(over)))).toContain(path);
  });
});
