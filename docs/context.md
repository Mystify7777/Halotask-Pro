# HaloTaskPro Project Context

This document is the long-lived working context for HaloTaskPro. It is meant to help an AI agent quickly recover the project shape, the important implementation details, the current priorities, and the constraints that matter when making future changes.

## Project Summary

HaloTaskPro is a productivity app with:
- A React + TypeScript + Vite frontend
- A Node.js + Express + TypeScript backend
- MongoDB persistence
- Offline-first behavior with IndexedDB caching and a sync queue
- Auth, password recovery, reminders, and a Growth Tree progression system

The product is designed to help users capture tasks, prioritize them, work offline, recover from sync interruptions, and stay motivated with visible progress feedback.

## Workspace Layout

Primary workspace folder:
- `d:\Desktop\College\PROJECT\HaloTaskPro`

Important directories:
- `halotasks-client/` - main frontend client
- `docs/` - project documentation, logs, and upgrade plans
- `server/` - backend implementation
- `assistance/` - reference snapshots used during staged feature work
- `assets/` - shared asset content

## Current Frontend Architecture

The main client is in `halotasks-client/`.

Key frontend structure:
- `src/App.tsx` - router and theme context provider
- `src/components/` - shell, protection, dashboard UI, and shared controls
- `src/pages/` - top-level pages such as dashboard, auth, and settings
- `src/hooks/` - task, sync, growth, filter, selection, and auth hooks
- `src/offline/` - IndexedDB cache, queue, network, and processor logic
- `src/store/` - Zustand auth store
- `src/growth/` - tree state, storage, and logic
- `src/reminders/` - reminder permissions, scheduler, and notification logic
- `src/styles/` - global app CSS and tokens

## Routing and Shell

Current protected dashboard routes:
- `/dashboard`
- `/dashboard/insights`
- `/dashboard/reminders`
- `/dashboard/settings`

These routes are wrapped in the same pattern:
- `ProtectedRoute`
- `AppLayout`
- page component

This means unauthenticated users are redirected consistently instead of reaching a broken page.

## Theme System

The app uses an adaptive theme system with four themes:
- sunrise
- midday
- sunset
- night

Theme logic lives in `src/theme.ts`.

Important behaviors:
- Theme is applied to the document via `data-theme`
- Theme choice is persisted in localStorage
- Adaptive mode can be turned on or off
- Manual theme overrides are supported
- The Settings page exposes controls for both adaptive mode and override selection

The adaptive theme store tracks:
- `theme`
- `isOverridden`
- `isAdaptive`
- `setThemeOverride()`
- `setAdaptive()`
- `themes`

## Settings Page Behavior

The Settings page is now a real settings surface, not a stub.

Appearance section:
- Adaptive theme toggle is a custom CSS switch using a hidden checkbox and styled track/thumb
- Toggling adaptive mode updates localStorage and restarts auto-theme behavior
- Manual override banner appears only when an override is active
- Reset to auto clears the override and returns control to adaptive logic
- Theme cards show all four themes with dynamic accent dots
- Clicking the active manual override clears it
- Clicking another theme sets that theme as the override
- Status text at the bottom always explains the active mode

Time zone section (Issue #41, `components/settings/TimeZoneSetting.tsx`):
- A labelled `<select>` ("Time zone for task times") whose options come from the runtime's own zone data (`Intl.supportedValuesOf`), grouped by region, plus a first option "Use this device (<zone>)" that saves no choice. A saved or device zone the runtime does not list (for example `UTC`, or an alias) is still offered so the control can always show it
- Shows the effective zone and where it comes from ("your saved preference" or "this device, not saved"); an unsaved selection is marked "Unsaved change: not applied until you save." and changes nothing until saved
- Loads the server's value on mount (so a change made on another device is picked up), with a loading state; if the server cannot be reached it says so and keeps the last known value
- Save is a normal button; saving disables the control, shows "Saving…", and only a server-confirmed value is applied. A failed save shows an alert, keeps the previous saved value and keeps the user's selection so they can retry. A save that finishes after the user signed out is ignored
- Preference changes need a connection: they are not queued for the offline sync

Account section:
- Displays user name and email from the auth store
- Includes a Change password button that navigates to `/forgot-password`

## Dashboard and Growth Tree UX

The dashboard includes:
- task list and filters
- bulk actions
- smart sections
- create/edit task forms
- a floating orb tied to the Growth Tree
- a growth sheet on mobile
- a desktop tooltip fallback for the orb

Important orb behavior:
- The orb tap handler only opens the Growth Tree sheet on mobile
- Desktop tap behavior falls back to tooltip interaction to avoid scroll-lock issues
- Orb data is derived from tree state so the display reflects live XP/progress/stage data

### Growth Tree storage contract (user-scoped, Issue #30)

Client Growth Tree persistence (`growth/treeStorage.ts`) is strictly per-user:

- Identity: `useAuthStore.getState().user.id`. It comes from the same login response as the token the API client sends, so the server updates the same user the client keys locally.
- IndexedDB key: `growth_tree:<userId>` (via `offlineDb`; no new store or DB version).
- In-memory cache records its owner. `getTreeState()` never returns another user's cache (returns initial state instead); `applyServerGrowth()` throws `TreeIdentityError` unless `initTreeStorage()` has completed for the current user.
- `initTreeStorage()` throws `TreeIdentityError` when no user is authenticated, and discards its result (no cache write, no IndexedDB write) if the authenticated user changes while it is awaiting local or server state. Callers must handle the rejection (`useDashboardGrowth` and `InsightsPage` both do: log and show no tree).
- Since Issue #24 there is NO merge: the server tree is adopted as is, and the stored copy is only an offline display fallback (see "Growth Tree integrity model" below). The old "higher XP wins" merge and every client push to `/api/tree` were removed.
- `clearAuth()` deliberately does not clear Growth Tree state. Owner-scoped keys and cache already prevent cross-user reads. Consequence: a user's tree record remains in that browser's IndexedDB until they log in again or `clearTreeState()` is called.

Legacy unscoped data decision: the old global IndexedDB key `growth_tree` and localStorage key `halotask:growth_tree` recorded no owner, so they are never read or migrated to whichever user logs in next. `initTreeStorage()` deletes both. The server tree is the recovery path for the real owner; progress that was never successfully synchronized under the old code is lost.

### Growth Tree integrity model (server-authoritative, Issue #24)

XP and the awarded-task ledger are created **only by the server**. The client cannot write reward state.

| Field | Authority |
| --- | --- |
| `xp`, `awardedTaskIds` | Server only. Changed solely by `utils/treeAward.ts` when a task is completed; append-only ledger. |
| `activeDays` | Server only. The retained award-day history (UTC days, one per day; Issue #16 AC8). **Canonical** for the streak and last-active date; written only by the atomic award (and the one-time adoption below). |
| `streakDays`, `lastActiveDate` | A materialised copy of the fold of `activeDays` (`utils/treeRules.ts`, the existing UTC rule). Written by the award's step 2; may be validated and repaired from the history at any time. |
| `leaves`, `stage`, `health` | Derived: leaves = floor(xp / 20), stage thresholds 0/20/60/120/250, health from streak + date. Stored values are only a cache; every read recomputes them. |
| `lastCalculatedAt` | Server-stamped. |

**Award triggers.** `PUT /api/tasks/:id` on an incomplete -> complete transition, and `POST /api/tasks` when the task is created already `completed:true` (an offline create-then-complete arrives this way). Both return an additive `growth` block: `{ taskId, awarded, xpGained, reason?, treeState }` (`treeState` = the tree without the ledger). No other request changes XP. `XP_PER_COMPLETION = 10`; there is deliberately no daily cap, rate limiter or anti-cheat layer.

**Atomic award** (`awardTaskCompletion`). Step 1 is one conditional update on the user document:

```
filter  { _id, 'treeState.awardedTaskIds': { $ne: taskId },
          'treeState.awardedTaskIds.19999': { $exists: false },      // ledger not full
          'treeState.xp': { $gte: 0, $lte: MAX_SAFE_INTEGER - 10 }, // xp is a usable number
          'treeState.activeDays': { $type: 'array' },                // history adopted ...
          $or: [ { 'treeState.activeDays': <today> },                // ... and today already in it,
                 { 'treeState.activeDays.19999': { $exists: false } } ] } // or room for it
update  { $inc: { 'treeState.xp': 10 },
          $push: { 'treeState.awardedTaskIds': taskId },
          $addToSet: { 'treeState.activeDays': <award UTC day> } }   // retained history (below)
```

A single-document update is atomic, so of any number of concurrent requests for one task exactly one matches; different tasks each `$inc` atomically and none is lost. XP, the ledger entry and the award day change together or not at all. Only simple operators are used (no pipeline), so no MongoDB/Atlas version feature is required. Step 2 writes streak/date/derived values with a compare-and-set pinned to the xp, streakDays and lastActiveDate it observed. `activeDays` is deliberately not part of the pin: days are only ever added together with an xp `$inc`, so the pin on xp already fails if a day was added after the read. On a lost race it re-reads and recomputes (up to 5 attempts); the result is the same for everyone because it is a pure function of the history.

**Retained award-day history (`treeState.activeDays`, Issue #16 AC8).** Server-internal: never returned by any endpoint and not client-writable. It is the SET of UTC days (`YYYY-MM-DD`, one entry per distinct day) on which at least one award was recorded, added with `$addToSet` in the same atomic update as the XP and the ledger entry, so "an award happened on this day" cannot be separated from the award itself. It carries no XP. It is the canonical source of the streak: `replayAwardDays(0, null, activeDays)` is THE recalculation, and the stored `streakDays`/`lastActiveDate` are a materialised copy of it. A copy that differs from the fold (`needsReconcile`) means "an award is recorded whose copy never landed" (or the copy was damaged); it is visible in the data itself, not only in a request that may have died. Example: derived writes fail on Monday and Tuesday and succeed on Wednesday: both days are in the history, so a streak of 0 becomes 2 (last active Tuesday) on a reconciling retry, or 3 (last active Wednesday) when Wednesday's own award is the one that reconciles; a skipped day still resets the streak to 1. XP and task-award de-duplication keep their own authority (the atomic award and the ledger); the history never changes either.

**Bound and cap policy.** At most `ACTIVE_DAYS_MAX = 20,000` days (one per calendar day: about 55 years, roughly 220 KB). The history is never truncated. A NEW day that would not fit is refused with `reason:'history_full'` (nothing changes), exactly like a full ledger; an award on a day the history already holds is still accepted. This is what keeps a strict reconstruction honest: the history either holds every recorded day or the award is refused, it never silently forgets one.

**Adoption (legacy trees and the old recovery marker).** A tree stored before this change has no `activeDays` (the field has no default, so absent means "not adopted"). Before its first award, or when a retry finds a stale legacy marker, the award adopts the history in ONE write pinned to the xp, streakDays and lastActiveDate it read: `activeDays` becomes the days IMPLIED by the stored fold plus every valid day left in the old `pendingDerivedDays` marker, and the marker is removed in the same write. What is inferred is only what the stored fold defensibly expresses: a streak of N ending on D is N consecutive days ending on D; D one day ahead of today (clock skew) counts as today, as `nextStreak` does; **a streak of 0 or less, a missing or invalid last-active date, or a last-active date two or more days ahead of today implies NO days** (no streak is fabricated; the award then starts a streak of 1 on its own day). The COMPLETE set (implied days, marker days, and the day being awarded) is validated before anything is written: it is never clamped, and if it would exceed `ACTIVE_DAYS_MAX` (including a stored streak larger than the cap) the award is refused with `history_full` and the legacy record is left untouched. **Activity before the first recorded day is not recoverable and is not claimed to be.** Until a legacy tree adopts, reads fall back to its stored fold plus any marker day, in memory. A forged legacy streak that fits under the cap cannot be told from a real one.

**Stored-history integrity.** Before any write, and again whenever an award misses, the stored `activeDays` is validated (`validateActiveDays`): it must be absent (legacy) or an array of at most `ACTIVE_DAYS_MAX` distinct, valid `YYYY-MM-DD` strings. Anything else (not an array, over the cap, an invalid date or non-string entry, a duplicate) is malformed: the canonical history is NEVER rewritten, the award ends in `TreeAwardError('conflict')` (HTTP 500) and nothing changes, including an already-awarded retry. The check costs one lean read of `treeState.activeDays` per award.

**Failure and retry semantics**
- PUT, award not recorded (step 1 failed): 500, the task is untouched; a retry sees the same transition and awards once.
- PUT, award recorded but step 2 not persisted (database error or 5 lost compare-and-sets): the call throws `derived_unpersisted` and the request is a 500 with the task untouched. It never reports an unpersisted projection as the tree. XP, ledger and the recorded award day are durable. The retry finds the id in the ledger (no second award), sees that the stored copy no longer matches the history, rewrites it from the recorded award days, completes the task, and answers `growth: { awarded:false, reason:'already_awarded', treeState: <persisted> }`.
- PUT, award succeeds but the task write fails: 500; the retry completes the task and awards nothing more.
- POST, award not recorded: the just-created task is deleted again and the request fails (500), so a retry creates and awards once. If that cleanup also fails it is logged and the request still fails; a completed task without an award then remains (accepted, rare, visible in the log).
- POST, award recorded but step 2 not persisted: the task and its XP are KEPT (deleting the task would orphan the XP and a retry would create a second task and award again). The 201 carries `growth` read back from storage (`awarded:true`, streak not yet advanced; never projected), or no `growth` if even that read fails. The next award folds the whole history (the earlier day and today), so no streak day is lost, even when several days in a row are unreconciled.
- Retries, duplicates, concurrent requests and uncomplete -> re-complete never award twice (the ledger is keyed by task id, not by task state). An already-awarded retry whose stored copy already matches the history writes nothing, so re-completing an old task can never keep a streak alive.
- A task is looked up with `{_id, userId}` before awarding, so only the caller's own tasks can be awarded. Deleting a task never removes awarded XP.

**Bounds.** The ledger holds at most `AWARDED_TASK_IDS_MAX = 20,000` ids of at most 64 characters each. A full ledger refuses further awards (`reason:'ledger_full'`); it is never truncated. The award-day history is bounded and refused the same way (`reason:'history_full'`, see above). XP is capped at `Number.MAX_SAFE_INTEGER - 10` (`reason:'xp_ceiling'`).

**Legacy data and repairs: what is persisted and what is response-only.** Existing XP is preserved as the baseline and is never clamped against ledger length (XP can legitimately belong to since-deleted tasks). Stored values that are structurally impossible are handled as follows (`normalizeTreeState` is the single definition of "repaired"):

| Where | What happens | Written to the database? |
| --- | --- | --- |
| `GET /api/tree`, `PATCH /api/tree` `{}` | Response is normalised: non-finite, negative, non-number xp/streak become 0; fractions floored; unsafe integers capped at `MAX_SAFE_INTEGER`; junk `lastActiveDate` becomes null; leaves/stage/health recomputed; implausible ledger entries left out of the response. | **No.** Reads never write (no race, no write amplification). The recompute is deterministic, so it needs no persistence to stay correct. Stored `leaves`/`stage`/`health` may therefore be stale in the database; nothing reads them. |
| Award step 1, usable-xp guard fails (xp missing, Infinity, NaN, negative, string) | xp is set to the repaired value, then the award is retried. | **Yes**, as one update pinned to the exact stored xp it saw, so a concurrent change is never overwritten. Valid xp is never reduced. |
| Award step 2 (and reconcile) | streakDays, lastActiveDate, health, leaves, stage, lastCalculatedAt are written from the normalised state; a fractional xp is floored in the same write; the copy is rewritten from the fold of `activeDays`. | **Yes**, one compare-and-set pinned to xp, streakDays and lastActiveDate. |
| Award step 1, history not adopted yet (no `activeDays` array) | `activeDays` is set from the implied streak days and any legacy marker days; the marker is removed; then the award is retried. | **Yes**, as one update pinned to the xp, streakDays and lastActiveDate it saw. |
| Awarded-task ledger | Never rewritten, filtered or truncated in storage: only appended to. Implausible entries stay stored (they only occupy ledger space, which counts toward the 20,000 bound). | **No** (append only). |

So a damaged tree is shown repaired immediately and is repaired in storage the first time its owner earns an award.

**`PATCH /api/tree`** no longer changes anything. A body containing any of `xp, leaves, streakDays, lastActiveDate, health, stage, lastCalculatedAt, awardedTaskIds` is refused with `400 { code: 'TREE_FIELD_NOT_WRITABLE', fields }`; a non-object body keeps its 400; `{}` is a no-op returning the server tree. `GET /api/tree` keeps its response shape and returns the normalised tree.

**Client behaviour.** `initTreeStorage()` adopts the server tree (the stored IndexedDB copy is used only if the server is unreachable, and is never pushed). `applyServerGrowth(growth)` adopts the tree from a task response and ignores a response with lower XP than the cache (bulk requests can finish out of order). Online completions show the server's `growth`; offline completions show a +10 **preview in React state only** (never stored or sent), which the server's answer replaces after the queued request is replayed (`processSyncQueue({ onGrowth })`). Local `local-...` ids are never awarded locally, so they cannot double-count. `treeService` has no write method. `growth/treeLogic.ts` is now display/preview logic; its constants are pinned against the server copy by `growth/treeRules.parity.test.ts`.

**Known limitations.** An offline preview is not persisted: reloading while offline shows the last server-confirmed tree until the queue syncs. `GET /api/tree` still returns the whole ledger (up to roughly 0.5 MB at the cap). Streak/health reset rules are defined in "Growth Tree reset and recovery rules (Issue #16)" below.

### Growth Tree reset and recovery rules (Issue #16)

**One authority.** `halotasks-server/src/utils/treeRules.ts` (`deriveTreeStatus`, `nextStreak`, `replayAwardDays`, `effectiveFold`, `needsReconcile`, `presentTreeState`) defines every rule below. The client keeps a non-authoritative copy in `growth/treeLogic.ts` only to label the cached tree and preview an offline completion; `halotasks-server/tests/treeRules.test.ts` and `halotasks-client/src/growth/treeRules.parity.test.ts` hold the same case table (`STATUS_CASES`, kept byte-identical) so the copies cannot drift silently.

**Day rule.** The calendar day is the UTC date (`YYYY-MM-DD`). `gap` = whole UTC days from `lastActiveDate` (the last day an award was recorded) to today. Statuses are exclusive and evaluated in the order of the table: the missed-day thresholds (`dead`, `wilting`) come before the legacy zero-streak check, so a zero-streak record that is 2 or 3+ days old is `wilting` / `dead` like any other idle tree.

| status | condition | effective streak | health |
| --- | --- | --- | --- |
| `unstarted` | no last-active date and xp = 0 | 0 | dead |
| `unrecorded` | no last-active date but xp > 0 | 0 | dead |
| `dead` | gap >= 3 (two or more missed days) | 0 | dead |
| `wilting` | gap = 2 (one missed day) | 0 | wilting |
| `unrecorded` | gap <= 1 but a stored streak of 0 (legacy data that looks current but has no streak) | 0 | dead |
| `at_risk` | gap = 1 (completed yesterday, today still open) | stored streak | healthy |
| `active` | gap <= 0 (completed today; a future date from clock skew counts too) | stored streak | healthy |

**Recovery.** One award on any day sets the last-active date to that day, so the very next derivation is `active` / healthy. The award continues the stored streak only when gap = 1 and otherwise restarts it at 1 (`nextStreak`, unchanged). **XP, leaves, stage and the ledger never decrease**; idleness only changes the streak and health. Un-completing a task changes none of this.

**API.** `GET /api/tree` (and `PATCH /api/tree` with `{}`, and every award/`growth` response) returns the EFFECTIVE `streakDays` and `health` for the request's UTC day, plus additive `status` and `daysSinceActive` (null before the first completion). Reads never write: the stored copy (`streakDays`, `lastActiveDate`) keeps its value until the next award or retry. The effective state is folded from the retained history in memory (`effectiveFold`), so a completion whose derived write failed is shown as a restored tree by the award fallback response and by GET, while storage keeps the stale copy until a retry or the next award repairs it. A legacy tree that has not adopted yet is shown from its stored fold plus any marker day. A recorded award for today is never dropped when the stored last-active date lies in the future (clock skew): `nextStreak` moves that date back to the award day, and the read shows exactly that.

**Recalculation (Issue #16 AC8: "Recalculating state produces the same result from the same completion history.") — RESOLVED: retained-history reconstruction.** Decision: `activeDays` is the canonical source for activity-derived Growth Tree state. The stored derived fields are materialised projections that may be validated and repaired. Reads remain write-free. XP and task-award de-duplication retain their separate authority (the atomic award and the ledger). Historical activity before reliable day-history capture is not guaranteed to be reconstructable.

What this means in practice: (1) the streak and last-active date are a pure function of the retained history, `replayAwardDays(0, null, activeDays)`, and the same set of days gives the same result whatever order, repetition, retry or concurrency produced them (property-tested against day-by-day `nextStreak`, and against random mixes of days, failed derived writes, retries and concurrent awards); (2) after any failure the copy can be recomputed from the history, and a wrong copy (even one with too HIGH a streak) is corrected, not trusted; (3) a read never writes; (4) the history is bounded and never truncated: when it is full a new day is refused (`history_full`). What it does NOT mean: no backfill of days before this change (a legacy tree adopts only the days its stored streak implies), no reconstruction from task data (tasks carry no award days, and deleting a task never removes XP), and no change to XP, the ledger or the +10 rule.

**UI copy** (`TREE_STATUS_COPY`; never implies XP or stage is lost): unstarted "Complete your first task to plant a seed."; active "You grew your tree today. Come back tomorrow to keep the streak going."; at_risk "Complete a task today to keep your streak going."; wilting "You missed a day, so the streak reset and the tree is wilting. Your XP and stage are safe. Complete a task to restore it."; dead "It has been a few days, so the streak reset. Your XP, leaves and stage are safe. Complete a task to bring your tree back."; unrecorded "Complete a task to start a new streak. Your XP and stage are safe."

**Known limitation: UTC days.** Days are UTC, not the user's local day. For a user in IST (UTC+05:30) the UTC day changes at 05:30 local, so completions at 00:30 and 06:00 IST on the same local date fall on two different UTC days, and a late-night completion can count toward the previous or next local day. Moving to local days would need a stored timezone and is out of scope here.

## Offline Architecture

The app is built to tolerate network interruption.

Core offline pieces:
- `offline/cache.ts` - cached auth/task data helpers
- `offline/db.ts` - IndexedDB wrapper
- `offline/network.ts` - network helpers
- `offline/syncQueue.ts` - queued write actions, one queue per account (`sync_queue:<userId>`)
- `offline/queueProcessor.ts` - replay and retry logic

Important offline behavior:
- Tasks can be cached and replayed later
- Write actions are queued when offline, in the signed-in account's own queue; a queue is only ever processed while its owner is the signed-in account
- The queue is processed when connectivity returns
- Deletions were hardened so the UI is only mutated after queueing succeeds
- Permanent queue failures should not be retried forever

## Auth Architecture

Auth is handled with:
- `store/authStore.ts`
- `services/api.ts`
- `utils/authSession.ts`

Important auth behaviors:
- Token key is shared through `TOKEN_KEY`
- Tokens are validated on startup
- Expired tokens are cleared early
- API requests use a timeout
- A global 401 response interceptor clears auth and redirects to login, but only when the failed request was issued by the session that is still in place (Issue #34): each request is stamped with the auth store's in-memory `sessionGeneration` (bumped by every login and logout, never persisted) and must also still carry the credential in use, so a late 401 for a previous session, even one that re-logged in with an identical token, is ignored
- A 401 is not a reason to discard queued offline work: `offline/queueProcessor.ts` stops at the first 401 and keeps that entry and every entry after it, in the owning account's own queue (see "Session Invalidation"); other permanent 4xx still discard the one entry
- `ProtectedRoute` is the main guard for authenticated views

Auth store data:
- `token`
- `user` (`id`, `name`, `email`, and `timeZone` when the account has a saved time zone; see "Time Zone Preference")
- `setAuth()`
- `clearAuth()`
- `setUserTimeZone()` (records a server-confirmed zone in the store, localStorage and the offline cache; it is not a new session, so `sessionGeneration` does not change)

## Task and Growth Data

Task-related modules:
- `types/task.ts`
- `services/taskService.ts`
- `hooks/useDashboardTasks.ts`
- `hooks/useTaskFilters.ts`
- `hooks/useTaskSorting.ts`
- `hooks/useTaskSelection.ts`
- `hooks/useTagSuggestions.ts`
- `hooks/useDashboardSync.ts`

Growth-related modules:
- `growth/treeLogic.ts`
- `growth/treeStorage.ts`
- `growth/treeTypes.ts`
- `hooks/useDashboardGrowth.ts`

Reminder-related modules:
- `reminders/deadlineLogic.ts`
- `reminders/notification.ts`
- `reminders/permissions.ts`
- `reminders/scheduler.ts`
- `reminders/settings.ts`

## Task API Contract (Backend)

`GET /api/tasks` is paginated (added when task-controller input validation was
hardened):
- Query params: `page` (1-indexed, default `1`) and `limit` (default `200`,
  hard-capped at `200` regardless of what's requested — this is the bounded
  maximum, not just a suggestion).
- Response adds `page`, `limit`, `total`, `hasMore` alongside the existing
  `tasks` array — additive, so a client that only reads `{ tasks }` still
  works. The frontend's `taskService.getTasks()` (in
  `halotasks-client/src/services/taskService.ts`) transparently loops pages
  until `hasMore` is false and combines the results, so no caller anywhere
  in the app needs to know pagination exists, and a user with more than 200
  tasks is never silently truncated.
- `page`/`limit` values that aren't positive integers are rejected with 400
  rather than silently defaulted.

`PUT /api/tasks/:id` and `DELETE /api/tasks/:id` validate `:id` as a Mongo
ObjectId before querying — a malformed id now returns 400, not a 500 from an
unhandled Mongoose CastError.

Task body validation (`title`, `description`, `tags`, `priority`,
`dueDate`, `estimatedMinutes`) is centralized in
`halotasks-server/src/utils/taskValidators.ts` and applied identically on
create and update, so an empty/whitespace title (or an invalid due date, or
an out-of-range value) is rejected the same way regardless of which
endpoint is called. See `docs/logs.md` for the full list of limits (title,
description, tag length/count, estimated-minutes range).

## Task Start Time and Due Time (Issues #9, #10)

Both fields are optional and independent of the legacy `dueDate`.

| Field | Format | Meaning |
| --- | --- | --- |
| `dueDate` | `YYYY-MM-DD` (unchanged) | Stored as UTC midnight; the UTC date part is the calendar day the user picked. |
| `dueTime` | `"HH:mm"` (24h) | Wall-clock time on `dueDate`. Needs a `dueDate`. The deadline instant is derived in the user's effective time zone (Issue #41, see below) and never persisted. |
| `startTime` | ISO 8601 with `Z` or `±hh:mm` | An absolute instant. It has no date anchor, so a start time alone is valid. |

- Parsing is strict: Feb 30, `24:00`, zone-less datetimes and non-strings are 400.
- A `dueTime` with no `dueDate` (on create, or on update with no stored date) is 400.
- Update: `null` or `''` clears a field. Clearing `dueDate` also clears `dueTime`. Clearing the date while setting a time is 400.
- Setting `dueTime` alone relies on the stored date; if it is removed concurrently the update returns 409.
- A date-only task keeps its legacy deadline (UTC midnight). It is not turned into a local-midnight deadline.
- Client logic lives in `halotasks-client/src/utils/deadline.ts` (sorting, overdue/today/upcoming, display). Reminders reuse the existing scheduler; the explicit-start window ends at the exact deadline, otherwise start + buffer.
- No migration: old documents simply lack the fields.
- Model invariant (Issues #10, #44): a task never persists a `dueTime` without a usable `dueDate` (a valid Date, or a string/number that parses to one), and clearing a due date clears the time. It is enforced in `Task.model.ts`, so every Mongoose write path goes through it, not only the controller, and it does not depend on Mongoose validation being switched on: documents (`create`/`save`/`insertOne`/`insertMany`/`Model.bulkSave`) are checked by a validate hook and a save hook (a loaded task whose date is cleared loses its time; any other time without a date is rejected, also with `validateModifiedOnly` and `validateBeforeSave: false`); raw inserts are checked on the document itself (`bulkWrite` `insertOne` and `replaceOne` including `{ skipValidation: true }`, `insertMany` including `{ lean: true }`); `findOneAndUpdate`/`updateOne`/`updateMany` and `bulkWrite` update ops go through `guardDeadlineUpdate`, which makes a lone `dueTime` conditional on the stored date (`dueDate: { $exists: true, $ne: null }` added to the filter, so the write matches nothing without a date and a concurrent removal cannot slip in), adds `$unset: { dueTime }` to any update that removes or nulls the date, and refuses a contradictory update, an upsert of a lone time, a pipeline update and `$setOnInsert`/`$rename`/`$min`/… on either field; `replaceOne`/`findOneAndReplace` are checked on the replacement. The task controller is the only production writer and keeps its own checks and its 409 (`TASK_DUE_DATE_REMOVED`, Issue #43). Deliberately NOT protected: any call that turns Mongoose middleware off (`{ middleware: false }` on `save`, `insertMany`, `bulkWrite` or a query, verified to skip every hook in Mongoose 9.4.1), the native driver (`Task.collection.*`, `Task.db`), shell/script writes, and data stored before the model existed; only a MongoDB collection validator (an ops migration, not done) could guard those. The format of `dueTime` itself is validated by the schema and the controller, so a write that disables validation is checked for the date/time pairing only.
- Offline 409 (Issue #43): when an update sets `dueTime` against the stored date and the date was removed first, the server answers `409 { message, code: "TASK_DUE_DATE_REMOVED" }`, in the same `{ message, code }` shape other endpoints use. The code is specific to that conflict: a task deleted in between, or a date that is back by the time the conflict is re-read, gets the plain `409 { message }`. The queue recovers only from a 409 whose body is an object with `code` strictly equal to that string and an edit that carries a `dueTime`; message text and payload shape are never used to decide. Recovery sends the edit once more with `dueTime: null`, adopts the server task and tells the user the due time was not kept: one extra request per run, never a loop; if that request fails transiently the original entry is kept. Every other 409 (no body, wrong or malformed code, create/delete) takes the normal path and is discarded as a permanent 4xx.
- Reminder identity: a task created offline keeps a client-only `clientKey` (its first `local-…` id) after sync, and the scheduler key and notification tag use `clientKey ?? _id`. This keeps an already-fired reminder from re-arming when the id changes. It holds within the persisted cache and the browser session; it does not cover another device, a cleared cache or a new session.
- "Start now" names a clock time only for a task with a `dueTime`; date-only tasks get the generic message.
- Known limits: reminders are client-side only (the only server email is for authentication, so there is no task email scheduling to feed); date-only reminders still use UTC midnight (Issue #42).

## Time Zone Preference (Issue #41)

A user can save an IANA time zone. It decides how a task's wall-clock time becomes an instant, and which calendar day "today" is for deadlines. The server only stores it; every interpretation happens on the client in one place (`utils/timeZone.ts`, used by `utils/deadline.ts`).

**Storage and API (server)**
- `User.timeZone`: optional string, no default, no migration. Absent means "no saved choice". The model validates it, so a direct Mongoose write cannot store a bad value either. It is not in the JWT (a claim would go stale on the first change; the token carries only `userId`, `email`, `name`, `tv`).
- `GET /api/user/preferences` -> `200 { timeZone: string | null }`; `PUT /api/user/preferences` with `{ timeZone: string | null }` -> `200 { timeZone }` as stored. Authenticated (`requireAuth`); the account is the one in the verified token, never a body or query field. No existing route fit (the auth routes are credential flows and there was no profile route), so this is the only new route. `PUT` is a single `$set` (or `$unset` for `null`) of `timeZone`, so no other field of the request or the account is written; the only other change is the `updatedAt` that the schema's `timestamps` bumps on every User update.
- Validation (`utils/timeZone.ts`): a string of at most 64 characters that looks like an IANA identifier (starts with a letter, so `+05:30`, `-08:00` and `UTC+05:30` never match) and that the runtime's `Intl` accepts. Intl alone is not enough: Node accepts fixed offsets. Anything else, including a missing field, `""`, a non-string, an unknown zone or an offset, is `400 { message }`. The field is required in a `PUT` so a request cannot silently do nothing.
- Login and register return `user.timeZone` (the saved value or `null`). An older server's response without the field is read as "no choice".

**Effective zone and fallback (client)**
- effective zone = the saved preference, else the device's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), else `UTC`.
- The device zone is a fallback only. It is never sent to the server, never written to the store or `localStorage`, and never overwrites a saved value: sign-in, refresh and a new device all take the server's value (or "none"). A stored value the runtime does not recognise is treated as "none" rather than trusted.
- Hydration order: the auth store restores the stored user at startup and mirrors its `timeZone` into `utils/timeZone.ts` before the first render, so the first paint already uses the saved zone. Signing out or in as another account resets it; one account's zone never carries over to the next.

**Time model: what a zone change does**

| Value | What it is | When the zone changes |
| --- | --- | --- |
| `startTime` | An absolute instant (ISO with an explicit zone). | The instant never changes. Only its display and the `datetime-local` form value change: the same moment is shown as a different clock reading, possibly on a different date. |
| `dueDate` | A calendar day: the UTC date part of the stored value. | Never rewritten and never re-read through a zone. The same day in every zone. |
| `dueTime` | A wall-clock `HH:mm` on `dueDate`. | The text is unchanged. The zone turns the pair into an instant, so the deadline instant moves with the zone: 17:30 on 2026-10-20 is 12:00Z in `Asia/Kolkata` and 00:30Z on the 21st in `America/Los_Angeles`. A task that was due in an hour may be overdue, or days away, after the change. This is the chosen meaning ("my 17:30 is my 17:30 wherever I say I live"); changing the zone is not a travel-time conversion. |
| date-only (no `dueTime`) | A due day with no clock. | Not an exact deadline in any zone and never turned into a midnight instant. It is judged by day: overdue once the effective zone's today is after the due day, "today" on it. |

- "Today", "tomorrow", overdue and the Due Today / Overdue / Upcoming sections compare against the current calendar day in the effective zone (`getDueState`, `isPastDeadline`, `formatDueLabel`), not the device's. A timed task is overdue from its exact instant.
- Create and edit forms: the start-time input is read and written in the effective zone (`startInputToIso`, `isoToStartInput`), and the default due date for a new task is today in that zone. An untouched start time round-trips unchanged through an edit.
- Reminders use the same functions (`getExactDeadline`), so "due soon", "overdue", the smart-start window and the "start now" text agree with the card. The "start now" clock time is formatted in the effective zone. The reminder schedule identity (scheduler key and notification tag) of a task with a `dueTime` now includes the zone, so changing it re-arms that task's reminder; start-only and date-only tasks carry no zone and are not re-armed.
- Sorting is by due day then clock reading and does not depend on the zone.
- Display text for a due day (`Due Oct 20`, copy-to-clipboard) is formatted from the stored day, so it can no longer show the previous day west of UTC.

**Daylight saving policy (deterministic, never the machine's)**
- A wall-clock time that does not exist (the hour skipped when clocks spring forward) resolves to the instant it has under the offset in force just before the change, i.e. one hour later, on the same date: 02:30 on 2026-03-08 in `America/Los_Angeles` is 03:30 PDT (10:30Z). It is never rejected and never moved to another day. The same rule applies to half-hour shifts (`Australia/Lord_Howe`).
- A wall-clock time that occurs twice (the hour repeated when clocks fall back) resolves to its first occurrence: 01:30 on 2026-11-01 in `America/Los_Angeles` is 01:30 PDT (08:30Z), not 01:30 PST. The stored clock text is not changed in either case; a start time that fell in the gap is stored as the resolved instant and reads back as the later clock time.
- Impossible dates and times (month 13, February 30, `24:00`) are refused, never rolled over.
- Implementation: only `Intl` (the runtime's time zone data); no fixed offsets, no zone table of our own, no new dependency.

**Remaining limits and decisions for Issue #42**
- Date-only reminders are deliberately unchanged: the reminder moment of a date-only task is still its stored due date read as an instant (UTC midnight of the due day), in every zone. Issue #42 must decide what moment a date-only task reminds at in the effective zone (it must not invent a due time or silently use local midnight); `getDeadlineMs` and `parseDueDate` in `reminders/deadlineLogic.ts` are the place. Until then a user west of UTC is reminded of a date-only task the previous evening, and one east of it after the day has begun.
- Not moved to the preferred zone, still the device's: the History and Growth Tree calendar days (the client declares the device's `utcOffsetMinutes` on every History request, per the History contract, and the Tree uses UTC days), "completed today" in `utils/taskInsights.ts`, and reminder quiet hours (`reminders/settings.ts`). A user whose preference differs from their device can therefore see a deadline day and a History day that differ.
- The server never interprets a zone: it stores `startTime` as an instant and `dueDate`/`dueTime` as sent, and has no deadline logic. There is no server-side overdue calculation to keep in step.
- Validation accepts anything the runtime's ICU knows, including legacy aliases (`Asia/Calcutta` and `Asia/Kolkata` are both fine; some runtimes list only one) and, because ICU matches case-insensitively, case variants such as `asia/kolkata`. The Settings control only sends names from its own list. A server with newer zone data than a client's browser can store a zone that browser does not know; that client then treats it as "no choice" and uses the device zone.
- The saved preference needs a connection to change; it is not part of the offline queue.

## History: Source of Truth, Calendar Days, and API (Issue #31)

**Model.** The history of one calendar day is the **set of tasks completed that day, keyed by
task id**. `completedCount` and `workDoneMinutes` are always recomputed from that set, never
stored independently or added across sources, so reconciling the same data any number of times
cannot double-count and two devices' sets combine by **union** without losing either side's tasks.
The **server** (`DayHistory`, one row per user per day) is the durable cross-device source of truth.
**Local IndexedDB** (`offline/history.ts`) is the offline-first cache and the outbox
(`pendingSync`), scoped per user (`task_history:<userId>`).

**Reconciliation** (`offline/history.ts`, the only code path that talks to the server). Every local
change and the first history read of a session run **pull → merge → push**; per date in the 7-day
window:
1. Local entry `pendingSync` (unacknowledged work): `merged = (server tasks − tasks THIS device
   un-completed) ∪ local tasks`, by task id. It is pushed only if it differs from the server row.
   A pending snapshot **never replaces the server row wholesale**, so a device that was offline
   cannot erase tasks another device completed (e.g. server `A,B,C` + pending local `A,B` stays
   `A,B,C` and nothing is sent).
2. Otherwise, if the server has a record, the server wins (recovers a cleared or new device and picks
   up other devices' changes).
3. Otherwise, if the device recorded work the server lacks, it is pushed (heals a server that missed it).

`pendingSync` clears only when the server acknowledges the exact revision pushed, so an edit made
during a push stays pending. Transient failures stay pending and are retried (throttled to one attempt
per 15s); a 400 is treated as permanent for that payload. Bursts of edits coalesce into a follow-up
sync, and local snapshots are applied in the order they were requested. Removals: a task leaves
history only when this device itself saw it stop being completed (`removedTaskIds`, cleared on
acknowledgement); a task this device never knew about is never treated as removed. No timestamps are
compared, so device clock skew cannot reorder snapshots. Another device's changes arrive on the next
load, not live.

**Calendar days — one convention.** A history date is the user's **local** calendar day (`YYYY-MM-DD`),
defined as *the calendar date of an instant shifted by the user's UTC offset*. The server cannot know a
user's timezone, so the client declares it on **every** history request as `utcOffsetMinutes` (minutes
east of UTC at that moment: India +330, Los Angeles −420 summer / −480 winter, UTC+14 → 840, UTC−12 →
−720; integer, −720…840). The server evaluates "today" from its own clock plus that offset — never in
UTC or its own timezone — and accepts a date only if it is **exactly** that one today — no clock-skew
tolerance, so yesterday and tomorrow are always rejected (400 with code `DATE_NOT_TODAY`; backfill
outside its window gets `DATE_OUT_OF_RANGE`). Because the device clock and server clock can differ by
a few seconds, a push near local midnight can be rejected; the client treats `DATE_*` 400s as
retryable (the snapshot stays pending and is re-sent with a fresh date decision), while any other 400
is permanent for that payload. A date rejection never wipes local history. There is
**no default offset and no UTC fallback**: a request without a valid offset is rejected. DST needs no
special handling because the offset is a per-request fact. A wrong declared offset can only misplace the
caller's own entries. Implementation: `halotasks-server/src/utils/calendarDate.ts` and the client's
`utils/localDate.ts`. (The Growth Tree's own streak date, `growth/treeLogic.getTodayDate`, is still UTC;
it is a separate feature and was deliberately left unchanged.)

**API** (validators: `halotasks-server/src/utils/historyValidators.ts`; bad input → 400, nothing
written, never coerced to zero):
- `GET /api/history?days=N&endDate=YYYY-MM-DD&utcOffsetMinutes=M` — `endDate` and `utcOffsetMinutes`
  are **required**; `endDate` must be today at that offset. `days` is one integer 1–90 (default 7;
  out of range rejected, not clamped); repeated or structured params are rejected. Days without a
  record return zeros with `updatedAt: null`, so "no record" differs from a genuinely empty day.
- `PUT /api/history/today` — strictly today at the declared offset; historical and future dates are
  rejected.
- `PUT /api/history/:date` — bounded backfill: the last 7 days, never future; a body `date` must match
  the path. **It is required by the sync contract, not extra surface:** snapshots are queued locally and
  pushed later, so a snapshot recorded offline before midnight is delivered after its own day has ended,
  when `PUT /today` (correctly) refuses it. Exact call path: `updateTodaySnapshot()` / `getWeekHistory()`
  → `reconcile()` → `pushEntry()` → `date === today ? historyService.upsertToday (PUT /today) :
  historyService.upsertForDate (PUT /:date)`.
- Body `{ date, utcOffsetMinutes, completedCount, workDoneMinutes, completedTasks }`: `completedTasks` ≤ 500,
  unique `taskId`s (1–64 chars of letters/digits/`-`/`_`), non-empty `title` ≤ 200, `estimatedMinutes`
  finite 0–100000; `completedCount` must equal the array length and `workDoneMinutes` the sum of
  `estimatedMinutes`. Unknown fields are dropped; the offset is validated, not stored.

**Legacy unscoped history.** Before user scoping, history was stored under one global IndexedDB key
(`task_history`) with no owner. **Ownership cannot be established, so that record is discarded, not
migrated:** it is never read, never merged and never pushed, and it is deleted on first use, so it can
never be assigned to whichever user logs in next. History that had reached the server is recoverable
from there. Only history that existed solely in that global key (never successfully synchronized) is lost.
Covered by regression tests in `offline/history.test.ts`.

**Known limitation.** The merge happens on the client before a push, and the server applies a push as a
replace. If two devices both pull and then push within the same short GET→PUT gap, the later push can
overwrite a task the other just added. Closing that window needs an atomic server-side merge, which was
not built here because it cannot be tested without MongoDB in this environment.

## AI Task Creation (Issue #22)

The browser no longer talks to the AI provider. `useAiTaskCreation` calls the backend through
`services/aiService.ts` (the shared `apiClient`, so it carries the normal Bearer token), and the
backend owns the Groq key.

- **Endpoint:** `POST /api/ai/parse-tasks` (`routes/ai.routes.ts` → `controllers/ai.controller.ts`),
  behind the existing `requireAuth` middleware — no second auth mechanism.
- **Request:** `{ prompt: string }`, non-empty after trimming, at most 2000 characters
  (`AI_PROMPT_MAX_LENGTH`, mirrored by the textarea's `maxLength`). Other fields are ignored; the provider,
  model, endpoint, temperature, `max_completion_tokens` and the reasoning settings are server constants
  (`utils/groqClient.ts`) and cannot be chosen by a caller. Validation runs **before** the provider is contacted.
- **Provider request (Issue #32):** model `openai/gpt-oss-120b` (Groq retired `llama-3.3-70b-versatile`
  on 2026-08-16). Body: `temperature: 0.2`, `max_completion_tokens: 2048` (the application-level output budget;
  `max_tokens` is deprecated and no longer sent; Groq's docs do not spell out how reasoning tokens count
  against it, so live validation should confirm 2048 is sufficient with reasoning enabled), `reasoning_effort: "low"` (the
  model default is `medium`; extraction is simple and low keeps latency and token use down) and
  `include_reasoning: false` (only `message.content` is read, so reasoning text is not requested).
  `reasoning_format` is never sent (unsupported on gpt-oss and mutually exclusive with `include_reasoning`),
  and there is no `response_format`, `stream` or `tools`: the prompt and the top-level JSON-array contract
  are unchanged, and `parseModelOutput` still rejects anything that is not an array (truncated or empty
  output becomes a safe 502).
- **Response:** `200 { tasks: [{ title, priority, dueDate?, estimatedMinutes?, tags, description }] }`
  (possibly empty). The server parses and sanitises the model output (`utils/aiTaskParser.ts`: at most 20
  tasks, bounded title/description/tags, real `YYYY-MM-DD` dates, valid minutes, priority defaults to
  `medium`); the client keeps its own defensive mapping to preview drafts, so the UX is unchanged.
- **Errors (all generic messages):** `400` invalid request; `429` provider rate-limited; `502` provider
  unavailable/auth failure/unexpected output; `504` provider timeout (20s); `503` `GROQ_API_KEY` not
  configured. A provider 401/403 is deliberately mapped to 502, never forwarded as 401 — the client's
  interceptor would otherwise log the user out. Provider error text is never returned or logged; logs hold
  only a failure category and upstream status, never the key, the prompt or generated content.
- **Config:** `GROQ_API_KEY` is read only on the server (`config/env.ts#getGroqApiKey`); it is documented in
  `halotasks-server/.env.example`, `.env.production` and the README. `server.ts` warns (does not refuse to
  start) when it is unset. `VITE_GROQ_API_KEY` was removed from the client env files and code; the client
  build needs no provider secret, and `src/test/noClientSecrets.test.ts` fails if a provider reference or
  key variable reappears in client source.
- **Rate limiting:** no reusable limiter exists in the repo. Per the issue, none was built here; the endpoint
  is bounded by authentication, the prompt cap, `max_completion_tokens` and the timeout. Per-user/IP limiting is the
  dependency on **Issue #23**.
- Prompt "today" is the server's UTC date (the browser previously used the UTC date too).

## Rate Limiting (Issue #23)

**Deployment assumption.** The backend runs as one long-lived Node process per deployment: Render is the
primary and Railway the backup (README), the client is on Vercel. The repo has no cluster/pm2/replica/Docker
configuration and nothing that runs two instances side by side. A process-local limiter is therefore
sufficient *for this topology*; it is **not** globally authoritative and must be revisited if the API is ever
scaled to several instances (see Known limitations). `docs/DEPLOYMENT.md` is referenced by the README but
does not exist, so this is inferred from the repo, not from a deployment document.

**Mechanism.** `middleware/rateLimit.ts` is a small fixed-window limiter; `config/rateLimits.ts` holds every
number; `middleware/rateLimiters.ts` assembles the limiters applied in the routers. No dependency was added
and no shared store (Redis or Mongo) is used. A limiter is a list of rules, each with its own counters; a
request is refused (429) if *any* rule is exhausted, the check happens before anything is consumed (a refused
request never uses up another rule's budget), and rules whose key cannot be derived (e.g. no e-mail in the
body) are skipped. Rules marked *refund on success* count the attempt up front, so parallel requests cannot
all slip under the limit, then give it back if the response is 2xx/3xx — only failed attempts keep their
slot. Memory is bounded: see *Capacity* below.

**Capacity (what happens when the store is full).** Each rule holds at most 20,000 distinct keys
(`RATE_LIMIT_MAX_KEYS`). Expired buckets are reclaimed lazily (once per window normally, at most once per
second while the store is full). A **live bucket is never evicted to make room**: evicting one would let
anyone who can mint many unique keys (random e-mail addresses, say) reset another client's active limit.
When a store is full of live buckets, a request whose key has *no* bucket is refused with the normal 429
(`Retry-After` = time until the earliest live bucket expires), and nothing else is charged for that refused
request. Requests for keys that already have a bucket are unaffected and keep accumulating and enforcing
their limits; an expired-but-unswept bucket is reused in place, so it needs no extra capacity. The trade-off
is deliberate: flooding a store is a denial of service against *new* keys for at most one window, not a
bypass of existing limits. Failing open for new keys was rejected because an attacker could fill the store
and then guess against a victim whose bucket does not yet exist. Filling a store costs an attacker many
distinct sources: one IP can only create as many buckets per window as the IP rule allows (30 login, 5
forgot-password, ...), so reaching 20,000 live account buckets needs on the order of hundreds to thousands of
IPs. Because freed capacity is noticed by a throttled sweep, it can be seen up to one second late.

**Limits** (fixed window; the (max+1)th request in a window gets 429):

| Endpoint | Rule | Key | Max / window |
|---|---|---|---|
| `POST /api/auth/login` | IP | client IP | 30 / 15 min |
| | account + IP (refund on success) | hashed e-mail + IP | 5 / 15 min |
| | account, any IP (refund on success) | hashed e-mail | 30 / 60 min |
| `POST /api/auth/register` | IP | client IP | 10 / 60 min |
| `POST /api/auth/forgot-password` | IP | client IP | 5 / 15 min |
| | account | hashed e-mail | 3 / 60 min |
| `POST /api/auth/reset-password` | IP | client IP | 10 / 15 min |
| | account (refund on success) | hashed e-mail | 5 / 15 min |
| `POST /api/ai/parse-tasks` | user (after auth) | user id | 20 / 10 min |
| | IP | client IP | 60 / 10 min |
| `POST /api/push/relay` | user (after auth) | user id | 60 / 5 min |

Why these dimensions: IP-only limits are bypassed by spreading requests over IPs; account-only limits let an
attacker lock a victim out. Login therefore combines a per-IP limit (credential spraying), a per-(account, IP)
limit (one source hammering one account, without locking the real owner out from another IP) and a high
account-wide ceiling for distributed guessing — that last one *can* lock the owner out while an attack is
running, which is the accepted cost. Register has no secret to guess (and e-mail existence is already visible
through the existing 409), so it is IP-only. Reset-password guesses a 6-digit code valid ~20 minutes, hence the
strict per-account bucket (at most ~10 guesses per code lifetime). Relay fans one call out to every device a
user registered; the client calls it once per due reminder, so 60 per 5 minutes leaves room for bursts and
multi-device users, and a refused relay degrades silently (the local notification has already fired).
The #22 protections (prompt cap, `max_completion_tokens`, 20 s timeout) are unchanged and not duplicated.

**Not limited, deliberately:** task CRUD, tree, history and push subscribe/unsubscribe (authenticated, cheap,
bounded by body size and per-route validation). Unauthenticated floods against other routes are out of scope.

**Keys and privacy.** E-mail keys are the normalised address passed through a per-process random-salt HMAC;
counters never hold an address, password, reset code, token or prompt, and nothing request-derived is logged.
IP keys go through `normalizeIp` (Node's own `net` parsers, no dependency): every spelling of an IPv4-mapped IPv6
address collapses to the IPv4 address; IPv6 is bucketed by /64 (compressed, uncompressed, leading-zero and
mixed-case forms agree, and a zone id such as `%eth0` is ignored), so one machine cannot mint unlimited buckets
from its address block; anything that is not a valid IP (missing, malformed, `host:port`, `[::1]`) goes to one
shared `unknown` bucket rather than minting its own.

**Client IP / proxies.** `app.set('trust proxy', TRUST_PROXY_HOPS)` (default **0**: `X-Forwarded-For` and
every other forwarding header is ignored and the socket address is used). With N hops the N nearest
addresses are trusted and the client is the entry just beyond them, so anything a caller prepends to
`X-Forwarded-For` is never believed; `X-Real-IP`, `Forwarded`, `True-Client-IP` and `CF-Connecting-IP` are
never read. A malformed value fails fast at startup. Configure it per environment:

- **Local development: `TRUST_PROXY_HOPS=0`** (no proxy; also the default).
- **Render: `TRUST_PROXY_HOPS=1`.** Render's proxy appends the real peer address and, per a Render community
  thread (not official documentation), does not strip a caller-supplied `X-Forwarded-For`; that is why "trust
  everything" (`true`) would be spoofable and an exact hop count is used.
- **Railway: unverified — no value is claimed.** Railway staff state that its edge strips client-supplied
  `X-Forwarded-For` and that "you may see another hop", but the number of hops was not confirmed here. Verify
  on a Railway deployment before relying on IP limits there. Until then keep the value no higher than you can
  prove: too low merges clients into a shared bucket (fail-closed), too high lets callers choose their own.

Before this change `trust proxy` was unset, so
behind a platform proxy `req.ip` was the proxy's address and the old forgot-password limiter was effectively
one global bucket for all users. Production logs a warning when the value is 0.

**429 contract.** `429 { "message": "Too many requests. Please try again later." }` plus `Retry-After: <whole
seconds, >= 1>` (the longest remaining wait among exhausted rules). The same body is used by every limiter and
names no rule, key or count; no `RateLimit-*` headers are sent. The client already shows the server `message`
(login, forgot-password pages) and does not treat 429 as a logout (only 401 does).

**Account enumeration.** Forgot-password still answers the neutral 200 for known and unknown addresses. Its
address bucket counts the *submitted* address whether or not an account exists, so the point at which 429
starts and the body are identical either way (covered by tests that run known and unknown addresses through
the whole limit and compare). Login and reset-password buckets likewise count attempts for unknown accounts
exactly like known ones. The rate limit never changes which of the existing messages is returned below the limit.

**Replaced:** the in-controller `forgotAttempts` Map (5 / 15 min keyed on `req.ip`) was removed; the new
forgot-password IP rule keeps the same numbers.

**Known limitations.** State is per process and resets on restart (Render free tier spin-down included); with
several instances each would allow its own full budget. Fixed windows allow up to 2× the limit across a
window boundary. The account-wide login cap can be used to deny a specific owner for up to an hour. A shared
store is the follow-up if the topology changes (the existing MongoDB could back a TTL-indexed counter
collection; not built because it adds a database write to every login attempt and cannot be tested here
without MongoMemoryServer). The push endpoint-URL and unbounded-subscription concerns noticed during this work were addressed
in Issue #26 (see *Push Subscription and Relay Boundaries*).

## Push Subscription and Relay Boundaries (Issue #26)

All three push routes sit behind `requireAuth`; `relay` additionally keeps the Issue #23 per-user limiter
(unchanged, not duplicated). Input rules live in `utils/pushValidators.ts`; the endpoint is treated as
untrusted because the **server** later POSTs to it. Every failure is `400 { message }` and the message never
echoes a submitted value (endpoints are capability URLs).

**Subscribe** (`POST /api/push/subscribe`, body = `PushSubscription.toJSON()`):

| Field | Rule | Why |
|---|---|---|
| `endpoint` | string, ≤ 2048 chars, no whitespace/control chars, valid URL, **https**, no credentials, default port, host is a DNS name (no IP literal in any spelling — the URL parser normalises decimal/hex/octal IPv4 first — no `localhost`, no single-label or `.local/.internal/.localhost/...` names) | RFC 8030 requires https push services; real endpoints are 100–300 chars; blocks the obvious SSRF targets (loopback, private ranges, cloud metadata IP) |
| `keys.p256dh` | unpadded base64url, canonical, decodes to exactly **65** bytes | RFC 8291 uncompressed P-256 point; `web-push` enforces 65 too |
| `keys.auth` | unpadded base64url, canonical, decodes to exactly **16** bytes | RFC 8291 auth secret (`web-push` accepts ≥ 16; browsers send 16) |
| `expirationTime` | omitted / `null`, or an integer in `(now, 8.64e15]` ms | epoch-ms like a JS Date; an already-expired subscription is useless |

Only `endpoint`, `expirationTime` and `keys.{p256dh,auth}` are stored; anything else in the body is dropped.

**Dedup and the bound are atomic.** The controller never reads then writes, and never does a `$pull` followed
by a `$push` (the old code, which could leave duplicates under concurrent requests). It issues single-document
conditional updates, each atomic in MongoDB: (1) endpoint already stored → `$set` its element in place
(`pushSubscriptions.$`; position kept); (2) endpoint absent (`$ne` guard) → `$push` with `$each` + `$slice: -10`;
(3) step 2 matched nothing because a concurrent request stored the same endpoint first → refresh it.
Duplicates are therefore impossible, and `$slice` makes the array **never exceed 10** per user
(`PUSH_SUBSCRIPTIONS_MAX_PER_USER`): ten is generous for a personal task app and each entry costs one outbound
request per relay. At the limit the **oldest is dropped, the newest wins** (rather than rejecting), so a user
whose old endpoints went stale (reinstalled browser, cleared site data) can always register their current
device; an account already over the limit from before is trimmed to the newest 10 on its next new subscription.
A valid token for a deleted account gets 401 and nothing is stored.

**Unsubscribe** (`POST /api/push/unsubscribe`, `{ endpoint }`): the endpoint must be a non-empty string ≤ 2048
chars. URL shape is deliberately *not* required so a legacy entry can still be removed. Objects such as
`{ "$ne": "x" }` are rejected with 400 — previously they reached the `$pull` query and could delete every
subscription of the caller. Unknown endpoints remain a successful no-op (`200 { ok: true }`).

**Relay** (`POST /api/push/relay`, `{ title, body, tag? }`, validated before anything else):

| Field | Rule | Why |
|---|---|---|
| `title` | non-empty string, ≤ 100 | client titles are four fixed phrases (≤ 40) |
| `body` | non-empty string, ≤ 500 | a short template around a task title; task titles are capped at 200 (≤ ~270) |
| `tag` | optional (default `halotask-push`), string 1–200, no control chars | `halotask-<type>-<taskId>-<due date>` is ~100 |
| serialised payload | ≤ 3993 UTF-8 bytes | RFC 8291 plaintext limit; character limits alone don't guarantee it (multi-byte text, JSON escaping) |

Delivery: each subscription is attempted independently with `TTL: 3600` and a new **10 s per-delivery timeout**
so one slow or hostile endpoint cannot hold the request open. Response `200 { sent, failed, pruned }`
(`failed` is new and additive): `sent` = accepted by the push service; `pruned` = reported gone (**404/410**) and
removed in one `$pull`; `failed` = any other failure (429, 5xx, 401/403, 413, network error, unusable stored
keys) — those subscriptions are **kept** because they may recover. One failing endpoint never stops the rest,
and a failure while pruning is logged generically and reported as `pruned: 0` (the stale entries are retried on
the next relay) instead of turning a completed relay into a 500. Unchanged: `{ sent: 0 }` for no
subscriptions, `{ sent: 0, reason: 'vapid_not_configured' }` for a *valid* request when VAPID is unset (a
malformed request is now 400 in that case too).

**Logging.** Subscribe/unsubscribe log nothing. A failed delivery logs only the push service **host** and an
HTTP status (`[Push] Delivery failed (host fcm.googleapis.com, status 500)`); endpoints, p256dh/auth, payload
text and upstream error messages (which can echo them) are never logged.

**SSRF boundary: where DNS names are checked (`utils/pushNetworkGuard.ts`).** Shape checks cannot see where a
DNS name points, so an attacker-owned name (or a rebinding one) resolving to `127.0.0.1`, `10.x`, or
`169.254.169.254` would otherwise get the server to POST inward. Delivery therefore passes `web-push` an
`https.Agent` whose `lookup` resolves the name and **refuses the connection if any returned address is not
public** (loopback, RFC1918, CGNAT, link-local/metadata, unspecified, multicast, reserved/documentation,
ULA/link-local/multicast IPv6, NAT64/6to4, and IPv4-mapped IPv6 of any of those). The address validated is the address the socket
connects to (no second resolution), which is what defeats DNS rebinding; TLS still verifies the certificate
against the original hostname, and `web-push` does not follow redirects. A mixed answer (public + private)
fails as a whole. The guard failure is an ordinary delivery failure: counted in `failed`, subscription kept,
log line is host-only.
- *What bounds time (precisely).* `web-push`'s `timeout: 10_000` is an **idle socket timeout**, not a total
  deadline. Node starts it when the socket object is created, which is *before* the DNS lookup finishes, so a
  delivery whose DNS never completes is still settled by it (`Socket timeout`; tested with the real `web-push`
  and a resolver that never settles). Two limits remain: it resets on any socket activity, so a slow-drip
  response can exceed 10 s in total; and it only abandons the request: `dns.lookup()`/getaddrinfo cannot be
  cancelled and would keep a libuv threadpool thread (shared with fs/crypto/bcrypt) busy. The guard therefore
  does not use `dns.lookup`: its default resolver is c-ares (`dns.Resolver`) with a per-attempt timeout
  (2 s x 2 tries) and a hard 5 s deadline after which `cancel()` aborts every outstanding query, so a stalled
  name leaves nothing running (tested against a silent UDP DNS server: it settles at the deadline and sends no
  further queries afterwards). A and AAAA are resolved once, in parallel, and only those validated addresses
  are handed to the socket. Trade-off: c-ares ignores `/etc/hosts` and nsswitch, so names that exist only
  there do not resolve; public push services are unaffected.
- *Why not an allowlist:* the hosts HaloTask meets are whatever the browser's `pushManager.subscribe` returns
  (the client sends no endpoint of its own): `fcm.googleapis.com` (Chrome/Edge/Brave/Opera),
  `updates.push.services.mozilla.com` (Firefox), `web.push.apple.com` (Safari), `*.notify.windows.com` (WNS).
  `web-push` itself only special-cases `fcm.googleapis.com`/`android.googleapis.com` and documents no host set.
  An exact list would break browsers/regions not on it (e.g. numbered WNS hosts, new providers), and a suffix
  list would be exactly the broad invented allowlist we avoid. The connect-time check needs no list and covers
  every provider.
- *What stays at subscribe time:* only shape checks (https, no credentials, default port, no IP literal in any
  spelling, no localhost/internal-style names). IP literals bypass DNS so they must stay rejected there; the agent
  guards names. The two layers are tested separately (`tests/pushNetworkGuard.test.ts`, `tests/pushRoutes.test.ts`).
- Not supported: `web-push`'s `proxy` option (it replaces the agent) and an `HTTPS_PROXY` in the delivery path;
  neither is used. Adding one would require re-establishing this guard at the proxy.

**Known limitations / follow-ups.**
- An attacker-controlled public hostname is still accepted at subscribe time and the relay will POST (a fixed,
  encrypted payload, blind) to whatever *public* server it names; only inward (private/internal) targets are
  blocked. Limiting delivery to known push services would need the allowlist this design deliberately avoids.
- Stored subscriptions are not re-shape-validated at relay time (the connect-time guard does apply to them); legacy entries over the new bound stay until the
  next new subscription trims them.
- Dedup is by exact endpoint string (hostname case variants of one endpoint are separate entries, bounded by
  the cap of 10).
- `subscribe`/`unsubscribe` have no rate limiter (Issue #23 left them out); they are now bounded by
  validation and the per-user cap.
- The concurrency and bound behaviour is tested against an in-memory model that emulates only the exact
  operations used and forces interleaving; MongoDB's own operator semantics (`$` positional update, `$ne` on
  an array path, `$push` + `$slice`) are not exercised until the Mongo-backed suite can run.

## Session Invalidation After Password Reset (Issue #27)

**Invariant.** After a successful password reset, every JWT issued before it is refused (`401`, the same body
as any other bad token). Only a token from a login *after* the reset works. No session is exempt: the reset is
unauthenticated (email + 6-digit code) and issues no token, so there is no session performing the reset to
preserve. The reset code is single-use even when two requests race with it.

**Model.** Still a stateless 7-day JWT sent as a Bearer header (no cookies, refresh tokens or session
collection). `User.tokenVersion` (integer, default 0) is the account's session generation; every token carries
the generation it was issued under as the `tv` claim.

| Moment | What happens |
|---|---|
| register / login | Token is signed with `tv = user.tokenVersion ?? 0`, taken from the **same read** that authenticated the caller |
| every protected request | `requireAuth` verifies the signature, then loads `tokenVersion` (`findById().select().lean()`) and accepts only if `(tv ?? 0) === (account.tokenVersion ?? 0)` |
| reset | One atomic `updateOne` filtered on `{email, resetPasswordTokenHash, resetPasswordExpiresAt > now}` that sets the new `passwordHash`, clears the code, **`$inc`s `tokenVersion`** and empties `pushSubscriptions`. `matchedCount !== 1` -> `400 Reset code is invalid or expired` |
| logout | Unchanged: client-side only (`clearAuth()`). There is no server logout; a token stays valid until the version changes or it expires |

**Rules that matter.**
- *The conditional update is the only authority.* The `exists()` read before it is a cost guard (skip bcrypt
  for an obviously wrong code) and decides nothing; code expiry, code consumption, the password change and the
  revocation succeed or fail together. Two simultaneous resets with one code: exactly one `200`, one `400`, one
  version bump.
- *Legacy compatibility, no migration.* A token with no `tv` and an account with no `tokenVersion` both read as
  `0`, so nothing signs anyone out on deploy. A legacy account's first reset takes it from absent to `1`
  (`$inc` creates the field), which kills its old tokens.
- *A login that straddles a reset fails closed.* It signs the version it read; if a reset committed in between,
  that token is already stale and the first request with it is a `401`. No locking around login.
- *One response for every rejection* (stale version, forged or expired token, malformed `tv`, deleted
  account): `401 { message: 'Invalid or expired token' }`. A missing header keeps its own `401 Authorization
  token is required`. A malformed `tv` (not a non-negative integer) is refused before any database read.
- *Fails closed.* If the lookup fails, the request is refused (`500 Internal server error`), never let
  through. An id that is not a valid ObjectId (`CastError`) is a bad token (`401`). A token for an account that no
  longer exists is a `401` (previously it passed).
- *Push subscriptions are part of the old session state.* A device registered under it would otherwise keep
  receiving the owner's reminders after the reset. Legitimate devices re-register by themselves: the dashboard
  calls `subscribePush()` on mount when notification permission is granted.

**Cost.** One indexed `_id` read with a one-field projection per authenticated request (previously none).
This is inherent to revoking stateless tokens; it is deliberately not cached, because a cache would reopen
the window the invariant closes.

**Client.** The existing 401 interceptor already clears auth and redirects to `/login`. The extra fix is in
`offline/queueProcessor.ts`: it used to treat every 4xx except 408/429 as permanent and discard the entry, so a
revoked token on reconnect wiped the whole offline queue (the interceptor clears the token on the first 401,
and every later entry then went out unauthenticated and was discarded too). Now a 401 stops the run and keeps
that entry and everything not yet attempted, in order; the queue syncs after the next login. History sync
already treated 401 as retryable.

**Keeping a queue means keeping it with its owner.** Requests carry whatever token is current, so a queue that
survives a forced sign-out must never be sent by the next account to sign in on that browser. The queue is
therefore stored per account under `sync_queue:<userId>` (the same convention as history, Issue #31): there is
no way to read or write a queue without naming whose it is, so isolation holds by construction rather than by a
filter that could be forgotten.
- `enqueueSyncAction` binds the owner when the action is *made*, not when the write eventually runs; with nobody
  signed in it rejects instead of queuing an unowned action.
- `processSyncQueue` binds the **session** — the owner *and* the token they are signed in with — at the start
  and uses the owner for every read and write, including the final write-back after a 401, when the interceptor
  has already signed everyone out.
- *The credential is bound to the request, not just checked beforehand.* A check such as "is the owner still
  signed in?" before calling the service is a time-of-check/time-of-use race: the service builds the request a
  moment later and (for ordinary callers) reads whichever token is current *then*, so an account switch landing
  in that gap would have sent A's queued mutation with B's token. Every queue request therefore carries
  `{ session }` (`taskService.create/update/deleteTask(…, { session })`), and the request interceptor in
  `services/api.ts` verifies the store against it and applies **the bound token** in one synchronous step — no
  `await` sits between "verified" and "header set". If the signed-in account or token is no longer the bound
  one it rejects with `SessionChangedError` and nothing is sent; the processor stops and keeps that entry and
  everything not yet attempted for the owner. Requests made without a session behave exactly as before. The
  per-iteration check in the processor is only an early exit; the interceptor is the guard.
- If the account changes while a request is in flight, that request has already left as the owner and is done;
  its result is not fed into the new account's screen or task cache (the `onTask…` callbacks are skipped), and
  no further entry is sent.
- Another account signing in processes only its own queue; the first account's entries wait for it.
- *Legacy:* the old single `sync_queue` key recorded no owner and cannot be attributed (a different account may
  have signed in since), so it is never read, sent or assigned to anyone. It is removed once, with a console
  warning that says how many actions were discarded. This is the same rule history used; a pending offline
  change made before this deploy is lost, which is the price of never guessing an owner.

**Known limits.**
- A request that already passed `requireAuth` when the reset committed runs to completion (bounded by that one
  request); the next request is refused.
- Password reset is the only revocation boundary. Anything that later changes the password (a
  change-password endpoint) must perform the same atomic `$inc`.
- The task cache (`offline/cache.ts`, key `tasks`) is still one global IndexedDB key, so until the next
  account's first fetch replaces it a browser can briefly show the previous account's cached tasks, including
  tasks created offline. Unchanged and out of scope; the queue no longer shares that problem.
- `enqueueSyncAction` needs `useAuthStore.user` (not just a token) to know whose queue to use, like history. If
  the stored user record were corrupt while the token is valid, creating a task offline fails loudly instead of
  being queued unowned.
- Express is 5.x (5.2.1), so a rejected promise from the async `requireAuth` is forwarded to the error handler
  (500) rather than hanging; `requireAuth` also handles its own lookup errors explicitly.
- Settings -> "Change password" sends a signed-in user to `/forgot-password`, which redirects authenticated
  users to the dashboard (unchanged, out of scope).

**Tests.** `tests/sessionInvalidation.test.ts` (Mongo-independent, real app, in-memory `User` double with
snapshot reads, an atomic conditional `updateOne`, and gates for the double-reset and login-straddles-reset
interleavings); real-MongoDB round trip in `tests/api.routes.test.ts` (needs `mongodb-memory-server`'s
downloaded binary); client `offline/queueProcessor.test.ts` (401 handling and cross-account isolation
against the real per-account storage and auth store), `offline/queueProcessor.credentials.test.ts` (the real
task service and API client against a recording adapter: which token each queued create/update/delete actually
carries, and that a switch of account or token between the ownership check and the request, or while it is in
flight, sends nothing as the wrong account) and `offline/syncQueue.test.ts` (storage isolation, owner binding,
legacy purge). The history, AI, push and rate-limit route
suites mint legacy-shape tokens (no `tv`) and stub the version lookup at 0, which doubles as coverage that
legacy tokens keep working.

## API Security Headers (Issue #28)

The API sends a small, deliberate set of browser-hardening headers from `src/middleware/securityHeaders.ts`
(no Helmet, no new dependency; a generic Helmet config would have had most of its defaults switched off anyway).
Express/API only: the client is served by Vercel, and its security headers (`vercel.json`, a client CSP) are a
**separate concern** and a separate future issue.

| Header | Value | Sent |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | always |
| `Referrer-Policy` | `no-referrer` | always |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | always |
| `X-Frame-Options` | `DENY` | always |
| `Strict-Transport-Security` | `max-age=15552000` | only when `NODE_ENV === 'production'` |

`app.disable('x-powered-by')` removes `X-Powered-By: Express`.

**Order matters.** `app.use(securityHeaders())` is the first middleware, before `cors()`. `cors()` answers a
preflight itself and never calls `next()`, so headers mounted after it would be missing from the preflight 204.
Placed first, every response carries them: normal, preflight, 401/400/404/413/429 and the 500 from the error handler.
The middleware touches no other header and never ends the request, so CORS, ETag/304 and bodies are unchanged.

**Why the choices.**
- *CSP is intentionally minimal and inert.* The API returns JSON, an empty 204 and one tiny `text/html` string
  (`GET /`). It renders and loads nothing, and CSP does not apply to `fetch` responses, so the policy only restricts
  that one HTML response ("nothing may load or embed this"). A script/style policy would protect nothing here: the
  pages that run script are served by the client's host, which this header cannot reach.
- *`X-Frame-Options` is a compatibility fallback* for browsers that ignore `frame-ancestors`.
- *HSTS is production-only* (local development is plain HTTP). It is not gated on `req.secure`, because TLS is
  terminated upstream (Render/Railway) and `req.secure` depends on `TRUST_PROXY_HOPS`, so it cannot be trusted to
  say "this is HTTPS". It is emitted unconditionally in production.
- *`includeSubDomains` and `preload` are omitted on purpose:* the API lives on a shared platform domain, where they
  are meaningless or risky, and both are hard to undo. 180 days is the chosen lifetime.
- *`Cache-Control` is not part of this issue.* It would change caching behaviour rather than harden headers; the
  existing ETag/304 behaviour is preserved (and tested).
- *Not added:* COOP/COEP/CORP, `X-XSS-Protection`, `Permissions-Policy`, `X-DNS-Prefetch-Control`,
  `X-Download-Options`, `Origin-Agent-Cluster` (irrelevant to a JSON API, deprecated, or a risk to legitimate
  cross-origin use that CORS already governs).
- CORS is unchanged, including the fail-closed production fallback and `credentials: true`.

**Tests.** `tests/securityHeaders.test.ts` covers exact values, nothing extra, and HSTS by `NODE_ENV`.
`tests/securityHeadersRoutes.test.ts` imports the real `src/app.ts` (only models and web-push mocked) and asserts the
headers on GET /, 404, the CORS preflight (the regression guard for the placement), 401, malformed-JSON 400,
413, 429 (with `Retry-After`), 500 and an authenticated 200, under production, development and unset `NODE_ENV`.
After a deploy, confirm with `curl -sI https://<api-host>/` (HSTS present, no `X-Powered-By`).

## MongoDB Connection and the DNS Fallback (Issue #20)

**Flow.** `server.ts` checks `JWT_SECRET`/`MONGO_URI` are present, validates every MongoDB setting with
`getMongoConfig()` (`config/env.ts`), registers the crash handlers, then awaits `connectDB()`
(`config/db.ts`) **before** `app.listen`. A failed connection exits non-zero via `exitWithFatalError`; there is
no retry loop (the platform restarts the process), and Mongoose buffering/reconnect settings are the defaults.

**Settings** (all validated before any DNS or network work; error messages never contain `MONGO_URI` or its credentials; the timeout and DNS-server errors do quote the offending value, which is a number or an IP-shaped string):

| Variable | Meaning |
|---|---|
| `MONGO_URI` | required; must start with `mongodb://` or `mongodb+srv://` |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | optional; whole ms, 1000–120000, default **15000** (was the driver's implicit 30000 per attempt) |
| `MONGO_DNS_SERVERS` | optional; comma-separated literal IPs (`ip`, `ipv4:port`, `[ipv6]:port`) for the SRV fallback; unset, empty or whitespace-only → `8.8.8.8,1.1.1.1`; a separator with no entries (`,` or ` , `) is the explicit way to disable the fallback |

**Why the DNS fallback exists — do not remove it as "cleanup".** On some hosts the platform resolver refuses SRV
queries (`querySrv ECONNREFUSED`), so a `mongodb+srv://` Atlas URI cannot be resolved and the app cannot start,
although the same URI works through a public resolver. On exactly that error (SRV URI, `code ECONNREFUSED`,
`syscall querySrv`) `connectDB` retries **once** with the fallback resolvers. Other errors (ENOTFOUND, ETIMEOUT,
server selection, auth, direct URIs) are rethrown unchanged.

**`dns.setServers()` is process-wide.** It changes the resolver for every `dns.resolve*` caller in the Node
process, not for one connection. The code therefore fences it in:
- applied only for the single fallback attempt, with the original servers captured immediately before and restored
  in `finally` whether the attempt succeeds, fails or throws; a failed restore is logged as CRITICAL and never
  replaces the real error;
- never overlapped: concurrent `connectDB()` calls share one in-flight attempt. (Before, a second overlapping call
  would have captured the *fallback* servers as "the originals" and could have left them installed permanently.)
  An attempt that settles clears the slot, so a later call retries normally; an already-connected call is a no-op;
- confined to startup: `connectDB()` is awaited before `app.listen`, so no request handler runs during the window
  (at most one server-selection timeout). Keep it that way; do not call it from a request path.
Established connections use `getaddrinfo` (`dns.lookup`), which `setServers()` does not affect. Known limit: the
driver re-resolves SRV records only for sharded topologies (every 60 s); after the override is restored such a
re-resolution would use the platform resolver again. A private `dns.Resolver` (no global mutation) would remove the
process-wide side effect entirely but means resolving SRV/TXT ourselves and building the direct URI — a larger change,
deliberately not done here.

**Also in this change.** Success is confirmed from `mongoose.connection.readyState === 1` (a probe showed two
overlapping `mongoose.connect()` calls where one settled and logged "connected" at `readyState` 0). Logging names only
the path (SRV / direct / SRV via fallback DNS), the timeout and an error's name/code — never the URI, host, user or
password. The final fatal log (`exitWithFatalError`) still prints the driver error object as before; in the cases
probed it contains the SRV hostname but no credentials.

**Tests (no Atlas, DNS or network).** `tests/mongoConfig.test.ts` (validation) and `tests/mongoConnection.test.ts`
(`connectDB` with injected `connect`/`getDnsServers`/`setDnsServers`/logger: normal path and timeout option,
validation-before-network, fallback selection, DNS install/restore ordering on success, failure, a throwing install
and a throwing restore, 6 failing startups in a row, concurrent callers, the readyState check, secret-free logs, and
one test against the real `node:dns` state). Not covered because it needs real infrastructure: an actual Atlas
connection, a real refused-SRV resolver, and `server.ts` itself (it runs on import); `tests/api.routes.test.ts`
still needs MongoMemoryServer's binary.

## Request Boundaries and Auth Types (Issue #21)

**Principle.** A TypeScript cast is not a runtime check. Two places used to rely on one: the JWT payload
(`jwt.verify` result cast to a claims type) and `req.body` (destructured with `as`). Both are now checked at
runtime, with small functions rather than a validation framework.

**JWT payload** (`utils/authToken.ts`). `parseTokenPayload(decoded)` returns the claims or `null`: the payload
must be a plain object; `userId` a non-empty string; `email` and `name` strings; `tv` absent (counts as 0) or a
non-negative integer (`null`, strings, fractions and negatives are rejected). Extra claims are ignored.
`requireAuth` calls it right after `jwt.verify` and **before** the `tokenVersion` database read; a rejected
payload gets the same generic `401 Invalid or expired token` as any other bad token. `JWT_ALGORITHM` (`HS256`)
is used by both `jwt.sign` (auth controller) and `jwt.verify` (`algorithms: [JWT_ALGORITHM]`), so `alg: none` and
other algorithms are refused. The scheme match stays case-sensitive (`Bearer `); lowercase is a 401.

**`AuthenticatedRequest` and `authenticated()`** (`middleware/auth.middleware.ts`). Protected handlers declare
`req: AuthenticatedRequest` (`user: { id, email, name }`, non-optional) and are registered as
`router.get('/', authenticated(handler))`. Express's `RequestHandler` takes a plain `Request`, so the adapter does
the narrowing with a runtime check; if a protected route is ever wired without `requireAuth` it answers
`401 Authorization token is required` and the handler does not run. The global `req.user` stays optional because
public routes exist. The guard checks the whole `AuthenticatedUser` shape (non-empty string `id`, string `email`, string `name`).
Every protected handler, including the AI one (which does not read `user` yet), takes `AuthenticatedRequest`, so a
handler left unwrapped is a compile error.

**Request bodies** (`utils/requestBody.ts`). `isPlainObject`, `BODY_MUST_BE_OBJECT` and
`readRequiredStrings(body, keys, { required, notStrings })`. Express 5 leaves `req.body` undefined with no JSON
body (a destructuring cast then threw a 500). Register, login, forgot-password, reset-password, task create/update
and tree PATCH now answer `400 Request body must be a JSON object.` for a missing/array/primitive body, and the
four auth handlers answer `400 ... must be strings` for non-string fields. Existing "required" messages are
unchanged. The three validators that carried private `isPlainObject` copies import the shared one. This is the
whole abstraction: it has seven-plus real call sites, and no schema library was added.

**Test configuration.** `tests/testConfig.ts` exports `TEST_JWT_SECRET`, an unmistakably fake `TEST-ONLY` value
used by the suites that sign tokens. It is not a template for production: `.env.example` leaves `JWT_SECRET`
blank, and `tests/testConfig.test.ts` fails if anything under `src/` imports `tests/` or contains the secret.

**Tests.** Mongo-free suites: `authToken`, `requestBody`, `authBoundary`, `taskRoutes`, `bodyBoundaries`,
`authInput`, `testConfig`. `api.routes.test.ts` still uses `MongoMemoryServer` and needs the binary download.

**Intentionally unchanged.** Reset-code lifetime, hashing and storage; rate limits; task field validators;
pagination; demo-mode reset-code logging (it is not gated on `NODE_ENV`; noted, out of scope).

## Server Lifecycle, CORS, and Request Limits (Backend)

The server's startup, shutdown, CORS, and request-body-size behavior is
deliberately explicit rather than left to Express/Node defaults:

- `src/server.ts` validates required env vars (`JWT_SECRET`, `MONGO_URI`),
  the MongoDB settings (see "MongoDB Connection and the DNS Fallback") and `RESET_TOKEN_TTL_MINUTES` before starting, and exits non-zero via
  `exitWithFatalError()` (in `src/utils/processLifecycle.ts`) on failure —
  including when `connectDB()` itself fails, via an explicit
  `startServer().catch(...)` rather than relying on the generic
  `uncaughtException`/`unhandledRejection` handlers to catch it.
- SIGTERM/SIGINT are handled by `createGracefulShutdown()` (same file):
  stop accepting new connections and let in-flight requests finish, then
  close the Mongoose connection, then exit 0. A 10s unref'd force-exit
  timer is a safety net if closing hangs; a second shutdown signal while
  one is already in progress is a no-op rather than double-running the
  sequence.
- CORS origin resolution lives in `src/config/cors.ts` (`resolveOrigin()`):
  `CLIENT_ORIGIN` set → used as-is. Unset in development → falls back to
  the fixed localhost dev ports. Unset in production → returns `false`
  (rejects all cross-origin requests) — missing config can never silently
  become permissive/wildcard.
- `express.json({ limit: '1mb' })` bounds request body size. The global
  error handler in `src/app.ts` checks `src/utils/httpErrors.ts`'s type
  guards first, so an oversized body returns 413 and malformed JSON
  returns 400 — both correctly, instead of falling through to a generic
  500 (body-parser already knows the right status; the handler just has
  to not discard it).
- Covered by `tests/processLifecycle.test.ts`, `tests/cors.test.ts`,
  `tests/httpErrors.test.ts` (pure unit tests, no DB) and
  `tests/httpBoundary.test.ts` (supertest against a minimal app built
  from the same middleware/resolver, avoiding the Mongoose
  model-registration issue that comes from re-importing `src/app.ts`
  under different env vars in the same test run).

## Documentation System

The main documentation index is:
- `docs/HaloTaskPro-Documentation-Index.md`

Important docs:
- `docs/logs.md` - human-readable changelog
- `.logs` - machine-readable changelog
- `docs/HalotaskPro-Client-UpgradePlan.md` - live client-side upgrade backlog
- `docs/server_upgrade_plan.md` - server-side upgrade notes
- `docs/ops/` and `docs/product/` - retained reference content and planning docs

The changelog workflow is:
- update `.logs`
- sync the same event into `docs/logs.md`

## Recent Completed Work

Recent feature and fix work that is already committed:
- Added protected dashboard subpages for insights, reminders, and settings
- Replaced the settings stub with a full adaptive theme settings page
- Added the Growth Tree orb/sheet behavior
- Added mobile task create sheet behavior
- Fixed offline deletion sequencing so queue writes happen before UI mutation
- Hardened auth token handling and request behavior
- Improved accessibility across several components
- Updated dashboard layout and desktop nav spacing
- Fixed dashboard grid structure and responsive spacing
- Added or expanded logging for completed work batches

## Known Working Constraints

Important practical constraints:
- Run npm commands from `d:\Desktop\College\PROJECT\HaloTaskPro\halotasks-client`
- Running npm from the workspace root fails because there is no package.json there
- Vite dev server can shift ports if the default is busy
- Build validation has been successful after the recent UI updates

## Verified Commands

Successful validation has included:
- `npm run build` in `halotasks-client`

`npm run verify` (repo root, `package.json`) runs `halotasks-client`'s `verify` (`test` then `build`) and then
`halotasks-server`'s `verify` (`test`, `typecheck`, `typecheck:tests`, `build`), stopping at the first failing
step with a non-zero exit. Each package owns its own `verify`; nothing about the underlying scripts changed
(`halotasks-server`'s `typecheck` is new: `tsc -p tsconfig.json --noEmit`). The server `test` script is still
plain `vitest run`, so it includes `tests/api.routes.test.ts`, which needs `mongodb-memory-server` to download a
MongoDB binary; in environments where that download is blocked (e.g. the sandbox used for development) `verify`
correctly fails at that suite. Nothing was excluded or skipped to hide it.

## Current Implementation Notes

If future work touches these areas, keep the current behavior in mind:
- Settings page should remain thin and use the shared theme/auth stores
- Route additions should preserve the `ProtectedRoute -> AppLayout` pattern
- Offline mutations should not remove UI state before queue writes succeed
- Growth orb behavior should preserve desktop tooltip fallback
- Changelog updates should be written in both `.logs` and `docs/logs.md`

## Repository Memory Notes

A compact repository memory note has been saved for future assistance with:
- project location
- client structure
- route layout
- theme system
- offline architecture
- logging convention
- recent validation state

## Suggested Maintenance Rules

When adding new features:
- Prefer the existing store/hook architecture
- Keep UI changes aligned with the current theme tokens and global CSS conventions
- Add routes through the shared app shell and protection pattern
- Update logs after meaningful feature or bugfix batches
- Validate with a build after significant frontend changes

## High-Level Purpose

HaloTaskPro is not just a task list. It is designed around:
- fast task capture
- reliable offline operation
- visible progression through the Growth Tree
- responsive dashboard UX
- practical reminder support
- secure authentication and recovery

The project should continue to optimize for execution, not just task storage.
