import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_JWT_SECRET as SECRET } from './testConfig';
import { addDays, getToday, localDateAt } from '../src/utils/calendarDate';
import { createCompletionStore, type CompletionStore } from './helpers/completionDoubles';
import { createLegacyStore, type LegacyStore } from './helpers/historyDoubles';
import { createTaskStore, createUserStore, loadAppWith, unmockModels, type TaskStore, type UserStore } from './helpers/treeDoubles';

// Issue #47, Phase 2A — GET /api/history reads CompletionRecord first and falls back to legacy DayHistory, PER DAY.
// Completions are made through the real task routes (so the records are exactly what Phase 1B writes); legacy snapshots are
// seeded into a DayHistory double. See the "TRANSITIONAL READ CONTRACT" comment in controllers/history.controller.ts.

const A = '665f1c2e9b1e8a00000000aa';
const B = '665f1c2e9b1e8a00000000bb';
const IST = 330;
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const as = (userId: string) => ({ Authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, name: userId }, SECRET)}` });
const emptyTree = () => ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [] });

let users: UserStore;
let tasks: TaskStore;
let records: CompletionStore;
let legacy: LegacyStore;
let app: Express;

beforeEach(async () => {
  users = createUserStore();
  tasks = createTaskStore();
  records = createCompletionStore();
  legacy = createLegacyStore();
  users.seed(A, emptyTree());
  users.seed(B, emptyTree());
  app = await loadAppWith(users, tasks, SECRET, records, legacy.model);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  unmockModels();
});

const today = () => getToday(IST);
const day = (offset: number) => addDays(today(), offset);

const put = (id: string, body: object, user = A) => request(app).put(`/api/tasks/${id}`).set(as(user)).send(body);
const seedTask = (title: string, over: Record<string, unknown> = {}, user = A) => tasks.seed(user, { title, estimatedMinutes: 30, ...over });
const history = (days = 7, user = A) =>
  request(app).get(`/api/history?days=${days}&endDate=${today()}&utcOffsetMinutes=${IST}`).set(as(user));

const completeEvent = (completionId: string, completedAt: Date) => ({
  completed: true,
  completionEvent: { completionId, completedAt: completedAt.toISOString(), utcOffsetMinutes: IST },
});
const undoEvent = (completionId: string) => ({
  completed: false,
  completionEvent: { completionId, revokedAt: new Date(Date.now() - MIN / 2).toISOString() },
});

const entryOn = (body: { history: { date: string }[] }, date: string) => body.history.find((e) => e.date === date) as Record<string, any>;

const legacyRow = (date: string, taskTitles: string[], user = A) => ({
  userId: user,
  date,
  completedCount: taskTitles.length,
  workDoneMinutes: taskTitles.length * 10,
  completedTasks: taskTitles.map((title, i) => ({ taskId: `legacy-${date}-${i}`, title, estimatedMinutes: 10 })),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
});

describe('canonical reads: what the history says once CompletionRecords exist', () => {
  it('a deleted task stays in historical completion data (the record carries its own title and estimate)', async () => {
    const task = seedTask('Write report');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));
    const del = await request(app).delete(`/api/tasks/${task._id}`).set(as(A));
    expect(del.status).toBeLessThan(300);
    expect(tasks.get(String(task._id))).toBeUndefined();

    const res = await history();

    const entry = entryOn(res.body, localDateAt(new Date(Date.now() - MIN), IST));
    expect(entry.completedCount).toBe(1);
    expect(entry.workDoneMinutes).toBe(30);
    expect(entry.completedTasks).toEqual([{ taskId: String(task._id), title: 'Write report', estimatedMinutes: 30 }]);
  });

  it('a later rename or edit of the task does not change history (snapshots)', async () => {
    const task = seedTask('Original title');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));
    await put(String(task._id), { title: 'Renamed', estimatedMinutes: 99 });

    const res = await history();

    expect(entryOn(res.body, today()).completedTasks).toEqual([{ taskId: String(task._id), title: 'Original title', estimatedMinutes: 30 }]);
  });

  it('uses the record completedAt/localDate contract: the day is the one the user lived at completion, not the day the server received it', async () => {
    // 19:00 UTC three days ago is 00:30 the NEXT day in India: the record's day is day(-2), the UTC date is day(-3)
    const utcDay = new Date(Date.now() - 3 * DAY);
    utcDay.setUTCHours(19, 0, 0, 0);
    const expectedLocal = localDateAt(utcDay, IST);
    expect(expectedLocal).not.toBe(utcDay.toISOString().slice(0, 10));
    const task = seedTask('Late night');
    await put(String(task._id), completeEvent('c1', utcDay));

    const res = await history();

    expect(entryOn(res.body, expectedLocal).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Late night']);
    expect(entryOn(res.body, expectedLocal).completedCount).toBe(1);
    expect(entryOn(res.body, today()).completedCount).toBe(0); // received today, but it did not happen today
    expect(entryOn(res.body, today()).updatedAt).toBeNull();
  });

  it('complete -> uncomplete -> complete: two separate records, history shows the one that stands (once)', async () => {
    const task = seedTask('Flip flop');
    const id = String(task._id);
    await put(id, completeEvent('c1', new Date(Date.now() - 3 * MIN)));
    await put(id, undoEvent('c1'));
    await put(id, completeEvent('c2', new Date(Date.now() - MIN)));

    expect(records.docs.map((d) => `${d.completionId}:${d.status}`).sort()).toEqual(['c1:revoked', 'c2:active']);
    const res = await history();

    const entry = entryOn(res.body, today());
    expect(entry.completedCount).toBe(1);
    expect(entry.completedTasks).toHaveLength(1);
  });

  it('a completion on an earlier day that was later uncompleted reads as zero there; a legacy snapshot of that day is NOT brought back', async () => {
    const task = seedTask('Done then undone');
    const id = String(task._id);
    const earlier = new Date(Date.now() - 2 * DAY);
    await put(id, completeEvent('c1', earlier));
    await put(id, undoEvent('c1'));
    await put(id, completeEvent('c2', new Date(Date.now() - MIN)));
    const earlierDay = localDateAt(earlier, IST);
    legacy.rows.push(legacyRow(earlierDay, ['Stale legacy snapshot of the same day']));

    const res = await history();

    const old = entryOn(res.body, earlierDay);
    expect(old.completedCount).toBe(0); // canonical: the completion that day was revoked
    expect(old.completedTasks).toEqual([]);
    expect(old.updatedAt).not.toBeNull(); // "a record that is genuinely zero", not "no record"
    expect(entryOn(res.body, today()).completedCount).toBe(1);
  });

  it('two different tasks on one day are both listed, oldest completion first; counts and minutes agree', async () => {
    const first = seedTask('First', { estimatedMinutes: 10 });
    const second = seedTask('Second', { estimatedMinutes: 25 });
    await put(String(second._id), completeEvent('c2', new Date(Date.now() - MIN)));
    await put(String(first._id), completeEvent('c1', new Date(Date.now() - 5 * MIN)));

    const entry = entryOn((await history()).body, today());

    expect(entry.completedTasks.map((t: { title: string }) => t.title)).toEqual(['First', 'Second']);
    expect(entry.completedCount).toBe(2);
    expect(entry.workDoneMinutes).toBe(35);
  });

  it('a migrated-style record (no instant, a legacy day) is counted after the dated ones; a record with an unknown day is not part of any day', async () => {
    const task = seedTask('Live');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));
    const base = { userId: A, status: 'active', source: 'migrated', completedAtSource: 'migrated', receivedAt: new Date('2026-10-01T00:00:00Z') };
    records.docs.push({ ...base, completionId: 'm1', taskId: 'old-1', titleSnapshot: 'Migrated', estimatedMinutesSnapshot: 5, completedAt: null, localDate: today() });
    records.docs.push({ ...base, source: 'live', completedAtSource: 'server', completionId: 'unknown-day', taskId: 'x', titleSnapshot: 'No day', estimatedMinutesSnapshot: 7, completedAt: new Date(), localDate: null });

    const entry = entryOn((await history()).body, today());

    expect(entry.completedTasks.map((t: { title: string }) => t.title)).toEqual(['Live', 'Migrated']);
    expect(entry.workDoneMinutes).toBe(35);
  });
});

describe('transitional fallback: canonical first, legacy DayHistory otherwise, per day, never merged', () => {
  it('canonical records are preferred over a legacy snapshot of the same day (not summed, not merged)', async () => {
    legacy.rows.push(legacyRow(today(), ['Legacy A', 'Legacy B']));
    const task = seedTask('Canonical');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    const entry = entryOn((await history()).body, today());

    expect(entry.completedTasks.map((t: { title: string }) => t.title)).toEqual(['Canonical']);
    expect(entry.completedCount).toBe(1);
    expect(entry.workDoneMinutes).toBe(30);
  });

  it('legacy-only history still works: every day with a snapshot is served exactly as stored', async () => {
    legacy.rows.push(legacyRow(day(-1), ['Yesterday one', 'Yesterday two']), legacyRow(day(-3), ['Three days ago']));

    const res = await history();

    expect(res.status).toBe(200);
    expect(entryOn(res.body, day(-1))).toMatchObject({ completedCount: 2, workDoneMinutes: 20, updatedAt: '2026-10-01T10:00:00.000Z' });
    expect(entryOn(res.body, day(-1)).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Yesterday one', 'Yesterday two']);
    expect(entryOn(res.body, day(-3)).completedCount).toBe(1);
    expect(entryOn(res.body, day(-2))).toMatchObject({ completedCount: 0, completedTasks: [], updatedAt: null });
  });

  it('canonical data on one day does not erase legacy data on the other days of the window', async () => {
    legacy.rows.push(legacyRow(day(-1), ['Legacy yesterday']), legacyRow(day(-4), ['Legacy older']));
    const task = seedTask('New today');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    const res = await history();

    expect(entryOn(res.body, today()).completedTasks.map((t: { title: string }) => t.title)).toEqual(['New today']);
    expect(entryOn(res.body, day(-1)).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy yesterday']);
    expect(entryOn(res.body, day(-4)).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy older']);
  });

  it('EMPTY canonical history does not erase valid legacy history: other accounts, days outside the window and unknown-day records are not "canonical" for these days', async () => {
    legacy.rows.push(legacyRow(today(), ['Legacy today']), legacyRow(day(-2), ['Legacy two']));
    const other = seedTask('Someone else', {}, B);
    await put(String(other._id), completeEvent('b1', new Date(Date.now() - MIN)), B);
    records.docs.push({
      userId: A, completionId: 'old', taskId: 't', titleSnapshot: 'Outside the window', estimatedMinutesSnapshot: 5, completedAt: new Date(Date.now() - 40 * DAY),
      receivedAt: new Date(), status: 'active', source: 'live', completedAtSource: 'client', localDate: day(-40),
    });
    records.docs.push({
      userId: A, completionId: 'srv-1', taskId: 'u', titleSnapshot: 'Server-observed', estimatedMinutesSnapshot: 5, completedAt: new Date(),
      receivedAt: new Date(), status: 'active', source: 'live', completedAtSource: 'server', localDate: null,
    });

    const res = await history();

    expect(entryOn(res.body, today()).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy today']);
    expect(entryOn(res.body, day(-2)).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy two']);
  });

  it('a legacy client (no completion event) keeps its legacy day: its server-observed record has no local day, so the DayHistory snapshot answers', async () => {
    const task = seedTask('Legacy client task');
    await put(String(task._id), { completed: true }); // no event: a server-observed record with localDate null
    expect(records.docs[0]).toMatchObject({ completedAtSource: 'server', localDate: null });
    legacy.rows.push(legacyRow(today(), ['Legacy client task']));

    const entry = entryOn((await history()).body, today());

    expect(entry.completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy client task']);
  });

  it('the legacy store is only asked about days the canonical source does not know', async () => {
    const task = seedTask('Only today');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    await history(1);
    expect(legacy.finds).toEqual([]); // the single requested day is canonical: no legacy read at all

    await history(3);
    expect(legacy.finds).toHaveLength(1);
    expect(legacy.finds[0].dates.sort()).toEqual([day(-2), day(-1)]);
  });

  it('the legacy write path still works and is read back through the fallback (PUT /api/history/today -> GET)', async () => {
    const put1 = await request(app)
      .put('/api/history/today')
      .set(as(A))
      .send({ date: today(), utcOffsetMinutes: IST, completedCount: 1, workDoneMinutes: 15, completedTasks: [{ taskId: 'abc', title: 'Via legacy', estimatedMinutes: 15 }] });
    expect(put1.status).toBe(200);

    const entry = entryOn((await history()).body, today());

    expect(entry.completedTasks).toEqual([{ taskId: 'abc', title: 'Via legacy', estimatedMinutes: 15 }]);
  });
});

describe('client transition: legacy writes cannot override a canonical day (Phase 2A)', () => {
  const legacyPut = (date: string, titles: string[]) =>
    request(app)
      .put(date === today() ? '/api/history/today' : `/api/history/${date}`)
      .set(as(A))
      .send({
        date,
        utcOffsetMinutes: IST,
        completedCount: titles.length,
        workDoneMinutes: titles.length * 10,
        completedTasks: titles.map((title, i) => ({ taskId: `local-${i}`, title, estimatedMinutes: 10 })),
      });

  it('a legacy PUT with an extra completion succeeds, yet the day keeps reading canonical-only, on every later read (convergence)', async () => {
    const task = seedTask('Canonical task');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    // The stale client mirror holds the canonical task AND one more completion nobody sent as an event.
    const res = await legacyPut(today(), ['Canonical task', 'Only in the local mirror']);
    expect(res.status).toBe(200); // acknowledged: the client will clear its pending flag

    for (let i = 0; i < 3; i += 1) {
      const entry = entryOn((await history()).body, today());
      expect(entry.completedTasks.map((t: { title: string }) => t.title)).toEqual(['Canonical task']);
      expect(entry.completedCount).toBe(1);
      expect(entry.workDoneMinutes).toBe(30);
    }
    // The legacy row was stored (the write path is unchanged) but is never read for a canonical day.
    expect(legacy.rows.some((r) => r.date === today())).toBe(true);
  });

  it('a stale non-empty legacy PUT cannot resurrect a day whose canonical completions were all revoked: it still reads zero', async () => {
    const task = seedTask('Done then undone');
    const id = String(task._id);
    await put(id, completeEvent('c1', new Date(Date.now() - 2 * MIN)));
    await put(id, undoEvent('c1'));

    const res = await legacyPut(today(), ['Done then undone']);
    expect(res.status).toBe(200);

    const entry = entryOn((await history()).body, today());
    expect(entry.completedCount).toBe(0);
    expect(entry.completedTasks).toEqual([]);
    expect(entry.workDoneMinutes).toBe(0);
    expect(entry.updatedAt).not.toBeNull();
  });

  it('the same holds for a backdated day (PUT /api/history/:date) and a legacy-only neighbour day is still written and read normally', async () => {
    const task = seedTask('Yesterday');
    const earlier = new Date(Date.now() - DAY);
    await put(String(task._id), completeEvent('c1', earlier));
    const canonicalDay = localDateAt(earlier, IST);
    const neighbour = day(-3);

    expect((await legacyPut(canonicalDay, ['Yesterday', 'Stale extra'])).status).toBe(200);
    expect((await legacyPut(neighbour, ['Legacy only'])).status).toBe(200);

    const body = (await history()).body;
    expect(entryOn(body, canonicalDay).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Yesterday']);
    expect(entryOn(body, neighbour).completedTasks.map((t: { title: string }) => t.title)).toEqual(['Legacy only']);
  });
});

describe('response contract (what existing consumers rely on)', () => {
  it('returns exactly `days` entries, oldest to newest, with the unchanged keys plus `source`, for canonical, legacy and empty days alike', async () => {
    legacy.rows.push(legacyRow(day(-1), ['Legacy']));
    const task = seedTask('Canonical');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    for (const days of [1, 3, 7]) {
      const res = await history(days);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['history']);
      expect(res.body.history.map((e: { date: string }) => e.date)).toEqual(Array.from({ length: days }, (_, i) => day(i - (days - 1))));
      for (const entry of res.body.history) {
        expect(Object.keys(entry).sort()).toEqual(['completedCount', 'completedTasks', 'date', 'source', 'updatedAt', 'workDoneMinutes']);
        expect(['canonical', 'legacy', 'none']).toContain(entry.source);
        for (const t of entry.completedTasks) expect(Object.keys(t).sort()).toEqual(['estimatedMinutes', 'taskId', 'title']);
        expect(typeof entry.completedCount).toBe('number');
        expect(typeof entry.workDoneMinutes).toBe('number');
        expect(entry.updatedAt === null || typeof entry.updatedAt === 'string').toBe(true);
      }
    }
  });

  it('tells the client which source answered each day: canonical (even all-revoked), legacy (even a stored zero row), none', async () => {
    const live = seedTask('Live');
    await put(String(live._id), completeEvent('c1', new Date(Date.now() - 2 * MIN)));
    const undone = seedTask('Undone');
    const earlier = new Date(Date.now() - DAY);
    await put(String(undone._id), completeEvent('c2', earlier));
    await put(String(undone._id), undoEvent('c2'));
    legacy.rows.push(legacyRow(day(-3), ['Legacy']), legacyRow(day(-4), []));

    const body = (await history(7)).body;
    const sourceOn = (date: string) => entryOn(body, date).source;

    expect(sourceOn(today())).toBe('canonical');
    expect(sourceOn(localDateAt(earlier, IST))).toBe('canonical'); // all revoked: still canonical, reads zero
    expect(sourceOn(day(-3))).toBe('legacy');
    expect(sourceOn(day(-4))).toBe('legacy'); // a stored zero row is still a legacy answer
    expect(sourceOn(day(-5))).toBe('none');
  });

  it('keeps the "no record" vs "a record that is zero" distinction: a day with no data has updatedAt null; a canonical day always has one', async () => {
    const task = seedTask('T');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - 2 * MIN)));
    await put(String(task._id), undoEvent('c1'));

    const res = await history(2);

    expect(entryOn(res.body, today())).toMatchObject({ completedCount: 0, completedTasks: [] });
    expect(typeof entryOn(res.body, today()).updatedAt).toBe('string');
    expect(entryOn(res.body, day(-1))).toMatchObject({ completedCount: 0, updatedAt: null });
  });

  it('is scoped to the caller: another account sees none of these completions', async () => {
    const task = seedTask('Private');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));

    const res = await history(7, B);

    expect(res.body.history.every((e: { completedCount: number }) => e.completedCount === 0)).toBe(true);
  });

  it('is read-only: a history read writes nothing', async () => {
    const task = seedTask('T');
    await put(String(task._id), completeEvent('c1', new Date(Date.now() - MIN)));
    const before = JSON.stringify(records.docs);
    const opsBefore = records.ops.length;

    await history();
    await history();

    expect(JSON.stringify(records.docs)).toBe(before);
    expect(records.ops.slice(opsBefore).every((op) => op === 'find')).toBe(true);
  });

  it('still rejects bad queries exactly as before (nothing is read)', async () => {
    const res = await request(app).get(`/api/history?days=7&endDate=2020-01-01&utcOffsetMinutes=${IST}`).set(as(A));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DATE_NOT_TODAY');
    expect(records.ops.filter((op) => op === 'find')).toHaveLength(0);
  });
});
