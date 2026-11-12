import { createHash } from 'node:crypto';
import CompletionRecord from '../models/CompletionRecord.model';
import { addDays, getToday, isValidCalendarDate, MIN_UTC_OFFSET_MINUTES } from './calendarDate';
import { recordMigratedDay, recordMissingMigratedCompletions } from './completionRecords';
import { HISTORY_RETENTION_DAYS, parseCompletedTask, type CompletedTaskInput } from './historyValidators';

// -- Migrating legacy DayHistory into CompletionRecord (Issue #47, Phase 2B) -----------------------------------------------
//
// WHAT IT DOES. For each legacy DayHistory row it writes one `migrated` CompletionRecord per listed task: taskId, title and
// estimate from the snapshot, `localDate` = the row's date, `completedAt`/`utcOffsetMinutes` = null (a snapshot does not
// know WHEN in the day, and nothing is reconstructed from Task.completedAt or Growth data: see decision O8 in the design).
// It never invents a completion instant, a transition count, or "completed twice".
//
// WHY THE RULES BELOW ARE SHAPED BY THE PHASE 2A READ CONTRACT. A day that has ANY record is read from records only
// (utils/completionHistory.ts), and its DayHistory row is then ignored. So writing records for a day changes what that day
// reads, and the migration must never make a day read worse than it did:
//   1. A day is migrated ALL OR NOTHING at validation level: if any task of the row cannot be represented exactly (bad id,
//      title or minutes, a duplicate task id, a malformed list) the whole day is skipped and keeps reading from DayHistory.
//      A half-migrated day would silently drop the tasks that failed.
//   2. A day is migrated only once it is FROZEN: legacy clients can still write DayHistory for today and the last 7 local
//      days (PUT /api/history/*). A write that arrives after the day became canonical would be ignored. A date is frozen
//      when no client, at any UTC offset, can still write it. `includeWritableDays` lifts this and is only safe after the
//      legacy writes are retired.
//   3. A day that already has records is not skipped wholesale any more (Phase 2F), because the read contract made it canonical
//      the moment a 2E client wrote its first record, which hid every legacy task of that day nobody had recorded: a MIXED
//      day. It is repaired PER TASK, and only here, never at read time (a canonical day is still never merged with its
//      snapshot when it is read: O5):
//        - a legacy task is COVERED when a record of the same task holds that local day, in ANY status (active, revoked,
//          superseded) and from ANY source. Covered tasks are left alone: canonical records win, are never rewritten, and a
//          task the records say was revoked is never brought back by the snapshot;
//        - a legacy task no record covers is imported as a `migrated` record with the SAME deterministic id a pure migration
//          would use, so a rerun finds it covered and writes nothing;
//        - the day's missing records are written in one transaction, all or none (rule 4), re-reading the day inside it;
//        - a day whose records are ALL migrated keeps the 2B behaviour (complete: nothing to do; some of this snapshot's: a
//          reported partial day, never repaired here; unrelated migrated records: left alone). A mixed day needs a record
//          from a live or server-dated source.
//      A record with no local day (server-observed, legacy client) belongs to no day and covers nothing.
//   4. A day is written ATOMICALLY: every record of the day in one MongoDB transaction (recordMigratedDay), so a day goes from
//      legacy-only to fully canonical and is never left with some of its records. This is not optional: rule 3 would make a
//      partial day permanent. Transactions need a replica set; on a standalone server an apply writes nothing (the CLI
//      refuses to start). A rerun creates nothing (ids are deterministic and rule 3 sees the day), two runs at once write a
//      day once. A day found with only some of its migrated records (it cannot be produced by this code; it could only come
//      from elsewhere) is REPORTED loudly (`partial-migrated-day`, counted as failed) and never silently completed or skipped.
//   5. Nothing is ever deleted or rewritten, and DayHistory rows are never modified.
// Rows with no tasks create nothing (there is nothing to record; the legacy zero row keeps answering that day).
//
// The deterministic `completionId` is a hash of (userId, date, taskId): the same snapshot entry always maps to the same
// record, which is what makes the migration idempotent and race-safe (the unique (userId, completionId) index decides).

export type LegacyDayRow = {
  userId: unknown;
  date: string;
  completedCount?: unknown;
  workDoneMinutes?: unknown;
  completedTasks?: unknown;
};

export type MigrationOptions = {
  /** false (default): read and report only, write nothing. */
  apply?: boolean;
  /** Also migrate days a legacy client can still write. Only safe after legacy history writes are retired. */
  includeWritableDays?: boolean;
  now?: Date;
};

export type MigrationIssueKind =
  | 'invalid-date'
  | 'invalid-row'
  | 'count-mismatch'
  | 'duplicate-task'
  | 'partial-migrated-day'
  | 'error';

export type MigrationIssue = { userId: string; date: string; kind: MigrationIssueKind; detail: string };

export type MigrationReport = {
  mode: 'dry-run' | 'apply';
  includeWritableDays: boolean;
  /** Dates before this are frozen (no legacy client can still write them); only those are migrated by default. */
  firstWritableDate: string;
  rowsRead: number;
  rowsSkippedWritable: number;
  rowsSkippedInvalid: number;
  /**
   * Days left alone because their records are all migrated and are not this snapshot's (see rule 3), or because a concurrent
   * run wrote the day first. A day with live records is no longer skipped: it is counted in the mixed-day fields below.
   */
  rowsSkippedExistingRecords: number;
  /** Mixed days (records from a live or server-dated source) with at least one legacy task no record covers: repaired (apply) or to repair (dry run). */
  rowsMixedToRepair: number;
  /** Mixed days where every legacy task is already covered by a record (nothing to import; includes a day repaired by an earlier run). */
  rowsMixedAlreadyCovered: number;
  /** Legacy tasks left alone on mixed days because a record of that task already holds the day (canonical wins). */
  recordsCoveredByCanonical: number;
  rowsEmpty: number;
  rowsAlreadyMigrated: number;
  /** Rows that have (dry run) or had (apply) records to create. */
  rowsToMigrate: number;
  recordsPlanned: number;
  recordsCreated: number;
  recordsAlreadyPresent: number;
  /** Rows whose stored count or minutes disagree with their task list (migrated from the list; reported, not guessed). */
  rowsWithCountMismatch: number;
  rowsFailed: number;
  /** The first ISSUE_LIMIT issues; counts above are complete. */
  issues: MigrationIssue[];
  issuesTruncated: boolean;
};

export const ISSUE_LIMIT = 100;

/** Deterministic id of the migrated record for one snapshot entry. Matches COMPLETION_ID_PATTERN (<= 64 chars). */
export const migratedCompletionId = (userId: string, date: string, taskId: string): string =>
  `mig-${createHash('sha256').update(`${userId}\n${date}\n${taskId}`).digest('hex').slice(0, 48)}`;

/**
 * The first date a legacy client could still write for SOME offset. Derived from the same constants the legacy upsert
 * validator uses (7-day retention, offsets down to UTC-12), so the two cannot drift apart: a date strictly before this one
 * is rejected with DATE_OUT_OF_RANGE for every client.
 */
export const firstWritableDate = (now: Date): string => addDays(getToday(MIN_UTC_OFFSET_MINUTES, now), -(HISTORY_RETENTION_DAYS - 1));

const emptyReport = (options: MigrationOptions, now: Date): MigrationReport => ({
  mode: options.apply ? 'apply' : 'dry-run',
  includeWritableDays: options.includeWritableDays === true,
  firstWritableDate: firstWritableDate(now),
  rowsRead: 0,
  rowsSkippedWritable: 0,
  rowsSkippedInvalid: 0,
  rowsSkippedExistingRecords: 0,
  rowsMixedToRepair: 0,
  rowsMixedAlreadyCovered: 0,
  recordsCoveredByCanonical: 0,
  rowsEmpty: 0,
  rowsAlreadyMigrated: 0,
  rowsToMigrate: 0,
  recordsPlanned: 0,
  recordsCreated: 0,
  recordsAlreadyPresent: 0,
  rowsWithCountMismatch: 0,
  rowsFailed: 0,
  issues: [],
  issuesTruncated: false,
});

type Parsed = { ok: true; tasks: CompletedTaskInput[] } | { ok: false; kind: MigrationIssueKind; detail: string };

/** Every task must be representable exactly, by the same rules the legacy write path enforced. */
const parseRow = (row: LegacyDayRow): Parsed => {
  if (!Array.isArray(row.completedTasks)) return { ok: false, kind: 'invalid-row', detail: 'completedTasks is not a list' };
  const tasks: CompletedTaskInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < row.completedTasks.length; i += 1) {
    const parsed = parseCompletedTask(row.completedTasks[i], i);
    if (!parsed.ok) return { ok: false, kind: 'invalid-row', detail: parsed.message };
    if (seen.has(parsed.value.taskId)) return { ok: false, kind: 'duplicate-task', detail: `duplicate taskId at index ${i}` };
    seen.add(parsed.value.taskId);
    tasks.push(parsed.value);
  }
  return { ok: true, tasks };
};

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as Error & { code?: string | number }).code;
  return code === undefined ? error.name : `${error.name}/${code}`; // never the message: it may name hosts or values
};

export async function migrateDayHistory(
  rows: AsyncIterable<LegacyDayRow> | Iterable<LegacyDayRow>,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const now = options.now ?? new Date();
  const report = emptyReport(options, now);
  const apply = options.apply === true;

  const issue = (userId: string, date: string, kind: MigrationIssueKind, detail: string) => {
    if (report.issues.length < ISSUE_LIMIT) report.issues.push({ userId, date, kind, detail });
    else report.issuesTruncated = true;
  };

  for await (const row of rows) {
    report.rowsRead += 1;
    const userId = String(row.userId);
    const date = row.date;
    try {
      if (!isValidCalendarDate(date)) {
        report.rowsSkippedInvalid += 1;
        issue(userId, String(date), 'invalid-date', 'not a calendar date');
        continue;
      }
      if (!report.includeWritableDays && date >= report.firstWritableDate) {
        report.rowsSkippedWritable += 1; // a legacy client can still write this day: migrating it could lose that write
        continue;
      }

      const parsed = parseRow(row);
      if (!parsed.ok) {
        report.rowsSkippedInvalid += 1; // all or nothing: the whole day keeps reading from DayHistory
        issue(userId, date, parsed.kind, parsed.detail);
        continue;
      }
      const { tasks } = parsed;
      if (tasks.length === 0) {
        report.rowsEmpty += 1;
        continue;
      }

      const minutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
      if (row.completedCount !== tasks.length || typeof row.workDoneMinutes !== 'number' || Math.abs(row.workDoneMinutes - minutes) > 1e-6) {
        report.rowsWithCountMismatch += 1;
        issue(userId, date, 'count-mismatch', `stored ${String(row.completedCount)}/${String(row.workDoneMinutes)}, list ${tasks.length}/${minutes}`);
      }

      const existing = (await CompletionRecord.find({ userId, localDate: { $in: [date] } })
        .select('completionId taskId source')
        .lean()) as unknown as { completionId: string; taskId: string; source: string }[];

      if (existing.length > 0) {
        const migratedOnly = existing.every((record) => record.source === 'migrated');

        if (migratedOnly) {
          // 2B behaviour, unchanged: only a day written by this migration (or something that looks like it) lands here.
          const expected = new Set(tasks.map((task) => migratedCompletionId(userId, date, task.taskId)));
          const complete = existing.length === expected.size && existing.every((record) => expected.has(record.completionId));
          if (complete) {
            report.rowsAlreadyMigrated += 1;
            report.recordsAlreadyPresent += expected.size;
          } else if (existing.some((record) => expected.has(record.completionId))) {
            // Some of this snapshot's migrated records, but not all of them: a partial day. Reported, never repaired here.
            report.rowsFailed += 1;
            issue(userId, date, 'partial-migrated-day', `${existing.length} migrated record(s), snapshot has ${expected.size}`);
          } else {
            report.rowsSkippedExistingRecords += 1;
          }
          continue;
        }

        // A MIXED day: repair per task (rule 3). Covered = a record of that task holds this day, in any status.
        const covered = new Set(existing.map((record) => record.taskId));
        const missing = tasks.filter((task) => !covered.has(task.taskId));
        report.recordsCoveredByCanonical += tasks.length - missing.length;
        if (missing.length === 0) {
          report.rowsMixedAlreadyCovered += 1;
          continue;
        }

        report.rowsMixedToRepair += 1;
        report.recordsPlanned += missing.length;
        if (!apply) continue;

        const { created } = await recordMissingMigratedCompletions(
          userId,
          date,
          missing.map((task) => ({
            completionId: migratedCompletionId(userId, date, task.taskId),
            taskId: task.taskId,
            titleSnapshot: task.title,
            estimatedMinutesSnapshot: task.estimatedMinutes,
          })),
          now,
        );
        report.recordsCreated += created;
        // Fewer than planned means the day changed under us (a concurrent run, or a record that now covers a task): the
        // transaction re-read the day and wrote only what was still missing. Nothing to report as an error.
        report.recordsAlreadyPresent += missing.length - created;
        continue;
      }

      report.rowsToMigrate += 1;
      report.recordsPlanned += tasks.length;
      if (!apply) continue;

      const outcome = await recordMigratedDay(
        userId,
        date,
        tasks.map((task) => ({
          completionId: migratedCompletionId(userId, date, task.taskId),
          taskId: task.taskId,
          titleSnapshot: task.title,
          estimatedMinutesSnapshot: task.estimatedMinutes,
        })),
        now,
      );
      if (outcome === 'created') report.recordsCreated += tasks.length;
      else report.rowsSkippedExistingRecords += 1; // a concurrent run (or a record that appeared) got there first
    } catch (error) {
      // One failing row must not stop the run. The day may be partly migrated; the next run finishes it (rule 4).
      report.rowsFailed += 1;
      issue(userId, String(date), 'error', describeError(error));
    }
  }

  return report;
}

/**
 * Whether a MongoDB `hello` reply comes from a deployment that supports multi-document transactions (a replica set member
 * or a mongos). A standalone server does not, and an apply must not run there: it could not write a day atomically.
 */
export const supportsTransactions = (hello: Record<string, unknown> | null | undefined): boolean =>
  Boolean(hello && (typeof hello.setName === 'string' || hello.msg === 'isdbgrid'));
