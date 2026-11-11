/**
 * 7-day task history snapshots.
 *
 * Model
 *   - History for one calendar day is the SET of tasks completed that day, keyed by task id.
 *     count and minutes are always recomputed from that set, never stored independently or
 *     summed across sources, so reconciling the same data any number of times cannot
 *     double-count, and two devices' sets combine by UNION without losing either side's tasks.
 *   - The SERVER is the durable, cross-device source of truth (one row per user per day).
 *     Local IndexedDB is the offline-first cache and the outbox for changes the server has not
 *     acknowledged yet (`pendingSync`).
 *   - Local storage is scoped per authenticated user (`task_history:<userId>`); history of one
 *     account can never be read, merged or pushed for another.
 *
 * Calendar days
 *   - Dates are the user's LOCAL calendar days (YYYY-MM-DD), computed on the client (see
 *     utils/localDate.ts) and supplied explicitly on every request. The server never derives a
 *     user-facing date from its own clock.
 *
 * Reconciliation — the ONLY path that talks to the server (see reconcile()). For each date:
 *   1. local entry is pendingSync → merged = (server tasks − tasks THIS device un-completed)
 *      ∪ (local tasks), by task id. Pushed only if it differs from the server row. A pending
 *      snapshot never replaces the server row wholesale, so another device's tasks survive.
 *   2. else the server has a record → the server wins (recovers a cleared/new device, and picks
 *      up other devices' changes).
 *   3. else local has real data → keep it and push it (heals a server that missed it).
 *   Every push (including one made right after a task change) is preceded by a pull and merge.
 *   `pendingSync` clears only when the server acknowledges the exact revision pushed, so an edit
 *   made while a push was in flight stays pending.
 *
 * Removals: a task disappears from history only when THIS device itself saw it stop being
 * completed (un-checked or deleted): its id goes into `removedTaskIds` until acknowledged.
 * A task this device never knew about (completed on another device) is never treated as removed.
 *
 * Legacy: before user scoping, history lived under one global key (`task_history`) with no
 * owner. Ownership cannot be established, so it is never read or migrated; it is deleted on first
 * use. Anything that had reached the server is recovered from there.
 */

import { offlineDb } from './db';
import { Task } from '../types/task';
import { historyService, type UpsertOutcome } from '../services/historyService';
import { useAuthStore } from '../store/authStore';
import { isValidDateKey, localDateKeyOffset, toLocalDateKey } from '../utils/localDate';

const HISTORY_KEY_PREFIX = 'task_history:';
const LEGACY_HISTORY_KEY = 'task_history'; // unscoped, never read

const MAX_DAYS = 7;

// Mirrors halotasks-server/src/utils/historyValidators.ts so a snapshot the client builds
// is always one the server accepts.
export const MAX_COMPLETED_TASKS_PER_DAY = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_ESTIMATED_MINUTES = 100_000;
const MAX_REMOVED_IDS = 1000;

/** How long getWeekHistory() waits for the server before answering from local data. */
const SERVER_WAIT_MS = 3000;
/** Minimum gap between read-triggered reconcile attempts for the same user. */
const RECONCILE_RETRY_MS = 15_000;

export type HistoryEntry = {
  date: string;             // YYYY-MM-DD (user's local calendar day)
  completedCount: number;
  workDoneMinutes: number;
  completedTasks: { id: string; title: string; estimatedMinutes: number }[];
};

export type WeekHistory = HistoryEntry[]; // 7 entries, oldest → newest

type CompletedTask = HistoryEntry['completedTasks'][number];

/** What is persisted locally: the snapshot plus its outbox state. Not exposed to the UI. */
type StoredHistoryEntry = HistoryEntry & {
  pendingSync?: boolean;
  /** Increments on every local write of this date; lets an ack be matched to the exact snapshot pushed. */
  rev?: number;
  /** Task ids this device last derived from its own task list (used to tell "I un-completed it" from "I never knew it"). */
  ownTaskIds?: string[];
  /** Task ids this device un-completed/deleted since the server last acknowledged; subtracted when merging. */
  removedTaskIds?: string[];
  /**
   * Completions THIS device recorded for a day whose history the server owns canonically (CompletionRecords) that the
   * canonical day does not contain. They are neither shown (the canonical day wins), nor pushed (a legacy PUT for a canonical
   * day is acknowledged but never read), nor dropped: they stay here until the canonical day lists them, or the device
   * un-completes/deletes the task. Internal; never part of HistoryEntry.
   */
  unreconciled?: CompletedTask[];
  /**
   * Own task ids that a CANONICAL answer has listed for this day while they stayed continuously completed on this device
   * (they leave the set the moment the device stops completing the task). Such a completion has been acknowledged by the
   * canonical day: if its record is later revoked (another device un-completed the task) that is the server's decision,
   * not an unsent completion, so it must never be reported as `unreconciled`. A completion the user makes AGAIN after
   * un-completing is a new transition and is not in this set.
   */
  canonicalAckIds?: string[];
  /**
   * A canonical answer has been seen for this day (Issue #47, Phase 2D). A day with CompletionRecords stays canonical (records are
   * revoked, never deleted), so from then on this device never sends a legacy write for it and never lets a non-canonical
   * answer (older server, missing `source`) overwrite it. Internal; never part of HistoryEntry.
   */
  canonicalSeen?: true;
};

// ── Identity ─────────────────────────────────────────────────────────────────

const getCurrentUserId = (): string | null => useAuthStore.getState().user?.id || null;

const keyFor = (userId: string): string => `${HISTORY_KEY_PREFIX}${userId}`;

// ── Pure merge logic ─────────────────────────────────────────────────────────

const toPlainEntry = (e: HistoryEntry): HistoryEntry => ({
  date: e.date,
  completedCount: e.completedCount,
  workDoneMinutes: e.workDoneMinutes,
  completedTasks: e.completedTasks,
});

const snapshotOf = (date: string, tasks: CompletedTask[]): HistoryEntry => {
  const capped = tasks.slice(0, MAX_COMPLETED_TASKS_PER_DAY);
  return {
    date,
    completedCount: capped.length,
    workDoneMinutes: capped.reduce((sum, t) => sum + t.estimatedMinutes, 0),
    completedTasks: capped,
  };
};

/**
 * Merge two views of the same day by task id: (base − removed) ∪ local.
 *  - nothing in `base` or `local` is lost unless its id is in `removedTaskIds`;
 *  - an id present on both sides appears once (local metadata wins), so nothing is double-counted;
 *  - completedCount / workDoneMinutes are recomputed from the merged set;
 *  - deterministic order (base first, then local-only), and idempotent: merging the result
 *    with either input again yields the same set.
 */
export const mergeDaySnapshots = (
  base: HistoryEntry | null,
  local: { entry: HistoryEntry; removedTaskIds?: readonly string[] },
): HistoryEntry => {
  const removed = new Set(local.removedTaskIds ?? []);
  const byId = new Map<string, CompletedTask>();

  for (const t of base?.completedTasks ?? []) {
    if (!removed.has(t.id)) byId.set(t.id, t);
  }
  for (const t of local.entry.completedTasks) {
    if (!removed.has(t.id)) byId.set(t.id, t); // existing key keeps its position; local metadata wins
  }

  return snapshotOf(local.entry.date, [...byId.values()]);
};

/** True when both snapshots hold exactly the same tasks (by id, title and minutes). */
export const sameSnapshot = (a: HistoryEntry, b: HistoryEntry): boolean => {
  if (a.completedTasks.length !== b.completedTasks.length) return false;
  const byId = new Map(b.completedTasks.map((t) => [t.id, t]));
  return a.completedTasks.every((t) => {
    const other = byId.get(t.id);
    return !!other && other.title === t.title && other.estimatedMinutes === t.estimatedMinutes;
  });
};

/**
 * Fold a freshly derived snapshot (from this device's task list) into the previously stored one.
 * For a single device the result equals the derived snapshot (same as before merging existed);
 * tasks merged in from other devices are kept, and only tasks THIS device itself stopped
 * completing are recorded as removals.
 */
export const applyDerivedSnapshot = (
  previous: StoredHistoryEntry | undefined,
  derived: HistoryEntry,
): StoredHistoryEntry => {
  const derivedIds = new Set(derived.completedTasks.map((t) => t.id));

  const removed = new Set(previous?.removedTaskIds ?? []);
  for (const id of previous?.ownTaskIds ?? []) {
    if (!derivedIds.has(id)) removed.add(id);
  }
  for (const id of derivedIds) removed.delete(id);
  const removedTaskIds = [...removed].slice(-MAX_REMOVED_IDS);

  const view = mergeDaySnapshots(previous ? toPlainEntry(previous) : null, {
    entry: derived,
    removedTaskIds,
  });

  const next: StoredHistoryEntry = {
    ...view,
    pendingSync: true,
    rev: (previous?.rev ?? 0) + 1,
    ownTaskIds: [...derivedIds],
  };
  if (removedTaskIds.length > 0) next.removedTaskIds = removedTaskIds;
  // Local edits never discard what is waiting on a canonical day (only the device's own removal does).
  const waiting = (previous?.unreconciled ?? []).filter((t) => !removed.has(t.id));
  if (waiting.length > 0) next.unreconciled = waiting;
  // An acknowledgement belongs to ONE continuous completion: it is kept only while the device keeps the task completed.
  const previousOwn = new Set(previous?.ownTaskIds ?? []);
  const acknowledged = (previous?.canonicalAckIds ?? []).filter((id) => derivedIds.has(id) && previousOwn.has(id));
  if (acknowledged.length > 0) next.canonicalAckIds = acknowledged;
  if (previous?.canonicalSeen) next.canonicalSeen = true;
  return next;
};

// ── Serialised local read-modify-write ───────────────────────────────────────
// Snapshot writes and reconciliation both read-modify-write the same record; serialise
// them so neither loses the other's update. The lock is never held across the network.

let lockChain: Promise<unknown> = Promise.resolve();
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => undefined);
  return run;
};

// ── Local storage ────────────────────────────────────────────────────────────

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;

const completedTaskArray = (value: unknown): CompletedTask[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const tasks: CompletedTask[] = [];
  for (const t of value) {
    if (typeof t !== 'object' || t === null) continue;
    const task = t as Record<string, unknown>;
    if (typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.estimatedMinutes !== 'number' || !Number.isFinite(task.estimatedMinutes)) continue;
    tasks.push({ id: task.id, title: task.title, estimatedMinutes: task.estimatedMinutes });
  }
  return tasks.slice(0, MAX_COMPLETED_TASKS_PER_DAY);
};

const normalizeStored = (value: unknown): StoredHistoryEntry | null => {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (
    !isValidDateKey(e.date) ||
    typeof e.completedCount !== 'number' || !Number.isFinite(e.completedCount) ||
    typeof e.workDoneMinutes !== 'number' || !Number.isFinite(e.workDoneMinutes) ||
    !Array.isArray(e.completedTasks)
  ) {
    return null;
  }

  const entry = value as StoredHistoryEntry;
  const own = stringArray(e.ownTaskIds);
  const removed = stringArray(e.removedTaskIds);
  const waiting = completedTaskArray(e.unreconciled);
  const acknowledged = stringArray(e.canonicalAckIds);
  const { unreconciled: _raw, canonicalAckIds: _rawAck, canonicalSeen: _rawSeen, ...rest } = entry;
  return {
    ...rest,
    ...(_rawSeen === true ? { canonicalSeen: true as const } : {}),
    ...(acknowledged && acknowledged.length > 0 ? { canonicalAckIds: acknowledged.slice(-MAX_COMPLETED_TASKS_PER_DAY) } : {}),
    ...(own ? { ownTaskIds: own } : {}),
    ...(removed ? { removedTaskIds: removed } : {}),
    ...(waiting && waiting.length > 0 ? { unreconciled: waiting } : {}),
  };
};

const readLocal = async (userId: string): Promise<StoredHistoryEntry[]> => {
  const raw = await offlineDb.get<unknown>(keyFor(userId));
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeStored).filter((e): e is StoredHistoryEntry => e !== null);
};

/** Keeps only the 7-day window ending today, oldest → newest. */
const writeLocal = async (userId: string, entries: StoredHistoryEntry[]): Promise<void> => {
  const oldest = localDateKeyOffset(-(MAX_DAYS - 1));
  const kept = entries
    .filter((e) => e.date >= oldest)
    .sort((a, b) => a.date.localeCompare(b.date));
  await offlineDb.set(keyFor(userId), kept);
};

let legacyPurged = false;
const purgeLegacyHistoryOnce = async (): Promise<void> => {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    await offlineDb.remove(LEGACY_HISTORY_KEY);
  } catch (err) {
    legacyPurged = false;
    console.warn('[history] Could not remove legacy unscoped history:', err);
  }
};

// ── Snapshot building ────────────────────────────────────────────────────────

const wasCompletedOn = (task: Task, dateKey: string): boolean => {
  if (!task.completed) return false;
  const ts = task.completedAt ?? task.updatedAt;
  if (!ts) return false;
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return false;
  return toLocalDateKey(when) === dateKey;
};

const sanitizeMinutes = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_ESTIMATED_MINUTES)
    : 0;

const sanitizeTitle = (value: unknown): string => {
  const title = typeof value === 'string' ? value.trim().slice(0, MAX_TITLE_LENGTH) : '';
  return title.length > 0 ? title : '(untitled)';
};

const buildEntry = (tasks: Task[], dateKey: string): HistoryEntry => {
  const seen = new Set<string>();
  const completedTasks: CompletedTask[] = [];
  for (const t of tasks) {
    if (!wasCompletedOn(t, dateKey) || seen.has(t._id)) continue;
    seen.add(t._id);
    completedTasks.push({ id: t._id, title: sanitizeTitle(t.title), estimatedMinutes: sanitizeMinutes(t.estimatedMinutes) });
  }
  return snapshotOf(dateKey, completedTasks);
};

// ── Pushing to the server ────────────────────────────────────────────────────

/** Clears pendingSync (and removals) for `date` only if the stored revision is still the one that was pushed. */
const markResolved = async (userId: string, date: string, rev: number | undefined): Promise<void> => {
  await withLock(async () => {
    const all = await readLocal(userId);
    const current = all.find((e) => e.date === date);
    if (!current || (current.rev ?? 0) !== (rev ?? 0)) return; // edited again meanwhile: stays pending
    await writeLocal(
      userId,
      all.map((e) => {
        if (e.date !== date) return e;
        const { removedTaskIds: _dropped, ...rest } = e;
        return { ...rest, pendingSync: false };
      }),
    );
  });
};

const pushEntry = async (userId: string, entry: StoredHistoryEntry): Promise<void> => {
  // Requests carry whatever token is current, so never send user A's snapshot after a switch to B.
  if (getCurrentUserId() !== userId) return;

  // Phase 2D: a day the server owns canonically is never written through the legacy path. The entry was chosen for pushing
  // before this call, so re-check the stored copy: a reconcile may have resolved the day canonically in the meantime.
  const stored = (await readLocal(userId)).find((e) => e.date === entry.date);
  if (stored?.canonicalSeen) return;

  const plain = toPlainEntry(entry);
  const outcome: UpsertOutcome =
    entry.date === toLocalDateKey(new Date())
      ? await historyService.upsertToday(plain)      // PUT /api/history/today
      : await historyService.upsertForDate(plain);   // PUT /api/history/:date  (bounded backfill)

  if (outcome === 'retry') return; // stays pending; retried by a later reconcile
  if (outcome === 'rejected') {
    console.warn('[history] Server rejected snapshot for', entry.date, '- will not retry the same payload');
  }
  try {
    await markResolved(userId, entry.date, entry.rev);
  } catch (err) {
    console.warn('[history] Failed to record sync result:', err);
  }
};

// ── Reconciliation ───────────────────────────────────────────────────────────

/** Returns true when the server was reachable and local/server state were reconciled. */
const reconcile = async (userId: string): Promise<boolean> => {
  const todayKey = toLocalDateKey(new Date());
  const server = await historyService.getHistory(MAX_DAYS, todayKey);
  if (!server) return false;
  if (getCurrentUserId() !== userId) return false; // account changed while waiting

  const toPush: StoredHistoryEntry[] = [];

  await withLock(async () => {
    const byDate = new Map((await readLocal(userId)).map((e) => [e.date, e]));

    for (const { entry: serverEntry, exists, source } of server) {
      const date = serverEntry.date;
      const local = byDate.get(date);

      if (source !== 'canonical' && local?.canonicalSeen) {
        // A day that was canonical stays canonical (records are revoked, never deleted). A non-canonical answer for it (an
        // older server, a missing `source`) is not authoritative: keep the canonical view, push nothing, and stop retrying.
        byDate.set(date, { ...local, pendingSync: false });
      } else if (source === 'canonical') {
        // 0. The server's completion records own this day: the canonical answer wins, whatever the local copy says
        //    (acknowledged or pending, even when the canonical day is empty because every completion was revoked).
        //    Nothing is merged back from the local copy, removals are not applied to it (deleting a task does not erase
        //    history), and nothing is pushed: a legacy PUT for this day would be acknowledged and then ignored. What THIS
        //    device recorded and the canonical day lacks is kept aside, not dropped.
        const canonicalIds = new Set(serverEntry.completedTasks.map((t) => t.id));
        const own = new Set(local?.ownTaskIds ?? []);
        const removed = new Set(local?.removedTaskIds ?? []);
        const acknowledged = new Set(local?.canonicalAckIds ?? []);
        const candidates = new Map<string, CompletedTask>();
        for (const t of local?.unreconciled ?? []) candidates.set(t.id, t);
        for (const t of local?.completedTasks ?? []) if (own.has(t.id)) candidates.set(t.id, t);
        // "Waiting" means: recorded here and NEVER listed by the canonical day since it was completed. One that the canonical
        // day did list and later lost was acknowledged and then revoked by the server: not an unsent completion.
        const unreconciled = [...candidates.values()]
          .filter((t) => !canonicalIds.has(t.id) && !removed.has(t.id) && !acknowledged.has(t.id))
          .slice(0, MAX_COMPLETED_TASKS_PER_DAY);
        const nowAcknowledged = [...new Set([...acknowledged, ...[...canonicalIds].filter((id) => own.has(id))])].slice(-MAX_COMPLETED_TASKS_PER_DAY);

        byDate.set(date, {
          ...serverEntry,
          pendingSync: false,
          rev: local?.rev ?? 0,
          ownTaskIds: local?.ownTaskIds ?? [],
          canonicalSeen: true,
          ...(unreconciled.length > 0 ? { unreconciled } : {}),
          ...(nowAcknowledged.length > 0 ? { canonicalAckIds: nowAcknowledged } : {}),
        });
      } else if (local?.pendingSync) {
        // 1. Unacknowledged local changes: merge by task id, never replace the server row.
        const base = exists ? serverEntry : null;
        const merged = mergeDaySnapshots(base, { entry: toPlainEntry(local), removedTaskIds: local.removedTaskIds });
        const nothingToSend = base ? sameSnapshot(merged, base) : merged.completedCount === 0;

        const { removedTaskIds: _r, ...localRest } = local;
        if (nothingToSend) {
          byDate.set(date, { ...localRest, ...merged, pendingSync: false });
        } else {
          const updated: StoredHistoryEntry = {
            ...localRest,
            ...merged,
            pendingSync: true,
            rev: (local.rev ?? 0) + 1,
            ...(local.removedTaskIds?.length ? { removedTaskIds: local.removedTaskIds } : {}),
          };
          byDate.set(date, updated);
          toPush.push(updated);
        }
      } else if (exists) {
        // 2. Acknowledged local copy (or none): the server wins.
        byDate.set(date, {
          ...serverEntry,
          pendingSync: false,
          rev: local?.rev ?? 0,
          ownTaskIds: local?.ownTaskIds ?? [],
        });
      } else if (local && local.completedCount > 0) {
        // 3. Server has nothing for a day this device recorded: heal it.
        const healed = { ...local, pendingSync: true };
        byDate.set(date, healed);
        toPush.push(healed);
      }
    }

    await writeLocal(userId, [...byDate.values()]);
  });

  for (const entry of toPush) {
    await pushEntry(userId, entry);
  }
  return true;
};

type ReconcileState = {
  userId: string;
  inFlight: Promise<boolean> | null;
  /** A change arrived while a reconcile was running: run once more when it finishes. */
  rerun: boolean;
  succeeded: boolean;
  lastAttemptAt: number;
};
let reconcileState: ReconcileState | null = null;

const stateFor = (userId: string): ReconcileState => {
  if (!reconcileState || reconcileState.userId !== userId) {
    reconcileState = { userId, inFlight: null, rerun: false, succeeded: false, lastAttemptAt: 0 };
  }
  return reconcileState;
};

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

const startReconcile = (userId: string): Promise<boolean> => {
  const state = stateFor(userId);
  if (state.inFlight) return state.inFlight;

  state.lastAttemptAt = Date.now();
  state.inFlight = reconcile(userId)
    .then((ok) => {
      if (ok) state.succeeded = true;
      return ok;
    })
    .catch((err) => {
      console.warn('[history] Reconcile failed:', err);
      return false;
    })
    .finally(() => {
      state.inFlight = null;
      if (state.rerun) {
        state.rerun = false;
        if (reconcileState === state && getCurrentUserId() === userId) void startReconcile(userId);
      }
    });
  return state.inFlight;
};

/** Called after every local change: pull → merge → push, coalescing bursts of edits. */
const requestSync = (userId: string): Promise<boolean> => {
  if (isOffline()) return Promise.resolve(false);
  const state = stateFor(userId);
  if (state.inFlight) {
    state.rerun = true;
    return state.inFlight;
  }
  return startReconcile(userId);
};

/** Pull on the first read of a session; afterwards only to retry changes the server hasn't acknowledged. */
const shouldReconcile = (userId: string, local: StoredHistoryEntry[]): boolean => {
  if (isOffline()) return false;
  const state = stateFor(userId);
  if (state.inFlight) return true;
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < RECONCILE_RETRY_MS) return false;
  return !state.succeeded || local.some((e) => e.pendingSync);
};

const waitAtMost = async <T>(promise: Promise<T>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * updateTodaySnapshot — call whenever the task list changes.
 * Folds today's tasks into the stored snapshot (marked pending) and syncs in the background
 * (pull → merge by task id → push). A failed sync stays pending and is retried.
 */
export const updateTodaySnapshot = async (tasks: Task[]): Promise<void> => {
  try {
    const userId = getCurrentUserId();
    if (!userId) {
      console.warn('[history] No authenticated user; snapshot not recorded');
      return;
    }

    const todayKey = toLocalDateKey(new Date());
    const derived = buildEntry(tasks, todayKey);

    // Take the lock synchronously (before any await) so snapshots are applied in the exact order
    // they were requested: an older task list must never overwrite a newer one. The one-time legacy
    // purge therefore runs INSIDE the lock rather than before it.
    await withLock(async () => {
      await purgeLegacyHistoryOnce();
      const all = await readLocal(userId);
      const previous = all.find((e) => e.date === todayKey);
      const next = applyDerivedSnapshot(previous, derived);
      await writeLocal(userId, [...all.filter((e) => e.date !== todayKey), next]);
    });

    // Fire-and-forget; reconcile never throws and leaves the entry pending on failure.
    void requestSync(userId);
  } catch (err) {
    console.warn('[history] Failed to update snapshot:', err);
  }
};

/**
 * Asks for a pull → merge → push of the history, now (Issue #47, Phase 2E: after completion events were delivered, so the
 * canonical answer for their day is read). It changes no local state itself; nothing is marked acknowledged here.
 */
export const requestHistoryReconcile = async (): Promise<void> => {
  const userId = getCurrentUserId();
  if (!userId) return;
  await requestSync(userId);
};

/**
 * getWeekHistory — returns exactly 7 entries (oldest first) for the current user.
 * Days with no data get empty placeholders so the UI always shows a full week.
 * On the first read of a session it reconciles with the server (waiting at most a few
 * seconds) so a cleared/new device recovers; offline it answers from local data only.
 * Returns [] when there is no authenticated user.
 */
export const getWeekHistory = async (): Promise<WeekHistory> => {
  try {
    const userId = getCurrentUserId();
    if (!userId) return [];

    await purgeLegacyHistoryOnce();

    const before = await readLocal(userId);
    if (shouldReconcile(userId, before)) {
      await waitAtMost(startReconcile(userId), SERVER_WAIT_MS);
    }

    if (getCurrentUserId() !== userId) return [];

    const byDate = new Map((await readLocal(userId)).map((e) => [e.date, e]));
    const result: HistoryEntry[] = [];
    for (let i = MAX_DAYS - 1; i >= 0; i--) {
      const key = localDateKeyOffset(-i);
      const found = byDate.get(key);
      result.push(
        found
          ? toPlainEntry(found)
          : { date: key, completedCount: 0, workDoneMinutes: 0, completedTasks: [] },
      );
    }
    return result;
  } catch (err) {
    console.warn('[history] Failed to read history:', err);
    return [];
  }
};

/**
 * getUnreconciledCompletions — what this device recorded for days the server owns canonically but the canonical day does
 * not list (oldest first). Nothing in the UI shows it yet; it exists so that this state is observable and testable instead
 * of silently discarded, and for the read switch to decide what to do with it.
 */
export const getUnreconciledCompletions = async (): Promise<{ date: string; tasks: CompletedTask[] }[]> => {
  try {
    const userId = getCurrentUserId();
    if (!userId) return [];
    return (await readLocal(userId))
      .filter((e) => (e.unreconciled?.length ?? 0) > 0)
      .map((e) => ({ date: e.date, tasks: e.unreconciled as CompletedTask[] }));
  } catch (err) {
    console.warn('[history] Failed to read unreconciled completions:', err);
    return [];
  }
};

/** resetHistoryState — for testing only. */
export const resetHistoryState = (): void => {
  legacyPurged = false;
  reconcileState = null;
  lockChain = Promise.resolve();
};
