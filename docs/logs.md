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
