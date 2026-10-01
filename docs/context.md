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
- In-memory cache records its owner. `getTreeState()` never returns another user's cache (returns initial state instead); `setTreeState()` throws `TreeIdentityError` unless `initTreeStorage()` has completed for the current user.
- `initTreeStorage()` throws `TreeIdentityError` when no user is authenticated, and discards its result (no cache write, no IndexedDB write, no server push) if the authenticated user changes while it is awaiting local or server state. Callers must handle the rejection (`useDashboardGrowth` and `InsightsPage` both do: log and show no tree).
- Merge rules (higher XP wins, union of `awardedTaskIds`) are unchanged and now only ever combine one user's local record with that same user's server record.
- `clearAuth()` deliberately does not clear Growth Tree state. Owner-scoped keys and cache already prevent cross-user reads, and wiping on logout or 401 would destroy the previous user's unsynced offline progress. Consequence: a user's tree record remains in that browser's IndexedDB until they log in again or `clearTreeState()` is called.

Legacy unscoped data decision: the old global IndexedDB key `growth_tree` and localStorage key `halotask:growth_tree` recorded no owner, so they are never read or migrated to whichever user logs in next. `initTreeStorage()` deletes both. The server copy (whatever was successfully synchronized) is the recovery path for the real owner; progress that was never successfully synchronized under the old code is lost.

## Offline Architecture

The app is built to tolerate network interruption.

Core offline pieces:
- `offline/cache.ts` - cached auth/task data helpers
- `offline/db.ts` - IndexedDB wrapper
- `offline/network.ts` - network helpers
- `offline/syncQueue.ts` - queued write actions
- `offline/queueProcessor.ts` - replay and retry logic

Important offline behavior:
- Tasks can be cached and replayed later
- Write actions are queued when offline
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
- A global 401 response interceptor redirects to login
- `ProtectedRoute` is the main guard for authenticated views

Auth store data:
- `token`
- `user`
- `setAuth()`
- `clearAuth()`

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
  model, endpoint, temperature and `max_tokens` are server constants (`utils/groqClient.ts`) and cannot be
  chosen by a caller. Validation runs **before** the provider is contacted.
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
  is bounded by authentication, the prompt cap, `max_tokens` and the timeout. Per-user/IP limiting is the
  dependency on **Issue #23**.
- Prompt "today" is the server's UTC date (the browser previously used the UTC date too).

## Server Lifecycle, CORS, and Request Limits (Backend)

The server's startup, shutdown, CORS, and request-body-size behavior is
deliberately explicit rather than left to Express/Node defaults:

- `src/server.ts` validates required env vars (`JWT_SECRET`, `MONGO_URI`)
  and `RESET_TOKEN_TTL_MINUTES` before starting, and exits non-zero via
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