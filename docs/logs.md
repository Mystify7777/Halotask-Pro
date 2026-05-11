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
