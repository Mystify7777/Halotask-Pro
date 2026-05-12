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
