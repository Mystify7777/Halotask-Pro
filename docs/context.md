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
- A global 401 response interceptor redirects to login
- A 401 is not a reason to discard queued offline work: `offline/queueProcessor.ts` stops at the first 401 and keeps that entry and every entry after it, in the owning account's own queue (see "Session Invalidation"); other permanent 4xx still discard the one entry
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
The #22 protections (prompt cap, `max_tokens`, 20 s timeout) are unchanged and not duplicated.

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