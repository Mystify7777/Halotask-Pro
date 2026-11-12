import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { addDays, getToday } from '../src/utils/calendarDate';
import { createCompletionStore, installCompletionRecordMock, removeCompletionRecordMock, type CompletionStore } from './helpers/completionDoubles';
import { createLegacyStore, type LegacyStore } from './helpers/historyDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels } from './helpers/treeDoubles';

// Issue #47, Phase 2B — migration of legacy DayHistory into migrated CompletionRecords. Mongo-free (strict doubles).
// The contract under test is documented at the top of utils/completionMigration.ts and in docs/context.md.

const A = '665f1c2e9b1e8a00000000aa';
const B = '665f1c2e9b1e8a00000000bb';
const NOW = new Date('2026-11-20T12:00:00Z');
const OLD = '2026-11-01'; // frozen: well before the writable window (2026-11-14 .. today)
const OLDER = '2026-10-15';
const IST = 330;

let store: CompletionStore;
let mig: typeof import('../src/utils/completionMigration');

const task = (id: string, title = `Task ${id}`, minutes = 10) => ({ taskId: id, title, estimatedMinutes: minutes });
const row = (date: string, tasks: ReturnType<typeof task>[], over: Record<string, unknown> = {}, userId = A) => ({
  userId,
  date,
  completedCount: tasks.length,
  workDoneMinutes: tasks.reduce((s, t) => s + t.estimatedMinutes, 0),
  completedTasks: tasks,
  ...over,
});
const run = (rows: object[], over: Record<string, unknown> = {}) => mig.migrateDayHistory(rows as never, { apply: true, now: NOW, ...over });

beforeEach(async () => {
  vi.resetModules();
  store = createCompletionStore();
  installCompletionRecordMock(store);
  mig = await import('../src/utils/completionMigration.js');
});
afterEach(() => {
  removeCompletionRecordMock();
  vi.restoreAllMocks();
});

describe('what a migrated record states (and does not)', () => {
  it('writes one record per snapshot entry with only the day known: completedAt/offset null, source and completedAtSource "migrated", active', async () => {
    const report = await run([row(OLD, [task('t1', 'Write report', 30), task('t2', 'Email', 5)])]);

    expect(report.recordsCreated).toBe(2);
    expect(store.docs).toHaveLength(2);
    for (const doc of store.docs) {
      expect(doc).toMatchObject({
        userId: A,
        localDate: OLD,
        completedAt: null,
        utcOffsetMinutes: null,
        status: 'active',
        source: 'migrated',
        completedAtSource: 'migrated',
        receivedAt: NOW,
      });
      expect(doc.revokedAt ?? null).toBeNull();
    }
    expect(store.docs.map((d) => [d.taskId, d.titleSnapshot, d.estimatedMinutesSnapshot]).sort()).toEqual([
      ['t1', 'Write report', 30],
      ['t2', 'Email', 5],
    ]);
  });

  it('uses deterministic ids that match the completion id pattern: same (user, date, task) -> same id, anything else differs', async () => {
    const id = mig.migratedCompletionId(A, OLD, 't1');
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(mig.migratedCompletionId(A, OLD, 't1')).toBe(id);
    expect(new Set([id, mig.migratedCompletionId(B, OLD, 't1'), mig.migratedCompletionId(A, OLDER, 't1'), mig.migratedCompletionId(A, OLD, 't2')]).size).toBe(4);
  });

  it('the same task on two legacy days is two records (a snapshot cannot say it was one completion), and never blocks the live single-active-slot index', async () => {
    await run([row(OLDER, [task('t1')]), row(OLD, [task('t1')])]);
    expect(store.docs.filter((d) => d.taskId === 't1')).toHaveLength(2);
    // a later live completion of the same task is not blocked by the migrated ones
    const svc = await import('../src/utils/completionRecords.js');
    const live = await svc.recordCompletion(
      A,
      { completionId: 'live-1', taskId: 't1', titleSnapshot: 'T', estimatedMinutesSnapshot: 1, completedAt: new Date(NOW.getTime() - 60_000), utcOffsetMinutes: IST, localDate: '2026-11-20' },
      NOW,
    );
    expect(live.outcome).toBe('recorded');
  });
});

describe('idempotent and resumable', () => {
  it('a rerun creates nothing and reports everything as already migrated', async () => {
    const rows = [row(OLD, [task('t1'), task('t2')]), row(OLDER, [task('t3')])];
    await run(rows);
    const before = structuredClone(store.docs);

    const again = await run(rows);

    expect(again.recordsCreated).toBe(0);
    expect(again.rowsAlreadyMigrated).toBe(2);
    expect(again.recordsAlreadyPresent).toBe(3);
    expect(store.docs).toEqual(before);
  });

  it('ATOMIC: a failure halfway through a day leaves NO record of that day (it keeps reading legacy), and the rerun migrates it whole', async () => {
    const rows = [row(OLD, [task('t1'), task('t2'), task('t3'), task('t4'), task('t5')])];
    let inserted = 0;
    store.hooks.failCreate = () => (++inserted === 3 ? Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) : null);

    const first = await run(rows);

    expect(first.rowsFailed).toBe(1);
    expect(first.recordsCreated).toBe(0);
    expect(store.docs).toHaveLength(0); // never 0 < records < 5

    store.hooks.failCreate = undefined;
    const second = await run(rows);
    expect(second.recordsCreated).toBe(5);
    expect(store.docs).toHaveLength(5);
    expect(new Set(store.docs.map((d) => d.taskId))).toEqual(new Set(['t1', 't2', 't3', 't4', 't5']));
  });

  it('ATOMIC: a failure at COMMIT rolls the whole day back too', async () => {
    store.hooks.failCommit = () => Object.assign(new Error('commit failed'), { code: 'ECONNRESET' });
    const report = await run([row(OLD, [task('t1'), task('t2')])]);
    expect(report.rowsFailed).toBe(1);
    expect(store.docs).toHaveLength(0);
  });

  it('ATOMIC, at every position: whichever insert of a day fails, no partial day is ever stored (and the failed run is reported)', async () => {
    const rows = [row(OLD, [task('a'), task('b'), task('c'), task('d')])];
    for (let failAt = 1; failAt <= 4; failAt += 1) {
      store.docs.length = 0;
      let n = 0;
      store.hooks.failCreate = () => (++n === failAt ? new Error('boom') : null);
      const report = await run(rows);
      expect(report.rowsFailed).toBe(1);
      expect(store.docs).toHaveLength(0);
    }
  });

  it('a standalone server (no transactions): nothing is written and the day is reported as failed', async () => {
    store.hooks.standalone = true;
    const report = await run([row(OLD, [task('t1')])]);
    expect(report.rowsFailed).toBe(1);
    expect(store.docs).toHaveLength(0);
  });

  it('after a failed run the day still has no record: another failed day does not affect a good one', async () => {
    store.hooks.failCreate = (doc) => (doc.taskId === 'bad-day-2' ? new Error('boom') : null);
    const report = await run([row(OLD, [task('ok-1'), task('bad-day-2')]), row(OLDER, [task('ok-2'), task('ok-3')])]);
    expect(report.rowsFailed).toBe(1);
    expect(store.docs.map((d) => d.localDate)).toEqual([OLDER, OLDER]);
  });

  it('a concurrent rerun cannot double-insert: the unique id decides, the loser sees "present"', async () => {
    const rows = [row(OLD, [task('t1'), task('t2')])];
    const [r1, r2] = await Promise.all([run(rows), run(rows)]);
    expect(store.docs).toHaveLength(2);
    expect(r1.recordsCreated + r2.recordsCreated).toBe(2);
  });

  it('one failing row does not stop the run, and the error report carries no message text', async () => {
    store.hooks.failCreate = (doc) => (doc.localDate === OLDER ? Object.assign(new Error('secret mongodb://user:pw@host'), { code: 'ECONNRESET' }) : null);
    const report = await run([row(OLDER, [task('t1')]), row(OLD, [task('t2')])]);

    expect(report.rowsFailed).toBe(1);
    expect(report.recordsCreated).toBe(1);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(report.issues.find((i) => i.kind === 'error')?.detail).toBe('Error/ECONNRESET');
  });

  it('a non-duplicate unique violation is not swallowed as "present"', async () => {
    store.hooks.failCreate = () => Object.assign(new Error('E11000'), { code: 11000, keyPattern: { userId: 1, taskId: 1 } });
    const report = await run([row(OLD, [task('t1')])]);
    expect(report.rowsFailed).toBe(1);
    expect(report.recordsAlreadyPresent).toBe(0);
  });
});

describe('deterministic ids across runs', () => {
  it('two independent runs over the same legacy rows write exactly the same completion ids', async () => {
    const rows = [row(OLD, [task('t1'), task('t2')]), row(OLDER, [task('t1')]), row(OLD, [task('t1')], {}, B)];
    await run(rows);
    const first = store.docs.map((d) => String(d.completionId)).sort();

    store.docs.length = 0;
    await run(rows);

    expect(store.docs.map((d) => String(d.completionId)).sort()).toEqual(first);
    expect(new Set(first).size).toBe(4); // same task on another date, and another user, differ
  });
});

describe('dry run', () => {
  it('reads and reports exactly what an apply would do, and writes nothing', async () => {
    const rows = [row(OLD, [task('t1'), task('t2')]), row(OLDER, [task('t3')])];
    const dry = await mig.migrateDayHistory(rows as never, { now: NOW });

    expect(dry.mode).toBe('dry-run');
    expect(dry.rowsToMigrate).toBe(2);
    expect(dry.recordsPlanned).toBe(3);
    expect(dry.recordsCreated).toBe(0);
    expect(store.docs).toHaveLength(0);
    expect(store.ops).not.toContain('create');

    const applied = await run(rows);
    expect(applied.recordsCreated).toBe(dry.recordsPlanned);
  });
});

describe('days that must not be migrated', () => {
  it('writable days (a legacy client can still write them) are skipped by default, whatever offset the client has', async () => {
    const boundary = mig.firstWritableDate(NOW);
    expect(boundary).toBe('2026-11-14'); // today at UTC-12 is 2026-11-20; the legacy window reaches 6 days back
    const report = await run([row(boundary, [task('t1')]), row('2026-11-20', [task('t2')]), row(addDays(boundary, -1), [task('t3')])]);

    expect(report.rowsSkippedWritable).toBe(2);
    expect(store.docs.map((d) => d.taskId)).toEqual(['t3']);
  });

  it('the boundary is exactly the legacy write validator: the day before it is rejected for EVERY offset, the boundary is accepted for some', async () => {
    const { parseHistoryUpsert } = await import('../src/utils/historyValidators.js');
    const boundary = mig.firstWritableDate(NOW);
    const accepts = (date: string, offset: number) =>
      parseHistoryUpsert({ date, utcOffsetMinutes: offset, completedCount: 0, workDoneMinutes: 0, completedTasks: [] }, { mode: 'backfill', pathDate: date, now: NOW }).ok;
    const offsets = [-720, -300, 0, 330, 840];
    expect(offsets.some((o) => accepts(boundary, o))).toBe(true);
    for (const o of offsets) expect(accepts(addDays(boundary, -1), o)).toBe(false);
  });

  it('--include-writable-days lifts the restriction', async () => {
    const report = await run([row('2026-11-20', [task('t1')])], { includeWritableDays: true });
    expect(report.recordsCreated).toBe(1);
  });

  const seededRecord = (over: Record<string, unknown>) => ({
    userId: A, completionId: 'seed-1', taskId: 'x', status: 'active', source: 'live', completedAtSource: 'client', localDate: OLD, completedAt: new Date('2026-11-01T05:00:00Z'), ...over,
  });

  it('a day that has a live record is no longer skipped wholesale: the task that record covers is left alone, the others are repaired (Phase 2F)', async () => {
    store.docs.push(seededRecord({ taskId: 'a' }));
    const report = await run([row(OLD, [task('a'), task('t2')])]);
    expect(report.rowsSkippedExistingRecords).toBe(0);
    expect(report.rowsMixedToRepair).toBe(1);
    expect(report.recordsCoveredByCanonical).toBe(1);
    expect(store.docs.map((d) => d.taskId).sort()).toEqual(['a', 't2']);
  });

  it('... a REVOKED record still COVERS its task: the snapshot must not bring a revoked completion back (only the OTHER task is imported)', async () => {
    store.docs.push(seededRecord({ taskId: 'a', status: 'revoked', revokedReason: 'uncompleted', revokeReceivedAt: new Date() }));
    const report = await run([row(OLD, [task('a'), task('b')])]);
    expect(report.recordsCreated).toBe(1);
    expect(report.recordsCoveredByCanonical).toBe(1);
    expect(store.docs.some((d) => d.taskId === 'a' && d.source === 'migrated')).toBe(false);
    expect(store.docs.find((d) => d.taskId === 'b')).toMatchObject({ source: 'migrated', status: 'active' });
  });

  it('... a day whose every legacy task is covered (even by revoked records) creates nothing and says so, apply or dry run', async () => {
    store.docs.push(seededRecord({ taskId: 'a', status: 'revoked', revokedReason: 'uncompleted', revokeReceivedAt: new Date() }));
    const rows = [row(OLD, [task('a')])];
    const before = structuredClone(store.docs);
    const dry = await mig.migrateDayHistory(rows as never, { now: NOW });
    const applied = await run(rows);
    for (const report of [dry, applied]) {
      expect(report.rowsMixedAlreadyCovered).toBe(1);
      expect(report.rowsMixedToRepair).toBe(0);
      expect(report.recordsPlanned).toBe(0);
      expect(report.recordsCreated).toBe(0);
    }
    expect(store.docs).toEqual(before);
  });

  it('... a DRY RUN of a mixed day plans exactly the missing tasks and writes nothing', async () => {
    store.docs.push(seededRecord({ taskId: 'a' }));
    const before = structuredClone(store.docs);
    const dry = await mig.migrateDayHistory([row(OLD, [task('a'), task('b'), task('c')])] as never, { now: NOW });
    expect(dry.rowsMixedToRepair).toBe(1);
    expect(dry.recordsPlanned).toBe(2);
    expect(dry.recordsCreated).toBe(0);
    expect(store.docs).toEqual(before);
  });

  it('... a migrated record written by something else for a different set of tasks still skips the day (all-migrated days keep the 2B rule)', async () => {
    store.docs.push(seededRecord({ completionId: 'mig-other', taskId: 'zzz', source: 'migrated', completedAtSource: 'migrated', completedAt: null }));
    const report = await run([row(OLD, [task('a')])]);
    expect(report.rowsSkippedExistingRecords).toBe(1);
    expect(store.docs).toHaveLength(1);
  });


  it('the day is re-checked INSIDE the transaction: a record that appears after the first look but before the write stops the day (nothing is added beside it)', async () => {
    let finds = 0;
    store.hooks.delay = (op) => {
      if (op !== 'find') return;
      finds += 1;
      if (finds === 2) {
        // second look = the one inside the transaction: a concurrent writer's record for the day has just appeared
        store.docs.push(seededRecord({ completionId: 'late-1', taskId: 'late', status: 'revoked', revokedReason: 'uncompleted', revokeReceivedAt: new Date() }));
      }
    };
    const report = await run([row(OLD, [task('a'), task('b')])]);

    expect(report.recordsCreated).toBe(0);
    expect(report.rowsSkippedExistingRecords).toBe(1);
    expect(store.docs.map((d) => d.completionId)).toEqual(['late-1']);
  });

  it('a partial migrated day (only some of the snapshot\'s migrated records; this code cannot produce one) is REPORTED as failed and left exactly as found', async () => {
    store.docs.push(
      seededRecord({ completionId: mig.migratedCompletionId(A, OLD, 'a'), taskId: 'a', source: 'migrated', completedAtSource: 'migrated', completedAt: null }),
    );
    const before = structuredClone(store.docs);
    const report = await run([row(OLD, [task('a'), task('b')])]);
    expect(report.rowsFailed).toBe(1);
    expect(report.issues[0].kind).toBe('partial-migrated-day');
    expect(store.docs).toEqual(before);
  });

  it('a record of another account or another day does not block a day', async () => {
    store.docs.push({ userId: B, completionId: 'o1', taskId: 'x', status: 'active', source: 'live', localDate: OLD });
    store.docs.push({ userId: A, completionId: 'o2', taskId: 'y', status: 'active', source: 'live', localDate: OLDER });
    const report = await run([row(OLD, [task('t1')])]);
    expect(report.recordsCreated).toBe(1);
  });

  it('a record with no local day (server-observed, legacy client) does not block the day: the snapshot is the only source of that day', async () => {
    store.docs.push({ userId: A, completionId: 's1', taskId: 'x', status: 'active', source: 'live', completedAtSource: 'server', localDate: null });
    const report = await run([row(OLD, [task('t1')])]);
    expect(report.recordsCreated).toBe(1);
  });

  it('ALL OR NOTHING: a day with one unrepresentable task creates no record at all, so it keeps reading from DayHistory', async () => {
    const bad = [task('ok-1'), { taskId: 'has space', title: 'Bad id', estimatedMinutes: 5 }];
    const report = await run([row(OLD, bad as never, { completedCount: 2 })]);
    expect(report.rowsSkippedInvalid).toBe(1);
    expect(store.docs).toHaveLength(0);
    expect(report.issues[0]).toMatchObject({ kind: 'invalid-row', date: OLD });
  });

  it.each([
    ['empty title', { taskId: 't2', title: '  ', estimatedMinutes: 5 }],
    ['over-long title', { taskId: 't2', title: 'x'.repeat(201), estimatedMinutes: 5 }],
    ['negative minutes', { taskId: 't2', title: 'T', estimatedMinutes: -1 }],
    ['non-numeric minutes', { taskId: 't2', title: 'T', estimatedMinutes: '5' }],
    ['over-long id', { taskId: 'a'.repeat(65), title: 'T', estimatedMinutes: 5 }],
  ])('skips the whole day for %s', async (_name, badTask) => {
    const report = await run([row(OLD, [task('t1'), badTask as never], { completedCount: 2 })]);
    expect(report.rowsSkippedInvalid).toBe(1);
    expect(store.docs).toHaveLength(0);
  });

  it('skips a day with a duplicate task id instead of choosing between the entries', async () => {
    const report = await run([row(OLD, [task('t1', 'First'), task('t1', 'Second')])]);
    expect(report.issues[0].kind).toBe('duplicate-task');
    expect(store.docs).toHaveLength(0);
  });

  it('skips a malformed list and an invalid date, and keeps going', async () => {
    const report = await run([
      { userId: A, date: OLD, completedTasks: 'nope' },
      { userId: A, date: '2026-13-45', completedTasks: [] },
      row(OLDER, [task('t1')]),
    ]);
    expect(report.rowsSkippedInvalid).toBe(2);
    expect(report.recordsCreated).toBe(1);
  });

  it('an empty row creates nothing: there is nothing to record and the legacy zero row keeps answering', async () => {
    const report = await run([row(OLD, [])]);
    expect(report.rowsEmpty).toBe(1);
    expect(store.docs).toHaveLength(0);
  });

  it('a row whose stored counts disagree with its list is migrated from the list and reported, not guessed', async () => {
    const report = await run([row(OLD, [task('t1'), task('t2')], { completedCount: 5, workDoneMinutes: 999 })]);
    expect(report.recordsCreated).toBe(2);
    expect(report.rowsWithCountMismatch).toBe(1);
    expect(report.issues[0].kind).toBe('count-mismatch');
  });
});

describe('scope', () => {
  it('migrates each account separately and never mixes ids across accounts', async () => {
    await run([row(OLD, [task('t1')], {}, A), row(OLD, [task('t1')], {}, B)]);
    expect(store.docs).toHaveLength(2);
    expect(new Set(store.docs.map((d) => d.completionId)).size).toBe(2);
    expect(store.docs.map((d) => String(d.userId)).sort()).toEqual([A, B]);
  });

  it('never modifies the legacy rows it reads', async () => {
    const rows = [row(OLD, [task('t1')])];
    const copy = structuredClone(rows);
    await run(rows);
    expect(rows).toEqual(copy);
  });

  it('caps the issue list and says so, while the counts stay complete', async () => {
    const rows = Array.from({ length: mig.ISSUE_LIMIT + 5 }, (_, i) => row(addDays(OLDER, -(i % 50)), [{ taskId: 'bad id', title: 'T', estimatedMinutes: 1 }], {}, `665f1c2e9b1e8a0000${String(i).padStart(6, '0')}`));
    const report = await run(rows);
    expect(report.issues).toHaveLength(mig.ISSUE_LIMIT);
    expect(report.issuesTruncated).toBe(true);
    expect(report.rowsSkippedInvalid).toBe(mig.ISSUE_LIMIT + 5);
  });
});

describe('the read contract is preserved: GET /api/history before and after the migration (Phase 2A reads)', () => {
  const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
  let app: Express;
  let legacy: LegacyStore;
  let realStore: CompletionStore;
  let realMig: typeof import('../src/utils/completionMigration');

  beforeEach(async () => {
    realStore = createCompletionStore();
    legacy = createLegacyStore();
    const users = createUserStore();
    users.seed(A, { xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [] });
    app = await loadAppWith(users, createTaskStore(), SECRET, realStore, legacy.model);
    realMig = await import('../src/utils/completionMigration.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => unmockModels());

  const historyOver = async (endDate: string) =>
    (await request(app).get(`/api/history?days=30&endDate=${endDate}&utcOffsetMinutes=${IST}`).set(as(A))).body.history as {
      date: string;
      completedCount: number;
      workDoneMinutes: number;
      completedTasks: { taskId: string; title: string; estimatedMinutes: number }[];
      updatedAt: string | null;
      source: 'canonical' | 'legacy' | 'none';
    }[];

  it('a migration that fails halfway leaves every day reading exactly what it read before (legacy), and the rerun then migrates without a visible change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    try {
      const today = getToday(IST);
      legacy.rows.push(
        { ...row(OLD, [task('a', 'Alpha', 25), task('b', 'Beta', 5), task('c', 'Gamma', 1)]), updatedAt: new Date('2026-11-01T20:00:00Z') },
      );
      const normalise = (entries: Awaited<ReturnType<typeof historyOver>>) =>
        entries.map(({ source: _source, ...e }) => ({ ...e, completedTasks: [...e.completedTasks].sort((x, y) => x.taskId.localeCompare(y.taskId)), updatedAt: e.updatedAt !== null })); // `source` is what MAY change: asserted separately
      const before = normalise(await historyOver(today));

      let n = 0;
      realStore.hooks.failCreate = () => (++n === 2 ? new Error('boom') : null);
      const failed = await realMig.migrateDayHistory(legacy.rows as never, { apply: true, now: new Date() });
      expect(failed.rowsFailed).toBe(1);
      expect(realStore.docs).toHaveLength(0);
      expect(normalise(await historyOver(today))).toEqual(before); // never a partial canonical day
      expect((await historyOver(today)).find((e) => e.date === OLD)?.source).toBe('legacy');

      realStore.hooks.failCreate = undefined;
      await realMig.migrateDayHistory(legacy.rows as never, { apply: true, now: new Date() });
      expect(normalise(await historyOver(today))).toEqual(before);
      expect(realStore.docs).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every frozen day reads the same tasks, count and minutes after the migration; days that were not migrated are untouched; updatedAt keeps meaning "a record exists"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    try {
      const today = getToday(IST);
      legacy.rows.push(
        { ...row(OLD, [task('a', 'Alpha', 25), task('b', 'Beta', 5)]), updatedAt: new Date('2026-11-01T20:00:00Z') },
        { ...row(OLDER, [task('c', 'Gamma', 40)]), updatedAt: new Date('2026-10-15T20:00:00Z') },
        { ...row(addDays(today, -2), [task('d', 'Recent', 15)]), updatedAt: new Date('2026-11-18T20:00:00Z') }, // writable: not migrated
        { ...row('2026-10-20', []), updatedAt: new Date('2026-10-20T20:00:00Z') }, // empty: not migrated
      );
      const before = await historyOver(today);

      const report = await realMig.migrateDayHistory(legacy.rows as never, { apply: true, now: new Date() });
      expect(report.recordsCreated).toBe(3);
      const after = await historyOver(today);

      const normalise = (entries: typeof before) =>
        entries.map(({ source: _source, ...e }) => ({ ...e, completedTasks: [...e.completedTasks].sort((x, y) => x.taskId.localeCompare(y.taskId)), updatedAt: e.updatedAt !== null })); // `source` is what MAY change: asserted separately
      expect(normalise(after)).toEqual(normalise(before));
      expect(after.find((e) => e.date === OLD)?.completedCount).toBe(2);
      // only the answering source changes: migrated days are canonical now, the rest is as it was
      expect(before.find((e) => e.date === OLD)?.source).toBe('legacy');
      expect(after.find((e) => e.date === OLD)?.source).toBe('canonical');
      expect(after.find((e) => e.date === addDays(today, -2))?.source).toBe('legacy');
      // the day is now canonical: the legacy row is no longer consulted for it
      expect(legacy.finds[legacy.finds.length - 1]?.dates).not.toContain(OLD);
      expect(legacy.finds[legacy.finds.length - 1]?.dates).toContain(addDays(today, -2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Phase 2F: a day whose canonical records were all REVOKED still reads canonical-zero (never legacy), and the repair imports only the task nothing covers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    try {
      const today = getToday(IST);
      legacy.rows.push({ ...row(OLD, [task('a', 'Alpha', 25)]), updatedAt: new Date('2026-11-01T20:00:00Z') });
      realStore.docs.push({
        userId: A, completionId: 'rev-a', taskId: 'a', titleSnapshot: 'Alpha', estimatedMinutesSnapshot: 25, status: 'revoked', source: 'live',
        completedAtSource: 'client', localDate: OLD, completedAt: new Date('2026-11-01T05:00:00Z'), utcOffsetMinutes: IST, revokedReason: 'uncompleted', revokeReceivedAt: new Date(),
      });

      const before = (await historyOver(today)).find((e) => e.date === OLD)!;
      expect(before.source).toBe('canonical'); // the any-record rule: revoked records still make the day canonical
      expect(before.completedCount).toBe(0); // ... and nothing stands: no fall back to the snapshot

      const report = await realMig.migrateDayHistory(legacy.rows as never, { apply: true, now: new Date() });
      expect(report.recordsCreated).toBe(0); // the only legacy task is covered by the revoked record
      const after = (await historyOver(today)).find((e) => e.date === OLD)!;
      expect(after.source).toBe('canonical');
      expect(after.completedCount).toBe(0);
      expect(after.completedTasks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Phase 2F: a MIXED day (live record for A, legacy A and B) reads only A before the repair and A + B after it, with A\'s record untouched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    try {
      const today = getToday(IST);
      legacy.rows.push({ ...row(OLD, [task('a', 'Alpha', 25), task('b', 'Beta', 5)]), updatedAt: new Date('2026-11-01T20:00:00Z') });
      realStore.docs.push({
        userId: A, completionId: 'live-a', taskId: 'a', titleSnapshot: 'Alpha (client)', estimatedMinutesSnapshot: 25, status: 'active', source: 'live',
        completedAtSource: 'client', localDate: OLD, completedAt: new Date('2026-11-01T05:00:00Z'), utcOffsetMinutes: IST,
      });
      const liveBefore = structuredClone(realStore.docs[0]);

      const before = (await historyOver(today)).find((e) => e.date === OLD)!;
      expect(before.completedTasks.map((t) => t.taskId)).toEqual(['a']); // the gap Phase 2F closes: B is hidden

      await realMig.migrateDayHistory(legacy.rows as never, { apply: true, now: new Date() });
      const after = (await historyOver(today)).find((e) => e.date === OLD)!;
      expect(after.completedTasks.map((t) => t.taskId).sort()).toEqual(['a', 'b']);
      expect(after.completedCount).toBe(2);
      expect(realStore.docs.find((d) => d.completionId === 'live-a')).toEqual(liveBefore);
      expect(legacy.rows).toHaveLength(1); // DayHistory is never modified
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('Phase 2F: mixed-day repair (per task)', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    userId: A, completionId: 'live-a', taskId: 'a', titleSnapshot: 'Alpha', estimatedMinutesSnapshot: 10, status: 'active', source: 'live',
    completedAtSource: 'client', localDate: OLD, completedAt: new Date('2026-11-01T05:00:00Z'), utcOffsetMinutes: IST, ...over,
  });

  it('a pure legacy day behaves exactly as before: every task imported, reported as a plain migrated day', async () => {
    const report = await run([row(OLD, [task('a'), task('b')])]);
    expect(report.recordsCreated).toBe(2);
    expect(report.rowsToMigrate).toBe(1);
    expect(report.rowsMixedToRepair).toBe(0);
    expect(report.recordsCoveredByCanonical).toBe(0);
  });

  it('MIXED: A has a canonical record, B is legacy-only: A is preserved byte for byte and B is imported as a migrated record', async () => {
    store.docs.push(live());
    const aBefore = structuredClone(store.docs[0]);
    const report = await run([row(OLD, [task('a', 'Alpha', 10), task('b', 'Beta', 7)])]);

    expect(report.rowsMixedToRepair).toBe(1);
    expect(report.recordsCreated).toBe(1);
    expect(store.docs).toHaveLength(2);
    expect(store.docs[0]).toEqual(aBefore);
    expect(store.docs[1]).toMatchObject({
      userId: A, taskId: 'b', titleSnapshot: 'Beta', estimatedMinutesSnapshot: 7, localDate: OLD, completedAt: null, utcOffsetMinutes: null,
      status: 'active', source: 'migrated', completedAtSource: 'migrated', completionId: mig.migratedCompletionId(A, OLD, 'b'),
    });
  });

  it('ALREADY IMPORTED: running the repair twice creates one record for B, and the second run changes nothing', async () => {
    store.docs.push(live());
    const rows = [row(OLD, [task('a'), task('b')])];
    const first = await run(rows);
    const afterFirst = structuredClone(store.docs);
    const second = await run(rows);

    expect(first.recordsCreated).toBe(1);
    expect(second.recordsCreated).toBe(0);
    expect(second.rowsMixedAlreadyCovered).toBe(1);
    expect(second.rowsMixedToRepair).toBe(0);
    expect(store.docs.filter((d) => d.taskId === 'b')).toHaveLength(1);
    expect(store.docs).toEqual(afterFirst);
  });

  it('CONFLICT: canonical and legacy describe the same task differently: canonical wins, nothing is overwritten and no second record appears', async () => {
    store.docs.push(live({ titleSnapshot: 'Edited title', estimatedMinutesSnapshot: 99 }));
    const before = structuredClone(store.docs);
    const report = await run([row(OLD, [task('a', 'Old legacy title', 5)])]);
    expect(report.recordsCreated).toBe(0);
    expect(report.recordsCoveredByCanonical).toBe(1);
    expect(store.docs).toEqual(before);
  });

  it('MANY: every legacy task no record covers is imported, the covered ones (active and revoked) are not', async () => {
    store.docs.push(
      live({ completionId: 'l-a', taskId: 'a' }),
      live({ completionId: 'l-c', taskId: 'c', status: 'revoked', revokedReason: 'superseded', revokeReceivedAt: new Date() }),
    );
    const report = await run([row(OLD, ['a', 'b', 'c', 'd', 'e'].map((id) => task(id)))]);
    expect(report.recordsCreated).toBe(3);
    expect(report.recordsCoveredByCanonical).toBe(2);
    expect(store.docs.filter((d) => d.source === 'migrated').map((d) => d.taskId).sort()).toEqual(['b', 'd', 'e']);
  });

  it('DELETED TASK: the repair never reads the task collection, so a completion of a task that no longer exists is imported from the snapshot alone', async () => {
    store.docs.push(live());
    await run([row(OLD, [task('a'), task('long-gone-task', 'Deleted since', 12)])]);
    expect(store.docs.find((d) => d.taskId === 'long-gone-task')).toMatchObject({ titleSnapshot: 'Deleted since', estimatedMinutesSnapshot: 12, source: 'migrated', status: 'active' });
  });

  it('DETERMINISTIC ID: the imported id is the same one a pure migration uses, across runs, stores and processes of the same input', async () => {
    store.docs.push(live());
    await run([row(OLD, [task('a'), task('b')])]);
    const id = store.docs.find((d) => d.taskId === 'b')!.completionId;
    expect(id).toBe(mig.migratedCompletionId(A, OLD, 'b'));

    const other = createCompletionStore();
    removeCompletionRecordMock();
    installCompletionRecordMock(other);
    vi.resetModules();
    const mig2 = await import('../src/utils/completionMigration.js');
    await mig2.migrateDayHistory([row(OLD, [task('b')])] as never, { apply: true, now: new Date('2030-01-01T00:00:00Z') }); // a different "now" must not matter
    expect(other.docs[0].completionId).toBe(id);
  });

  it('a record already holding the deterministic id of an uncovered task (under another task id) is not inserted over: the rest of the day is still repaired', async () => {
    store.docs.push(live(), live({ completionId: mig.migratedCompletionId(A, OLD, 'b'), taskId: 'odd', source: 'migrated', completedAtSource: 'migrated', completedAt: null }));
    const report = await run([row(OLD, [task('a'), task('b'), task('c')])]);
    expect(report.rowsFailed).toBe(0);
    expect(store.docs.filter((d) => d.taskId === 'c' && d.source === 'migrated')).toHaveLength(1);
    expect(store.docs.filter((d) => d.completionId === mig.migratedCompletionId(A, OLD, 'b'))).toHaveLength(1);
  });

  it('a record with no local day (server-observed) covers nothing: the legacy task is still imported', async () => {
    store.docs.push(live({ completionId: 'srv', taskId: 'a', localDate: null, completedAtSource: 'server' }), live({ completionId: 'l-b', taskId: 'b' }));
    const report = await run([row(OLD, [task('a'), task('b')])]);
    expect(report.recordsCreated).toBe(1);
    expect(store.docs.find((d) => d.source === 'migrated')?.taskId).toBe('a');
  });

  it('a covering record of the same task on ANOTHER day, or of another account, does not cover this day', async () => {
    store.docs.push(live({ completionId: 'l1', localDate: OLDER }), live({ completionId: 'l2', userId: B }), live({ completionId: 'l3', taskId: 'z' }));
    const report = await run([row(OLD, [task('a'), task('z')])]);
    expect(report.recordsCreated).toBe(1); // only 'a' is missing: 'z' is covered on OLD by l3
    expect(store.docs.find((d) => d.source === 'migrated')?.taskId).toBe('a');
  });

  it('does not touch other days or tasks: a frozen day with no records is imported whole, and unrelated canonical records are unchanged', async () => {
    store.docs.push(live(), live({ completionId: 'unrelated', taskId: 'q', localDate: '2026-09-01' }));
    const before = structuredClone(store.docs);
    await run([row(OLD, [task('a'), task('b')]), row(OLDER, [task('c')])]);
    expect(store.docs.slice(0, 2)).toEqual(before);
    expect(store.docs.filter((d) => d.localDate === OLDER)).toHaveLength(1);
    expect(store.docs.filter((d) => d.localDate === '2026-09-01')).toHaveLength(1);
  });

  it('a writable mixed day is still skipped (the frozen-day rule applies before any repair)', async () => {
    const recent = addDays(getToday(IST, NOW), -1);
    store.docs.push(live({ localDate: recent }));
    const report = await run([row(recent, [task('a'), task('b')])]);
    expect(report.rowsSkippedWritable).toBe(1);
    expect(report.recordsCreated).toBe(0);
  });

  it('ATOMIC: when one import of a mixed day fails, none of that day\'s imports stay, the canonical record is untouched, and the rerun repairs the day', async () => {
    store.docs.push(live());
    const aBefore = structuredClone(store.docs);
    const rows = [row(OLD, ['a', 'b', 'c', 'd'].map((id) => task(id)))];
    for (let failAt = 1; failAt <= 3; failAt += 1) {
      let n = 0;
      store.hooks.failCreate = () => (++n === failAt ? new Error('boom') : null);
      const report = await run(rows);
      expect(report.rowsFailed).toBe(1);
      expect(report.recordsCreated).toBe(0);
      expect(store.docs).toEqual(aBefore);
    }
    store.hooks.failCommit = () => Object.assign(new Error('commit failed'), { code: 'ECONNRESET' });
    store.hooks.failCreate = undefined;
    expect((await run(rows)).rowsFailed).toBe(1);
    expect(store.docs).toEqual(aBefore);

    store.hooks.failCommit = undefined;
    const ok = await run(rows);
    expect(ok.recordsCreated).toBe(3);
    expect(store.docs.filter((d) => d.source === 'migrated')).toHaveLength(3);
  });

  it('a standalone server (no transactions) repairs nothing and reports the mixed day as failed', async () => {
    store.docs.push(live());
    store.hooks.standalone = true;
    const report = await run([row(OLD, [task('a'), task('b')])]);
    expect(report.rowsFailed).toBe(1);
    expect(store.docs).toHaveLength(1);
  });

  it('RE-CHECKED inside the transaction: a record that covers B appears after the first look, so B is not imported (and not reported as an error)', async () => {
    store.docs.push(live());
    let finds = 0;
    store.hooks.delay = (op) => {
      if (op !== 'find') return;
      finds += 1;
      if (finds === 2) store.docs.push(live({ completionId: 'late-b', taskId: 'b', completedAt: new Date('2026-11-01T06:00:00Z') }));
    };
    const report = await run([row(OLD, [task('a'), task('b'), task('c')])]);
    expect(report.rowsFailed).toBe(0);
    expect(report.recordsCreated).toBe(1);
    expect(report.recordsAlreadyPresent).toBe(1);
    expect(store.docs.filter((d) => d.taskId === 'b')).toHaveLength(1);
    expect(store.docs.find((d) => d.completionId === 'late-b')).toBeDefined();
  });

  it('two repairs at the same time leave one record per missing task (unique id; the loser sees "present")', async () => {
    store.docs.push(live());
    const rows = [row(OLD, [task('a'), task('b'), task('c')])];
    const [r1, r2] = await Promise.all([run(rows), run(rows)]);
    expect(store.docs.filter((d) => d.source === 'migrated')).toHaveLength(2);
    expect(r1.recordsCreated + r2.recordsCreated).toBe(2);
    expect(r1.rowsFailed + r2.rowsFailed).toBe(0);
  });

  it('a pure day that turns mixed after the first look is left alone by that run, and the next run repairs it', async () => {
    let finds = 0;
    store.hooks.delay = (op) => {
      if (op !== 'find') return;
      finds += 1;
      if (finds === 2) store.docs.push(live({ completionId: 'late', taskId: 'a' }));
    };
    const rows = [row(OLD, [task('a'), task('b')])];
    const first = await run(rows);
    expect(first.recordsCreated).toBe(0);
    store.hooks.delay = undefined;
    const second = await run(rows);
    expect(second.recordsCreated).toBe(1);
    expect(store.docs.find((d) => d.source === 'migrated')?.taskId).toBe('b');
  });
});
