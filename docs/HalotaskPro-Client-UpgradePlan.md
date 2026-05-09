# Halotask Pro — Client-Side Upgrade Plan
`halotasks-client` · Code Review v1.0 · May 2026

---

## How to Read This Document

| Badge | Meaning |
|---|---|
| 🔴 **CRITICAL** | Fix before any real users touch this. Data loss, silent failures, or broken core flows. |
| ⚠️ **IMPROVE** | Should be done in the next sprint. Quality, maintainability, or UX gaps. |
| 💡 **POLISH** | Nice-to-have. Developer experience or future-proofing. |

**Phases:**
- **P1 — Before Deploy:** All 🔴 items. Non-negotiable.
- **P2 — Next Sprint:** All ⚠️ items. Important for long-term health.
- **P3 — Ongoing:** All 💡 items. Pick as capacity allows.

---

## At-a-Glance Status

| File / Group | 🔴 Critical | ⚠️ Improve | Effort |
|---|---|---|---|
| `types/task.ts` + `auth.ts` | 1 | 3 | 1h |
| `services/api.ts` | 1 | 3 | 2h |
| `services/authService.ts` + `taskService.ts` | 0 | 2 | 1h |
| `store/authStore.ts` | 1 | 2 | 1–2h |
| `hooks/useDashboardTasks.ts` | 1 | 3 | 3–4h |
| `hooks/useDashboardSync.ts` | 1 | 2 | 2–3h |
| `hooks/useDashboardGrowth.ts` | 0 | 2 | 1h |
| `hooks/useTaskFilters.ts` | 1 | 1 | 30min |
| `hooks/useTaskSorting.ts` | 0 | 2 | 1h |
| `hooks/useTaskSelection.ts` | 0 | 1 | 30min |
| `hooks/useTagSuggestions.ts` | 0 | 2 | 30min |
| Pages (all 5) | 1 | 4 | 2–3h |
| Components (all 11) | 1 | 8 | 3–4h |
| `offline/db.ts` | 1 | 2 | 2h |
| `offline/cache.ts` | 0 | 2 | 1h |
| `offline/network.ts` | 0 | 1 | 30min |
| `offline/syncQueue.ts` | 1 | 2 | 2–3h |
| `offline/queueProcessor.ts` | 1 | 2 | 2–3h |
| `growth/treeLogic.ts` | 1 | 2 | 2h |
| `growth/treeStorage.ts` | 1 | 2 | 1–2h |
| `growth/treeTypes.ts` | 0 | 1 | 30min |
| `reminders/deadlineLogic.ts` | 0 | 2 | 1h |
| `reminders/notification.ts` | 0 | 2 | 1h |
| `reminders/permissions.ts` | 0 | 1 | 30min |
| `reminders/scheduler.ts` | 0 | 2 | 1h |
| `reminders/settings.ts` | 0 | 2 | 1h |
| `utils/` (all 4) | 0 | 3 | 1h |
| **TOTAL** | **13** | **60** | **~35–45h** |

## Completed Since Last Pass

- ✅ `services/api.ts` - shared token source, 10s request timeout, global 401 redirect
- ✅ `store/authStore.ts` - exported shared `TOKEN_KEY`
- ✅ `services/api.ts` - API error normalization helper
- ✅ `store/authStore.ts` - token expiry check on init and safe user restore
- ✅ `hooks/useTaskFilters.ts` - null-safe description search
- ✅ `pages/ResetPasswordPage.tsx` - cleaned redirect timer, fixed token input to 6 digits
- ✅ `pages/LoginPage.tsx` + `pages/RegisterPage.tsx` - trimmed auth emails
- ✅ `hooks/useRedirectIfAuthenticated.ts` - shared authenticated redirect hook
- ✅ `pages/ForgotPasswordPage.tsx` - trimmed email and disabled resubmit after success
- ✅ `components/dashboard/TaskList.tsx` - Set-based selection and better empty state
- ✅ `components/dashboard/GrowthTree.tsx` - static health constants moved outside component and footer fallback added
- ✅ `components/dashboard/TaskCard.tsx` - completion checkbox aria-label added
- ✅ `pages/ForgotPasswordPage.tsx` - reset TTL copy now uses configurable value
- ✅ `components/dashboard/TaskFormFields.tsx` - shared create/edit task fields extracted
- ✅ `components/shared/TagInput.tsx` - listbox/option ARIA roles added

## Next Selected Tasks

1. `components/dashboard/TaskList.tsx` - show distinct zero-task state and filter-empty state everywhere
2. `pages/ForgotPasswordPage.tsx` - disable form after success / reset button text consistency
3. `components/dashboard/TaskList.tsx` - migrate remaining selection/empty-state polish where needed
4. `components/dashboard/GrowthTree.tsx` - keep extracting tiny render helpers when convenient

---

## Phase 1 — Critical Fixes (Do Before Deploy)

### 1.1 Split source of truth for auth token ✅ Completed

**Files:** `store/authStore.ts` + `services/api.ts`

The token key `'halotasks_token'` is a hardcoded string in both files independently. If it's renamed in the store, the Axios interceptor silently stops reading it and every authenticated request fails with a 401 — with no compiler warning.

**Fix — export and import the key:**
```ts
// store/authStore.ts
export const TOKEN_KEY = 'halotasks_token';

// services/api.ts
import { TOKEN_KEY } from '../store/authStore';
const token = localStorage.getItem(TOKEN_KEY);
```

**Better fix — read token from the store directly:**
```ts
// services/api.ts
import { useAuthStore } from '../store/authStore';
axiosInstance.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token; // eliminates localStorage read
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
```

---

### 1.2 Add a global 401 interceptor ✅ Completed

**File:** `services/api.ts`

There is no response interceptor. When a JWT expires, every API call returns 401, but no code handles it globally — the user sees a broken UI with no redirect to login and no indication their session expired.

**Fix — add a response interceptor:**
```ts
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clearAuth();
      window.location.replace('/login');
    }
    return Promise.reject(error);
  }
);
```

---

### 1.3 Add request timeout to Axios ✅ Completed

**File:** `services/api.ts`

No timeout is configured. If the server hangs, Axios waits indefinitely — the UI appears frozen with no feedback.

**Fix:**
```ts
const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000',
  timeout: 10_000, // 10 seconds
});
```

---

### 1.4 Fix offline delete race condition

**File:** `hooks/useDashboardTasks.ts`

In `handleDeleteTask` (offline path), local state is removed **before** the sync action is enqueued. If `enqueueSyncAction` throws (IndexedDB unavailable), the task is lost from the UI, lost from the cache, and never queued for deletion — silently gone.

**Fix — enqueue first, then update state:**
```ts
// WRONG (current):
persistTasks((current) => current.filter(t => t._id !== taskId));
await enqueueSyncAction({ type: 'delete', taskId });

// CORRECT:
await enqueueSyncAction({ type: 'delete', taskId });
persistTasks((current) => current.filter(t => t._id !== taskId));
```

---

### 1.5 Handle expired token on sync failure

**File:** `hooks/useDashboardSync.ts`

When `taskService.getTasks()` returns a 401, the catch block sets `syncStatus` to `'cached'` and shows "Unable to sync latest tasks. Showing cached data." forever. The user is never redirected to login and the token is never cleared. Combined with fix 1.2 (global interceptor), this resolves automatically — but `useDashboardSync` should not swallow 401s if the interceptor is not yet in place.

---

### 1.6 Wrap IndexedDB operations in try/catch

**File:** `offline/db.ts`

Every public method (`offlineDb.get`, `offlineDb.set`, `offlineDb.del`) has no error handling. In private browsing (Firefox blocks IndexedDB entirely), Safari with ITP enabled, or when storage quota is exceeded, `await dbPromise` throws and the entire offline layer crashes rather than gracefully degrading.

**Fix — wrap every method:**
```ts
async get<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const db = await dbPromise;
    const entry = await db.get(storeName, key);
    return entry ? (entry.value as T) : null;
  } catch (error) {
    console.warn('[OfflineDB] get failed:', error);
    return null;
  }
}
```

Apply the same pattern to `set` and `del`.

---

### 1.7 Fix syncQueue race condition

**File:** `offline/syncQueue.ts`

The entire queue is read from IndexedDB, mutated in memory, and written back on every `enqueueSyncAction`. Two rapid offline actions (e.g. toggle + edit within milliseconds) can both read the same initial queue, modify it independently, and the second write overwrites the first — silently dropping a sync action.

**Fix — serialise queue writes with a promise chain:**
```ts
let writeChain = Promise.resolve();

export const enqueueSyncAction = (action: SyncAction): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const queue = await getSyncQueue();
    const updated = coalesceAction(queue, action);
    await saveSyncQueue(updated);
  });
  return writeChain;
};
```

---

### 1.8 Stop swallowing permanent errors in queue processor

**File:** `offline/queueProcessor.ts`

The `catch` block pushes every failed entry back to `remainingQueue` regardless of error type. A 404 (task doesn't exist on server) or 400 (malformed payload) will retry forever — they will never succeed.

**Fix — distinguish permanent vs transient failures:**
```ts
} catch (error) {
  const status = (error as AxiosError)?.response?.status;
  const isPermanent = status && status >= 400 && status < 500;

  if (isPermanent) {
    console.warn('[SyncQueue] Permanent error, dropping entry:', entry, status);
    // don't push to remainingQueue — discard it
  } else {
    remainingQueue.push(entry); // transient — keep for retry
  }
}
```

---

### 1.9 Fix UTC timezone bug in streak tracking

**File:** `growth/treeLogic.ts`

`getTodayDate()` returns the date in **UTC**:
```ts
return today.toISOString().split('T')[0]; // ← UTC date
```

For users in UTC+5:30 completing a task at 12:30am local time (7pm UTC the previous day), `getTodayDate()` returns **yesterday**. Their streak breaks even though they completed a task "today" in their timezone.

**Fix — use local timezone:**
```ts
export const getTodayDate = (): string => {
  return new Date().toLocaleDateString('en-CA'); // returns YYYY-MM-DD in local timezone
};
```

---

### 1.10 Move tree state from localStorage to IndexedDB

**File:** `growth/treeStorage.ts`

The growth tree uses `localStorage` while everything else (tasks, auth cache, sync queue) uses IndexedDB via `offline/db.ts`. This inconsistency means:
- Private browsing modes may block one but not the other
- Future backend sync will require a data migration from two different sources
- Three separate persistence strategies exist with no unifying abstraction

**Fix** — replace `localStorage.getItem/setItem` in `treeStorage.ts` with `offlineDb.get/set` using a new `'tree'` cache key via `offline/cache.ts`.

---

### 1.11 Crash risk in `useTaskFilters` ✅ Completed

**File:** `hooks/useTaskFilters.ts`

`task.description.toLowerCase()` will throw if `description` is `undefined` — which is possible since the server can omit it on tasks created without one.

**Fix — one character:**
```ts
// BEFORE:
task.description.toLowerCase().includes(q)

// AFTER:
task.description?.toLowerCase().includes(q)
```

---

### 1.12 Remove placeholder nav items from AppLayout

**File:** `components/AppLayout.tsx`

Two disabled nav buttons labelled "Analytics (later)" and "Tree System (later)" and a subtitle reading "Phase 1 Dashboard" are development scaffolding left in the UI. These should be removed before any user sees the app.

---

### 1.13 Add `type="button"` to TaskEditForm Save button

**File:** `components/dashboard/TaskEditForm.tsx`

The Save button has no `type` attribute, defaulting to `type="submit"`. Currently harmless since there's no wrapping `<form>`, but if the component is ever moved inside a form context it will submit the parent form instead of calling `onSaveTaskEdit`. One-character fix:

```tsx
<button type="button" onClick={onSaveTaskEdit}>Save</button>
```

---

## Phase 2 — Important Improvements (Next Sprint)

### 2.1 Types — consolidate `TaskUpdatePayload`

**Files:** `types/task.ts`, `services/taskService.ts`, `hooks/useDashboardTasks.ts`, `offline/queueProcessor.ts`

`TaskUpdatePayload` is defined **four times** across four files, each slightly differently. A change to the update endpoint shape requires hunting down all four and updating them manually. The first one to drift causes silent payload mismatches.

**Fix** — define once in `types/task.ts` and import everywhere:
```ts
// types/task.ts
export type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  dueDate?: string | null;
};
```

---

### 2.2 Types — tighten `Task` interface

**File:** `types/task.ts`

- `description` is `string` (required) on `Task` but the server can omit it → should be `description?: string`
- `estimatedMinutes` is required on `Task` but optional on creation → runtime `undefined` despite TypeScript saying `number`
- `dueDate` has no format documentation → add JSDoc: `/** ISO 8601 date string */`
- No `TaskUpdatePayload` export (covered in 2.1)

---

### 2.3 Services — add error normalisation utility ✅ Completed

**File:** `services/api.ts`

Every component handles raw Axios errors differently. A shared helper would standardise the experience:

```ts
export const getApiErrorMessage = (error: unknown, fallback = 'Something went wrong'): string => {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message ?? fallback;
  }
  return fallback;
};
```

---

### 2.4 Store — add token expiry check on init ✅ Completed

**File:** `store/authStore.ts`

On app load, the store restores whatever token is in localStorage without checking if it's expired. A user returning after a long absence will appear "logged in" until their first API call fails with a 401.

**Fix — validate on init:**
```ts
const getInitialState = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || !isSessionTokenValid(token)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    return { token: null, user: null };
  }
  // ... existing logic
};
```

---

### 2.5 Store — add shape validation on `getInitialUser` ✅ Completed

**File:** `store/authStore.ts`

`JSON.parse(raw) as AuthUser` is an unsafe cast. Old app versions stored a different user shape — the cast silently succeeds and the app uses a malformed user object.

**Fix — add a runtime guard:**
```ts
const parsed = JSON.parse(raw);
if (!parsed?.id || !parsed?.email || !parsed?.name) return null;
return parsed as AuthUser;
```

---

### 2.6 Hooks — split `useDashboardTasks` (490+ lines)

**File:** `hooks/useDashboardTasks.ts`

This hook manages form state, edit state, bulk actions, and all mutations in one 490-line file. Extract into:
- `useTaskCreateForm` — title, priority, tags, dueDate, estimatedMinutes state + reset
- `useTaskEditForm` — editingTaskId, editState
- `useTaskMutations` — all create/toggle/delete/edit/bulk handlers

Each becomes independently testable and the dashboard hook becomes a thin composer.

---

### 2.7 Hooks — deduplicate form reset in `useDashboardTasks`

**File:** `hooks/useDashboardTasks.ts`

The form reset sequence (`setTitle(''), setPriority('medium'), ...`) appears twice — once in the online path and once in the offline path. Adding a new field means updating two places. Extract to a `resetCreateForm()` function.

---

### 2.8 Hooks — guard `fetchFreshTasks` against 401

**File:** `hooks/useDashboardSync.ts`

If `taskService.getTasks()` returns 401, the catch block shows "Showing cached data" indefinitely. The 401 should trigger `clearAuth()` and redirect to login (covered by fix 1.2's global interceptor, but worth an explicit guard here too).

---

### 2.9 Components — fix O(n²) selection check in `TaskList` ✅ Completed

**File:** `components/dashboard/TaskList.tsx`

`selectedIds.includes(task._id)` inside `.map()` is O(n) per task → O(n²) overall. With 200 tasks all selected, that's 40,000 comparisons per render.

**Fix:**
```ts
const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
// then: selectedSet.has(task._id)
```

---

### 2.10 Components — fix misleading empty state in `TaskList` ✅ Completed

**File:** `components/dashboard/TaskList.tsx`

A user with zero tasks sees "No tasks match the current filters" — but they have no tasks at all, so filters aren't relevant.

**Fix — differentiate the two cases:**
```tsx
{tasks.length === 0 && !hasActiveFilters
  ? <p>Create your first task to get started.</p>
  : <p>No tasks match the current filters.</p>
}
```

---

### 2.11 Components — extract shared `TaskFormFields` ✅ Completed

**Files:** `components/dashboard/TaskCreateForm.tsx` + `TaskEditForm.tsx`

Both forms are nearly identical — same fields, same `TagInput`, same priority select. A shared `TaskFormFields` component with a slot for the action button would eliminate parallel evolution.

---

### 2.12 Components — move `healthColor` and `healthLabel` outside component ✅ Completed

**File:** `components/dashboard/GrowthTree.tsx`

Both are defined inside the component body and recreated on every render. They're static constants — move them outside:

```ts
const HEALTH_COLOR: Record<TreeHealth, string> = {
  healthy: '#22c55e',
  wilting: '#eab308',
  dead: '#ef4444',
};
```

---

### 2.13 Components — add missing footer case to GrowthTree ✅ Completed

**File:** `components/dashboard/GrowthTree.tsx`

A user with XP > 0 but `streakDays === 0` (earned XP then let streak lapse) shows no footer message. Their tree is dead but they receive no encouragement to restart. Add:

```tsx
{state.streakDays === 0 && state.xp > 0 && (
  <p className={styles.message}>
    Your streak broke, but your progress remains. Complete a task to restart.
  </p>
)}
```

---

### 2.14 Components — add `aria-label` to TaskCard checkbox ✅ Completed

**File:** `components/dashboard/TaskCard.tsx`

The completion checkbox has no accessible label. A screen reader will announce it with no task context.

**Fix:**
```tsx
<input
  type="checkbox"
  aria-label={`Mark "${task.title}" as complete`}
  checked={task.completed}
  ...
/>
```

---

### 2.15 Components — add ARIA roles to TagInput dropdown ✅ Completed

**File:** `components/shared/TagInput.tsx`

The suggestions dropdown has no `role="listbox"` and suggestion items have no `role="option"` or `aria-selected`. Screen reader users get no indication a dropdown appeared.

**Fix:**
```tsx
<ul role="listbox" aria-label="Tag suggestions">
  {suggestions.map((tag, i) => (
    <li
      key={tag}
      role="option"
      aria-selected={i === suggestionIndex}
      ...
    >
      {tag}
    </li>
  ))}
</ul>
```

---

### 2.16 Pages — trim email before auth calls ✅ Completed

**Files:** `pages/LoginPage.tsx` + `pages/RegisterPage.tsx`

User-typed emails are sent as-is, including leading/trailing whitespace. A user who accidentally registered with `" user@email.com"` can't log in without retyping the space.

**Fix:**
```ts
authService.login({ email: email.trim(), password })
authService.register({ name: name.trim(), email: email.trim(), password })
```

---

### 2.17 Pages — extract `useRedirectIfAuthenticated` hook ✅ Completed

**Files:** `pages/LoginPage.tsx` + `pages/RegisterPage.tsx`

Both pages duplicate the same "redirect if already authenticated" `useEffect` exactly. Extract:

```ts
// hooks/useRedirectIfAuthenticated.ts
export const useRedirectIfAuthenticated = (to = '/dashboard') => {
  const { token } = useAuthStore();
  const navigate = useNavigate();
  useEffect(() => {
    if (isSessionTokenValid(token)) navigate(to, { replace: true });
  }, [token, navigate, to]);
};
```

---

### 2.18 Pages — fix `setTimeout` cleanup on `ResetPasswordPage` ✅ Completed

**File:** `pages/ResetPasswordPage.tsx`

The success redirect uses `setTimeout` without cleanup. If the user navigates away before it fires, `navigate()` is called on an unmounted component.

**Fix:**
```ts
useEffect(() => {
  if (!successMessage) return;
  const id = setTimeout(() => navigate('/login', { replace: true }), 1200);
  return () => clearTimeout(id);
}, [successMessage, navigate]);
```

---

### 2.19 Pages — fix `maxLength` mismatch on reset token input ✅ Completed

**File:** `pages/ResetPasswordPage.tsx`

The input has `maxLength={10}` but the server generates a 6-digit code. Change to `maxLength={6}` and add `inputMode="numeric"` for better mobile UX.

---

### 2.20 Offline — add `clearCachedTasks` to cache layer

**File:** `offline/cache.ts`

There is `clearCachedAuthUser` but no equivalent `clearCachedTasks`. On logout, the task cache must be wiped by calling `setCachedTasks([])` from callsites — intent is hidden. Add:

```ts
export const clearCachedTasks = async (): Promise<void> => {
  await offlineDb.del(CACHE_STORE, TASKS_KEY);
};
```

---

### 2.21 Offline — remove or wire `lastSyncTimestamp`

**File:** `offline/cache.ts`

`setLastSyncTimestamp` is exported but never called in the sync flow. It's dead code. Either wire it up in `useDashboardSync` after a successful fetch, or remove it.

---

### 2.22 Offline — add max retry count to sync queue entries

**File:** `offline/syncQueue.ts` + `offline/queueProcessor.ts`

There is no maximum retry count. A permanently broken entry (bad payload, deleted task) retries forever. Add a `retryCount` field to `SyncQueueRecord` and drop entries that exceed a threshold (e.g. 5):

```ts
interface SyncQueueRecord {
  // ... existing fields
  retryCount: number;
}
// In queueProcessor.ts catch block:
if (!isPermanent && entry.retryCount < MAX_RETRIES) {
  remainingQueue.push({ ...entry, retryCount: entry.retryCount + 1 });
}
```

---

### 2.23 Growth — wire up `GrowthEventPayload` for UX feedback

**File:** `hooks/useDashboardGrowth.ts`

`awardXpForCompletion` returns a `GrowthEventPayload` with `xpGained`, `newStage`, and `healthChanged` — but the hook silently discards it. The XP gain animation, stage-up celebration, and health change notification that this payload was designed to drive simply don't exist.

**Fix — expose the event:**
```ts
const [lastEvent, setLastEvent] = useState<GrowthEventPayload | null>(null);

const processGrowthForCompletion = useCallback((taskId: string) => {
  setTreeStateLocal((current) => {
    const base = current ?? getTreeState();
    const { state: nextState, event } = awardXpForCompletion(base, taskId, true);
    setTreeState(nextState);
    if (event) setLastEvent(event);
    return nextState;
  });
}, []);

return { treeState, lastEvent, processGrowthForCompletion };
```

Then use `lastEvent` in `DashboardPage` to show a toast or animation.

---

### 2.24 Growth — fix DST-safe streak calculation

**File:** `growth/treeLogic.ts`

`daysBetween` uses millisecond arithmetic, which is wrong across daylight saving time transitions (a DST day can be 23h or 25h, causing `Math.floor` to return 0 or 2 instead of 1).

**Fix — compare date strings directly:**
```ts
export const daysBetween = (dateA: string | null, dateB: string): number => {
  if (!dateA) return 0;
  const [y1, m1, d1] = dateA.split('-').map(Number);
  const [y2, m2, d2] = dateB.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000);
};
```

---

### 2.25 Reminders — unify `ReminderNotificationType`

**Files:** `reminders/notification.ts` + `reminders/scheduler.ts`

The same union type is defined as `ReminderNotificationType` in `notification.ts` and `ReminderType` in `scheduler.ts`. Define once and export from a shared `reminders/types.ts`.

---

### 2.26 Reminders — add notification icon

**File:** `reminders/notification.ts`

Browser notifications without an icon show a generic browser icon. Add:

```ts
new Notification(buildTitle(type), {
  body: buildBody(task, type),
  tag: `halotask-${type}-${task._id}-${duePart}`,
  icon: '/favicon.ico',
});
```

---

### 2.27 Reminders — fix work-session duration formatting

**File:** `reminders/notification.ts`

`Math.ceil(estimatedMinutes / 60)` rounds a 61-minute task to "2h". Users who set precise estimates get misleading notifications.

**Fix:**
```ts
const formatDuration = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};
```

---

### 2.28 Reminders — add notification permission status to `ReminderSettings`

**File:** `components/dashboard/ReminderSettings.tsx`

A user can enable reminders in the panel without realising they also need to grant browser permission. Add a visible status row:

```tsx
<div className="permission-status">
  Notifications: {permissionStatus === 'granted' ? '✓ Enabled' : (
    <button onClick={requestNotificationPermission}>Click to enable</button>
  )}
</div>
```

---

### 2.29 Utils — fix `getCompletedToday` reliability

**File:** `utils/taskInsights.ts`

`getCompletedToday` relies on `task.updatedAt` matching today's date to detect completion. But `updatedAt` changes on any update — not just completion. A task edited today but completed yesterday will incorrectly show in "completed today". The task model needs a `completedAt` timestamp, or the client needs to track this separately.

---

### 2.30 Utils — standardise localStorage key naming

**Files:** `utils/authSession.ts`, `growth/treeStorage.ts`, `reminders/settings.ts`, `store/authStore.ts`

Four different key naming conventions are in use:
- `halotasks_token` (underscore)
- `halotasks_known_user` (underscore)
- `halotask:growth_tree` (colon, singular)
- `halotasks_reminder_settings` (underscore)

Standardise on one convention, e.g. `halotasks:<feature>` and document it in a single `storageKeys.ts` constants file.

---

## Phase 3 — Polish (Pick as Capacity Allows)

| # | File | What |
|---|---|---|
| 3.1 | `hooks/useTaskSorting.ts` | Type `priorityRank` as `Record<Priority, number>` instead of `Record<string, number>` to catch typos at compile time |
| 3.2 | `hooks/useTagSuggestions.ts` | Pre-compute `new Set(selectedTags)` before filter loop to avoid O(n²) |
| 3.3 | `hooks/useTaskSelection.ts` | Use `Set<string>` as underlying state for O(1) toggle/check |
| 3.4 | `components/SmartSections.tsx` | Wrap all five insight computations in a single `useMemo` — currently 5 array passes per render |
| 3.5 | `components/TaskCard.tsx` | Add a visible loading state on the toggle checkbox (not just disabled) during async operations |
| 3.6 | `components/TaskCard.tsx` | Wrap in a single root element instead of a fragment — avoids invalid HTML if reused outside `<li>` |
| 3.7 | `components/AppLayout.tsx` | Replace `user ? user.name : 'Signed in'` with a non-null assertion or loading shimmer — `ProtectedRoute` guarantees user is present |
| 3.8 | `offline/network.ts` | Consider a periodic lightweight fetch to `/api/ping` to detect "connected but no internet" — `navigator.onLine` only detects physical connection |
| 3.9 | `offline/syncQueue.ts` | Add max queue size (e.g. 500 entries) to prevent unbounded growth during prolonged offline periods |
| 3.10 | `reminders/permissions.ts` | Export `hasReminderPermission(): boolean` returning `Notification.permission === 'granted'` for cleaner callsites |
| 3.11 | `reminders/scheduler.ts` | Add a small delay before the first `runNow()` call to avoid firing all pending reminders the instant the app opens |
| 3.12 | `growth/treeTypes.ts` | Mark `GrowthEventPayload` with a `// TODO: wire to UI feedback` comment or build the feature (covered in 2.23) |
| 3.13 | `pages/ForgotPasswordPage.tsx` | Disable the form after a successful submission to prevent re-submitting against the rate limiter | ✅ Completed |
| 3.14 | `pages/ForgotPasswordPage.tsx` | Sync the "expires in 15 minutes" UI copy with the server's actual `RESET_TOKEN_TTL_MINUTES` value |
| 3.15 | `pages/RegisterPage.tsx` | Add a password confirmation field — currently a typo in the password has no client-side feedback |
| 3.16 | All forms | Trim all text inputs (name, title, description) before submission |

---

## Recommended Fix Order

Work through P1 fixes in this sequence to get maximum safety with minimum dependencies:

1. **`useTaskFilters`** — one-line crash fix, zero risk, do it first
2. **`AppLayout`** — remove placeholder UI before anyone sees it
3. **`TaskEditForm`** — add `type="button"`, one character
4. **`offline/db.ts`** — add error handling, everything else depends on it
5. **`services/api.ts`** — add timeout + 401 interceptor
6. **`store/authStore.ts`** — unify TOKEN_KEY, add expiry check on init
7. **`offline/syncQueue.ts`** — fix race condition with write chain
8. **`offline/queueProcessor.ts`** — stop swallowing permanent errors
9. **`hooks/useDashboardTasks.ts`** — fix offline delete ordering
10. **`hooks/useDashboardSync.ts`** — 401 now handled by interceptor, verify
11. **`growth/treeLogic.ts`** — fix UTC timezone bug
12. **`growth/treeStorage.ts`** — migrate to IndexedDB
13. **`ResetPasswordPage`** — fix setTimeout cleanup + maxLength

---

## Total Effort Estimate

| Phase | Items | Effort |
|---|---|---|
| P1 — Critical Fixes | 13 | 12–16 hours |
| P2 — Improvements | 30 | 20–28 hours |
| P3 — Polish | 16 | 6–10 hours |
| **Total** | **59** | **38–54 hours** |

> P1 is entirely achievable in 2 focused engineering days.
> P2 should be spread across the next 2–3 sprints.
> P3 is a running backlog — pull in as capacity allows.

---

*Halotask Pro Client Upgrade Plan · Generated from full codebase review · Continue with combined remediation when ready*
