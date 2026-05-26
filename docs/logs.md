# HaloTaskPro Changelog & Logs

## ℹ️ Automated Changelog System

All changelog entries are tracked in **`.logs`** (machine-readable JSON format) and synced to this guide.

### 📝 Adding Entries

**Interactive method:**
```bash
node scripts/add-changelog.js
```

**Manual method:**
- Edit `.logs` file directly (JSON format)
- Entry is automatically synced to release notes

---

## Format

[DATE] - [CATEGORY] - [TITLE]: [DESCRIPTION]

---

## Recent Updates

[2026-05-26] - Bugfix - 2605: preserve Completed Today after clearing finished tasks: Switched the dashboard productivity snapshot to use the persisted day history entry and tightened the clear-completed flow to read the latest committed task state before snapshotting, so clearing finished tasks no longer zeroes the Completed Today and Work Done Today cards.

[2026-05-26] - Bugfix - 2605: preserve completed-task history when clearing completed items: Added a skipSnapshot option to task persistence so clear-completed no longer overwrites the pre-delete weekly snapshot, keeping Completed Today history intact.

[2026-05-26] - Feature - 2605: rewrite insights page with weekly summary and task drill-downs: Replaced the insights overview with a full analytics page, added clickable task stat cards that open the shared InsightModal, enabled optimistic task toggling from the modal, surfaced tag breakdowns and day-of-week patterns, and added weekly summary chips for streak, week total, work done, and best day.

[2026-05-26] - Feature - 2605: add five-step onboarding flow and onboarding gate: Added a full-screen onboarding page with five steps, onboarding completion session flags, protected /onboarding routing, register redirect, and authenticated entry gating.

[2026-05-25] - Frontend - 2405: add title bar image and favicon: Added a custom title bar image and browser favicon, updated header layout and CSS, and wired favicon link for improved tab rendering.

[2026-05-25] - Feature - 2405: add PWA installability and Web Push relay support: Added the PWA manifest, service worker, theme/meta tags, generated app icons, a client push subscription hook, reminder-to-push relay wiring, and authenticated server push subscribe/unsubscribe/relay endpoints with VAPID setup.

[2026-05-24] - Feature - 2405: add AI task creation with Gemini parsing and draft preview flow: Added a new AI task parser hook powered by Gemini 2.0 Flash, AI-aware task form wiring, draft preview/confirmation UI, and sequential task creation that persists new tasks into the live list.

[2026-05-24] - Feature - 2405: add cold-start Task Tapper overlay for slow server wakes: Bumped the API timeout to 60s, added a 3s cold-start timer in dashboard sync, and mounted a full-screen Task Tapper overlay that auto-dismisses once the server responds.

[2026-05-23] - Bugfix - 2305: switch toolbar meta collapse to max-height with open overflow visibility: Replaced the toolbar meta wrapper's grid-template-rows collapse with a max-height transition and open-state overflow: visible so the reminder dropdown can escape the container while the meta block remains collapsible.

[2026-05-23] - Frontend - 2305: focus task title input on desktop; pass autoFocus/inputRef through forms: Added `autoFocus` and `inputRef` props to `TaskFormFields` and `TaskCreateForm`; passed `autoFocus` from `TaskCreateSheet`; added `titleInputRef` in `DashboardPage` and wired the desktop Add action to focus the sidebar title input.

[2026-05-23] - Bugfix - 2305: fix input ref typing for titleInputRef: Corrected `RefObject` typing to allow `null` for `inputRef` props in `TaskFormFields` and `TaskCreateForm` to match `useRef(null)` signature and prevent TypeScript errors during build.

[2026-05-23] - Frontend - 2305: FAB SVG and interaction improvements; toolbar CTA sizing on mobile: Replaced the FAB '+' text with a crisp SVG crosshair-plus and centered it using `display: grid; place-items: center` for reliable cross-device rendering. Added hover scale and ring glow, improved active press feedback (brightness + reset ring), and allowed toolbar primary CTA to size naturally on mobile so the '+ New task' button fits inline while remaining hidden on desktop.

[2026-05-23] - Feature - 2305/v6: add server-backed 7-day history sync and responsive task-sheet/filter updates: Applied v6 across 9 files. Added collapsible advanced filter CSS (`filter-advanced`, `filter-toggle-btn`, `filter-active-dot`) and non-squishing segment tabs (`min-width: 52px; white-space: nowrap`). Changed desktop TaskCreateSheet from hidden sheet to centered modal (`left: 50%`, `transform: translateX(-50%)`, `top: 8vh`, `width: min(520px, 90vw)`) with fade+scale entry animation; hid toolbar '+ New task' CTA on mobile where FAB is primary. Updated `DashboardPage.handleAddTask` to always open the sheet, preserved Completed Today stats by snapshotting before clear-completed deletion, synced local snapshot writes to backend via new `historyService`, and added authenticated server history endpoints with new `DayHistory` model, controller, routes, and `/api/history` mount in app.

[2026-05-23] - Feature - 2305/v7: keep Add Task visible, collapse toolbar metadata, and persist reminder session state: Restored the Add Task CTA on all viewports, removed the desktop sheet modal conversion so the task sheet stays a bottom sheet everywhere, added a controlled `filtersExpanded` state flow that collapses `toolbar-meta` with the filter block, updated reminder checkbox layout to keep checkbox and text on one line with themed accent color, and stored fired reminder keys in `sessionStorage` so notifications survive reloads within the same tab session.

[2026-05-20] - Feature - Add completed task history section and completedAt tracking: Created CompletedSection component to surface a collapsible completed-task history list with re-activate and delete actions. Added completedAt to the Task type and updated task completion analytics to prefer completedAt while falling back to updatedAt for older records. Updated the task backend model and update flow to stamp completedAt when a task transitions to completed and clear it when reopened. Added dashboard styling for the completed section so it matches the existing task list visuals.

[2026-05-21] - Feature - Add 7-day local history snapshots and Insights week chart: Added `offline/history.ts` to maintain a rolling 7-day snapshot of completed tasks (completedCount, workDoneMinutes, completedTasks). Integrated `updateTodaySnapshot` into the dashboard task persistence flow so snapshots stay current. Enhanced `InsightsPage` to display the 7-day history chart with per-day details. Added corresponding `week-history` CSS to `halotasks-client/src/styles/app.css`.

[2026-05-19] - Backend - Implement tree API endpoints with anti-cheat validation and client-side sync: Added treeState nested schema to User model with XP, leaves, streak tracking, health/stage enums, and awardedTaskIds array. Created tree.controller.ts with getTree() and patchTree() endpoints featuring anti-cheat XP validation (append-only check), enum validation for health/stage, and clean $set builder with Math.max guards. Created tree.routes.ts with requireAuth middleware. Enhanced app.ts with resolveOrigin() function that fails-closed in production when CLIENT_ORIGIN not set, provides localhost fallbacks in dev, added express.json({ limit: '1mb' }) to prevent memory exhaustion, and upgraded error handler with isDev branching (surface errors in dev, generic messages in production). On client: created treeService.ts with getTree() and patchTree() API methods, upgraded treeStorage.ts to local-first with server sync: localStorage migration to IndexedDB, merge strategy (higher XP wins, union awardedTaskIds), fire-and-forget server persistence, and offline-first source of truth.

[2026-05-19] - Ops - Harden MongoDB DNS fallback and add production-grade startup/shutdown: Enhanced db.ts to save and restore DNS servers, preventing fallback DNS from leaking into email/API calls elsewhere in process. Added startup validation to server.ts that fail-fasts on missing JWT_SECRET and MONGO_URI. Registered global uncaughtException and unhandledRejection handlers before DB connect. Implemented graceful shutdown on SIGTERM/SIGINT: stops accepting new connections, waits for in-flight requests, closes MongoDB, with 10-second force-exit timeout. Enhanced logging throughout for visibility.

[2026-05-18] - Security - Harden password reset code generation and error handling: Replaced Math.random() with crypto.randomInt(100000, 1000000) for cryptographically secure 6-digit reset codes. Restructured sendResetPasswordEmail to distinguish between configured-but-failed transports (error logged, code NOT logged) versus unconfigured demo mode (code logged for testing). Added explicit Promise<void> return type to sendResetPasswordEmail. Updated requireAuth middleware to return generic 'Internal server error' to clients while logging full JWT_SECRET configuration details to console.error for server visibility.

[2026-05-18] - Feature - Add InsightModal with task completion UI and card interactivity: Created new InsightModal reusable component for viewing task subsets per card type. Mobile renders as bottom-sheet with slideUp animation, desktop as centered 480px card. Each modal displays sorted task lists (overdue by date, due-today by priority, etc.) with circular toggle buttons for completion and strikethrough completed titles. Integrated into SmartSections with openModal state tracking which card type is open. Made InsightCard components into <button> elements with hover/focus interactive states. Modal stays open after toggling to enable batch completion workflow.

[2026-05-18] - Bugfix - Fix scroll lock on desktop sheets and add mobile + New task button: Added window.matchMedia check to TaskCreateSheet and GrowthTreeSheet so scroll lock only applies on mobile (max-width: 767px) where sheets are visible. On desktop, sheets are display:none via CSS, so the previous always-on lock would freeze page scroll with no visible sheet to close. Added optional onAddTask prop to TaskFilters with mobile-visible '+ New task' button that opens the create sheet. Button positioned right of status segment pills using new .filter-segment-row flex layout.

[2026-05-18] - Feature - Enhance SmartSections with work-done metrics and refactor GrowthTree styles: Added sixth productivity card (Work Done Today) to SmartSections component with estimated minutes formatting helper. Refactored GrowthTree.module.css to use CSS variables instead of hardcoded colors, improving theme consistency and maintainability. Updated taskInsights utility with getWorkDoneToday() function to track completed task workload.

[2026-05-14] - Feature - Add insights overview page: Replaced the insights stub with a data-driven page that loads live or cached tasks, initializes growth state, shows today-at-a-glance metrics, renders task completion and priority breakdowns, and embeds the Growth Tree view.

[2026-05-14] - Feature - Build out reminder notification settings UI: Replaced the reminders placeholder with a full settings surface for browser notification permission, a master reminders toggle, per-alert switches, buffer time selection, and quiet-hours scheduling, with disabled-state handling when reminders are turned off.

[2026-05-14] - Accessibility - Improve adaptive theme accessibility and control contrast: Adjusted the adaptive theme control to use a proper label association, aria-describedby wiring, top-aligned toggle layout, stronger unchecked track contrast, flex-safe switch sizing, and dynamic theme-card aria labels.

[2026-05-13] - Feature - Add adaptive theme controls to Settings page: Replaced the Settings stub with a full appearance and account screen, including the adaptive toggle switch, manual theme override banner with reset action, theme cards with per-theme accent dots, and the password change link.

[2026-05-13] - Feature - Add protected dashboard subpages: Added protected routes for /dashboard/insights, /dashboard/reminders, and /dashboard/settings, each rendered inside the shared AppLayout so unauthenticated users are redirected consistently.

[2026-05-13] - Feature - Sync orb display with live Growth Tree data: Added orb data context updates so the floating orb now reflects real XP/stage/progress from `treeState` with safe defaults while loading, while preserving desktop tooltip behavior and mobile sheet behavior.

[2026-05-12] - Feature - Add Growth Tree sheet and orb handler: Added `GrowthTreeSheet` mobile drawer and `OrbContext` with `useRegisterOrbTap` so pages can register orb handlers; orb tap now opens the sheet on mobile and preserves tooltip fallback on desktop to avoid locking scroll.

[2026-05-12] - Bugfix - Prevent offline deletions from disappearing when queue write fails: Changed offline delete flows to enqueue first and only remove from UI state after successful queueing for single, completed-bulk, and selected-bulk deletes. Added a clear user-facing failure message when storage is unavailable.
[2026-05-12] - Feature - Added mobile task create sheet drawer: Introduced TaskCreateSheet with slide-up mobile drawer UX, Escape/backdrop close behavior, body scroll locking, focus management, and router-state opening via FAB with optimistic close on submit.
[2026-05-12] - Frontend - Added desktop header nav and fixed responsive spacing: Added desktop navigation links in AppLayout header using shared NAV_ITEMS and active state aria-current, and fixed desktop main padding when bottom nav is hidden.
[2026-05-12] - Bugfix - Fixed dashboard two-column grid child structure: Wrapped dashboard toolbar and content panel in main-column so dashboard-page maps cleanly to sidebar + main content columns and prevents panel wrapping behind sidebar.
[2026-05-12] - Docs - Cleaned and reorganized server upgrade plan: Refactored server_upgrade_plan.md into a single structured roadmap grouped by priority with normalized issue sections and clear recommendations.
[2026-05-12] - Frontend - Aligned app.css with assistance baseline and fixed desktop overlap: Added missing empty-state and reminder-note selectors, validated authenticated dashboard layout, and fixed desktop FAB overlap with toolbar actions.
[2026-05-11] - Frontend - Hardened growth storage and offline queue handling: Added batch-5 growth storage initialization and serialized sync queue writes to keep task progress and offline actions stable.
[2026-05-11] - Bugfix - Prevent permanent sync errors from retrying forever: Updated the offline queue processor to detect permanent 4xx failures, discard impossible entries, and keep transient errors queued for retry.
[2026-05-11] - Frontend - Updated dashboard toolbar and productivity snapshot: Wrapped the dashboard controls in a dedicated toolbar shell, upgraded SmartSections to iconified insight cards, and synced the dashboard layout and toolbar styles.
[2026-05-11] - Accessibility - Completed component accessibility audit and batch implementations: Implemented ARIA attributes across all components. Batch 1: TagInput + TaskFormFields with full ARIA support. Batch 2: TaskCreateForm, TaskFilters, TaskEditForm with semantic HTML. Batch 3: GrowthTree, ReminderSettings with permission display.
[2026-05-11] - Frontend - Build validation after component updates: All builds passed successfully. 137 modules transformed, 351.50 KB JS / 111.80 KB gzip, 49.92 KB CSS / 9.37 KB gzip.

---

## Categories

| Category | Use Case |
|----------|----------|
| **Frontend** | UI components, styling, client-side features |
| **Backend** | APIs, business logic, database changes |
| **Accessibility** | ARIA attributes, keyboard navigation, screen reader support |
| **Docs** | Documentation, guides, README updates |
| **Config** | Build configuration, env variables, dependencies |
| **CI/CD** | Testing, deployment, automation |
| **Ops** | Monitoring, infrastructure, DevOps |
| **Planning** | Roadmap, strategy, architecture decisions |
| **Refactor** | Code cleanup, performance optimization |
| **Bugfix** | Bug fixes, hotpatches, issue resolution |
| **Feature** | New features and capabilities |
| **Performance** | Speed optimization, bundle size reduction |

---

## See Also

- `.logs` — Machine-readable JSON changelog with full metadata
- `CHANGELOG_GUIDE.md` — Complete documentation and best practices
- `.githooks/post-commit` — Optional git hook for auto-logging commits
