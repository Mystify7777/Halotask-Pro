import CompletionRecord from '../models/CompletionRecord.model';

// -- Historical completion reads from CompletionRecord (Issue #47, Phase 2A) --
//
// CompletionRecord is the canonical source of "which completions happened, and on which local day". This module turns the
// records of a set of local days into the per-day shape the legacy history endpoint has always returned, so existing
// consumers keep working. It only READS: nothing here writes a record, a task or a snapshot, and it knows nothing about
// the completion transition rules (utils/taskCompletion.ts).
//
// What counts, per day (`localDate` is derived from completedAt + utcOffsetMinutes when the record is written):
//   - a record is part of a day's history when its `localDate` is that day; the day then has CANONICAL data, even when every
//     record of it is revoked (the user completed and then uncompleted: the authoritative answer is "nothing", and a stale
//     legacy snapshot must not bring it back);
//   - only ACTIVE records are counted; a revoked record stays stored (audit) but is not a completion any more;
//   - a record with no `localDate` (a server-observed one written for a legacy client: its day is unknown) belongs to no day
//     here. Such a client keeps writing DayHistory, which is what the fallback serves for those days.
// A completed -> uncompleted -> completed task is two records on the day(s) they were made, one of them active: history shows
// the one completion that stands, never the revoked one, and never "one task completed twice".

export type HistoryDay = {
  date: string;
  completedCount: number;
  workDoneMinutes: number;
  completedTasks: { taskId: string; title: string; estimatedMinutes: number }[];
  /**
   * Canonical days: the latest SERVER receipt/revocation timestamp (`receivedAt` / `revokeReceivedAt`) of any record of the day.
   * It is NOT the completion time (use `completedAt`-derived order for that), not a "last activity" time, and must not be used
   * for sorting or display. Its one contract is existence: a canonical day, even an all-revoked zero one, is never null, so
   * clients can tell "a record exists" from "no record" (legacy and empty days keep their own `updatedAt` / null).
   */
  updatedAt: Date;
};

type StoredRecord = {
  completionId: string;
  taskId: string;
  titleSnapshot: string;
  estimatedMinutesSnapshot: number;
  completedAt: Date | null;
  receivedAt: Date;
  status: 'active' | 'revoked';
  revokeReceivedAt?: Date | null;
  localDate: string | null;
};

const time = (value: Date | null | undefined): number => (value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY);

/** Oldest completion first; a migrated record (no instant) after the dated ones; completionId breaks ties, so the order is stable. */
const byCompletion = (a: StoredRecord, b: StoredRecord): number => {
  const ta = a.completedAt ? time(a.completedAt) : Number.POSITIVE_INFINITY;
  const tb = b.completedAt ? time(b.completedAt) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.completionId < b.completionId ? -1 : a.completionId > b.completionId ? 1 : 0;
};

/** The days of `dates` that have canonical data, keyed by local date. Days without any record are absent from the map. */
export async function readCompletionDays(userId: string, dates: string[]): Promise<Map<string, HistoryDay>> {
  const rows = (await CompletionRecord.find({ userId, localDate: { $in: dates } })
    .select('completionId taskId titleSnapshot estimatedMinutesSnapshot completedAt receivedAt status revokeReceivedAt localDate')
    .lean()) as unknown as StoredRecord[];

  const perDay = new Map<string, StoredRecord[]>();
  for (const row of rows) {
    if (!row.localDate) continue; // unknown day: not part of any day's canonical history
    const list = perDay.get(row.localDate) ?? [];
    list.push(row);
    perDay.set(row.localDate, list);
  }

  const days = new Map<string, HistoryDay>();
  for (const [date, records] of perDay) {
    const active = records.filter((r) => r.status === 'active').sort(byCompletion);
    const touched = Math.max(...records.map((r) => Math.max(time(r.receivedAt), time(r.revokeReceivedAt))));
    days.set(date, {
      date,
      completedCount: active.length,
      workDoneMinutes: active.reduce((sum, r) => sum + r.estimatedMinutesSnapshot, 0),
      completedTasks: active.map((r) => ({ taskId: r.taskId, title: r.titleSnapshot, estimatedMinutes: r.estimatedMinutesSnapshot })),
      updatedAt: new Date(touched),
    });
  }
  return days;
}
