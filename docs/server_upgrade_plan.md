# Additional Missing Client Issues

This document captures the remaining client-side observations that should be merged into the upgrade plan. The items are grouped by priority so the next refinement pass can focus on the highest-risk consistency issues first.

## Priority Order

### High Priority
1. UTC/local date consistency
2. `completedAt` implementation
3. auth clock-skew buffer
4. description edit parity

### Medium Priority
1. transient vs persisted state split
2. tag-limit synchronization
3. upcoming/due-today overlap cleanup

### Low Priority
1. helper naming cleanup
2. reducing array passes

---

## P1 Issues

### 58. `utils/dateHelpers.ts`

Priority: P1  
Category: Date Consistency / UX Integrity

#### Issues
- `formatDateForInput()` uses UTC date formatting.
- `getDateBadgeClass()` uses local timezone logic.
- This can make the same task appear as different days in edit forms versus task cards for non-UTC users.

#### Risks
- Inconsistent scheduling behavior
- User distrust
- Broken reminder expectations

#### Recommended Fix
Standardize all user-facing task dates to local timezone handling. Avoid `toISOString()` for local scheduling UX unless UTC behavior is explicitly intended.

### 60. `utils/taskInsights.ts`

Priority: P1  
Category: Analytics Correctness / Performance

#### Issues
- `getCompletedToday()` relies on `updatedAt` instead of a dedicated `completedAt`.
- `getUpcomingTasks()` includes today tasks, overlapping with `Due Today`.
- `getEstimatedWorkload()` performs multiple array passes unnecessarily.

#### Risks
- Any edit today can be treated as task completion today.
- Growth, streak, and stats semantics become unreliable.

#### Recommended Fix
Add a dedicated `completedAt?: string` field and set it only when completion transitions from `false -> true`. Ensure `Due Today` and `Upcoming` are mutually exclusive. The array-pass optimization can wait until larger datasets exist.

### 62. `useDashboardSync.ts`

Priority: P1  
Category: Offline Reliability / Sync Integrity

#### Issues
- Queue replay can potentially run concurrently if reconnect, manual retry, and background sync happen together.
- No explicit replay mutex/lock is documented.

#### Risks
- Duplicate replay attempts
- Race conditions
- Inconsistent pending-state cleanup
- Repeated API writes

#### Recommended Fix
Add a replay guard such as `if (isReplayingRef.current) return;` and wrap replay lifecycle in `try/finally` so the lock is always released.

### 64. `authStore.ts`

Priority: P1  
Category: Session Integrity

#### Issues
- Auth persistence appears split across localStorage, auth utilities, dashboard redirects, and startup checks.
- No single canonical hydration flow is documented.

#### Risks
- Stale token persistence
- Redirect flicker
- Partial logout states
- Races between hydration and route guards

#### Recommended Fix
Introduce an explicit boot lifecycle such as `authStore.hydrate()` that centralizes token validation, known-user restoration, expiry handling, and logout cleanup.

---

## P2 Issues

### 57. `utils/authSession.ts`

Priority: P2  
Category: Auth Consistency / Session Reliability

#### Issues
- No clock-skew buffer on JWT expiry checks.
- `markKnownUser()` and `isKnownUser()` are utility concerns that belong closer to auth persistence or store logic.
- Missing documentation clarifying that frontend JWT checks are expiry-only convenience checks, not cryptographic validation.

#### Risks
- Premature logout
- Redirect flicker
- Inconsistent auth behavior between client and server clocks

#### Recommended Fix
Add a small skew allowance such as `const CLOCK_SKEW_MS = 30_000;` and compare against `Date.now() + CLOCK_SKEW_MS`. Move known-user persistence helpers into `authStore` or a dedicated auth persistence module. Add a comment explaining that client-side JWT checks are UX hints only.

### 59. `utils/tagHelpers.ts`

Priority: P2  
Category: Validation Consistency / Utility Clarity

#### Issues
- `MAX_TAGS` may drift from backend schema limits.
- `toTitleCase()` is misleading if it only capitalizes the first letter.
- `tryAddTag()` does not distinguish success, duplicate ignored, or max-limit rejection.

#### Risks
- UI may accept tags that the server rejects
- Confusing feedback for users

#### Recommended Fix
Centralize shared constraints between client and server. Rename `toTitleCase` to `capitalizeFirst` if that matches the implementation. Refactor `tryAddTag()` to return a discriminated result such as:

```ts
type AddTagResult =
  | { added: true; tag: string }
  | { added: false; reason: 'duplicate' | 'max' };
```

### 61. `components/dashboard/types.ts`

Priority: P2  
Category: State Architecture / Form Consistency

#### Issues
- `tagInput` transient UI state is mixed into persisted `TaskEditState`.
- `dueDate` format assumptions are undocumented.
- `description` exists in the create flow but cannot be edited.

#### Risks
- More mutation confusion
- More complex serialization logic
- Future sync bugs
- Inconsistent CRUD behavior

#### Recommended Fix
Separate transient UI state from persisted edit state. Example:

```ts
type TaskEditState = {
  title: string;
  description?: string;
  dueDate?: string;
};

type TaskEditUiState = {
  tagInput: string;
};
```

Add description editing support to match create behavior, and document that `dueDate` is stored as `YYYY-MM-DD`.

### 63. `useDashboardGrowth.ts`

Priority: P2  
Category: Domain Consistency / Growth Integrity

#### Issues
- Growth XP awards are coupled directly to UI completion flows.
- Future server reconciliation, task imports, or external edits could cause XP drift.

#### Risks
- Duplicated XP
- Lost streaks
- Inconsistent growth state across devices

#### Recommended Fix
Centralize completion transition detection, such as `previous.completed === false && next.completed === true`, into a dedicated growth event utility. This keeps the system ready for server-authoritative growth later.

### 65. `TaskCard.tsx`

Priority: P2  
Category: Rendering Stability / Accessibility

#### Issues
- Interactive controls are likely nested inside a clickable card container.
- Event bubbling may cause unintended interactions.

#### Risks
- Users may open edit accidentally
- Selection may trigger unintentionally
- Tag clicks may toggle the task

#### Recommended Fix
Use `event.stopPropagation()` on nested controls where needed, and keep keyboard navigation, focus outlines, and ARIA labels intact.

### 66. Notification Scheduling Drift

Priority: P2  
Category: Reminder Accuracy

#### Issues
- The reminder scheduler appears to rely on session-time browser timers.
- Browser notifications depend on active-tab behavior and timer throttling.

#### Risks
- Missed reminder windows
- Delayed notifications
- Suppressed background intervals

#### Recommended Fix
Document the limitation explicitly. Consider a future Service Worker + Push API approach or server-side scheduled reminders.

### 67. Offline Queue Storage Growth

Priority: P2  
Category: Storage Management

#### Issues
- Queue persistence has no documented max size.
- There is no stale cleanup or corruption recovery strategy.

#### Risks
- IndexedDB bloat
- Slower hydration
- Replay of obsolete actions

#### Recommended Fix
Add a max queue cap, timestamp expiry, corrupted-entry pruning, and queue diagnostics logging.

### 69. Smart Sections + Sorting Interaction

Priority: P2  
Category: UX Consistency

#### Issues
- Dashboard insights and main task sorting/filtering are partially independent.
- Smart sections can show overdue counts while the main list is hidden by active filters.

#### Risks
- Users may think tasks are missing
- The dashboard can feel inconsistent

#### Recommended Fix
Add a contextual hint such as `Some tasks may be hidden by active filters.` or provide a quick reset action.

### 70. Missing Central Error Taxonomy

Priority: P2  
Category: Reliability / UX

#### Issues
- Error handling is spread across sync, auth, queue, IndexedDB, and API layers.
- There is no normalized error model.

#### Risks
- Some errors are silent
- Some errors are too verbose
- Retry behavior is inconsistent
- Logging severity varies by feature

#### Recommended Fix
Introduce a shared error model such as:

```ts
type AppError =
  | AuthError
  | SyncError
  | ValidationError
  | OfflineError;
```

Each error should carry a user message, retryability flag, and logging level.

---

## P3 Issue

### 68. `GrowthTree` Rendering Model

Priority: P3  
Category: UI Consistency

#### Issues
- Tree visuals are derived entirely from local XP thresholds.
- Future balancing changes could invalidate older visual states.

#### Risks
- Threshold changes may visually regress existing users
- Perceived progression can drift over time

#### Recommended Fix
Persist a `growthVersion` value or abstract stage calculation into a migration-safe utility.

---

## Strategic Observation

The app is moving from feature coordination into state orchestration. The primary engineering risk is no longer missing functionality. It is behavioral divergence between interconnected systems.

Offline sync, reminders, growth, filters, auth hydration, and optimistic UI are now influencing one another. That is the right kind of complexity, but it needs tighter consistency boundaries before the plan ossifies.
