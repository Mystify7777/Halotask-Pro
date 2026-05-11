# Changelog & Logs Management — HaloTaskPro

## Overview

HaloTaskPro now has a **dual-layer changelog system** for tracking all development work:

1. **`.logs`** — Machine-readable JSON changelog (structured, queryable)
2. **`docs/logs.md`** — Human-readable markdown log (synced via script)

Both formats are kept in sync for flexibility in reading and tracking.

---

## Adding Changelog Entries

### Method 1: Interactive CLI (Recommended)

```bash
cd HaloTaskPro
node scripts/add-changelog.js
```

This will:
- Prompt you to select a category
- Ask for title, description, affected files, priority
- Add entry to `.logs` 
- Sync to `docs/logs.md`

**Example:**
```
📝 HaloTaskPro Changelog Entry Generator

Available categories:
  1. Frontend
  2. Backend
  3. Docs
  4. Config
  5. CI/CD
  6. Ops
  7. Planning
  8. Refactor
  9. Bugfix
  10. Feature
  11. Performance
  12. Accessibility

Select category (number): 1
Title: Added dark mode toggle
Description: Implemented theme switcher in navbar using CSS custom properties
Files affected (comma-separated, optional): halotasks-client/src/components/Nav.tsx, halotasks-client/src/styles/themes.css
Priority (low/medium/high, default: medium): medium

✅ Changelog entry added!
   Category: Frontend
   Title: Added dark mode toggle
   Date: 2026-05-11
   Priority: medium
```

### Method 2: Manual JSON Edit

Edit `.logs` directly:

```json
{
  "entries": [
    {
      "date": "2026-05-11",
      "category": "Frontend",
      "title": "Added dark mode toggle",
      "description": "Implemented theme switcher in navbar",
      "files": [
        "halotasks-client/src/components/Nav.tsx",
        "halotasks-client/src/styles/themes.css"
      ],
      "priority": "medium",
      "status": "completed"
    }
  ]
}
```

### Method 3: Git Hooks (Fully Automated - Optional)

To enable auto-logging on every commit:

```bash
# Configure git to use .githooks directory
git config core.hooksPath .githooks
```

Then each commit automatically logs changed files based on their type.

---

## `.logs` File Structure

```json
{
  "format": "Automated Changelog Log",
  "description": "Machine-readable changelog tracking all HaloTaskPro updates.",
  "categories": ["Frontend", "Backend", "Docs", "Config", "CI/CD", "Ops", "Planning", "Refactor", "Bugfix", "Feature", "Performance", "Accessibility"],
  "entries": [
    {
      "date": "YYYY-MM-DD",
      "category": "Category Name",
      "title": "Brief title",
      "description": "Detailed description of changes",
      "files": ["path/to/file1.tsx", "path/to/file2.css"],
      "priority": "low|medium|high",
      "status": "completed|in-progress|blocked"
    }
  ],
  "lastUpdated": "ISO 8601 timestamp"
}
```

---

## Categories for HaloTaskPro

| Category | Examples |
|----------|----------|
| **Frontend** | Components (TaskList, TagInput, TaskCreateForm), styling, layouts, UI logic |
| **Backend** | API routes, controllers, business logic, database models |
| **Accessibility** | ARIA attributes, keyboard navigation, screen reader testing, semantic HTML |
| **Docs** | README, API docs, component stories, setup guides |
| **Config** | vite.config.js, tsconfig.json, .env setup, dependencies |
| **CI/CD** | GitHub Actions, build scripts, testing automation |
| **Ops** | Deployment, monitoring, performance tracking |
| **Planning** | Roadmap updates, sprint planning, architecture decisions |
| **Refactor** | Code cleanup, TypeScript improvements, performance optimization |
| **Bugfix** | Fixes for reported issues, hotpatches, regression fixes |
| **Feature** | New task features, user workflows, system capabilities |
| **Performance** | Bundle size reduction, render optimization, caching |

---

## Querying Changelogs

### Find all Frontend changes
```bash
grep "\"category\": \"Frontend\"" .logs
```

### Find all Accessibility work
```bash
grep "\"category\": \"Accessibility\"" .logs
```

### Find all high-priority items (requires jq)
```bash
jq '.entries[] | select(.priority=="high")' .logs
```

### List all changes from this week
```bash
jq '.entries[] | select(.date>"2026-05-04") | .title' .logs
```

### Generate release notes
```bash
jq -r '.entries[] | "[" + .date + "] " + .category + " - " + .title' .logs
```

---

## Best Practices

✅ **DO:**
- Add entries immediately after completing a feature/fix
- Use descriptive but concise titles (one-liner + detail)
- Mark priority based on user-facing impact
- Include affected files for traceability
- Set status to `in-progress` for ongoing work, `completed` for finished work
- Use the interactive script to ensure consistent formatting

❌ **DON'T:**
- Leave `status: "in-progress"` entries for more than a few days
- Add entries weeks after completion (memory fades)
- Use vague titles like "fixed stuff" or "updated components"
- Skip the category—it helps organize release notes
- Forget to update the log after major work

---

## Integration with Release Process

Before releasing a new version:

1. Review all entries in `.logs` for this release cycle
2. Group by priority/category
3. Generate release notes using the jq query above
4. Tag release with version from priorities
5. Archive old entries to `docs/archive/changelog-YYYY-MM.json`

---

## Future Enhancements

- [ ] Auto-generate release notes from `.logs`
- [ ] Weekly changelog digest via email
- [ ] Slack integration to announce major features
- [ ] Semantic versioning based on entry types
- [ ] Changelog search UI in component library
- [ ] Performance regression tracking
- [ ] Accessibility score tracking over time

---

## Quick Commands

```bash
# Add new changelog entry interactively
node scripts/add-changelog.js

# View all changelogs
cat .logs

# View recent changes (last 10)
head -50 .logs

# Search for a specific change
grep -i "tagInput" .logs

# Count entries by category (if jq is installed)
jq '.entries | group_by(.category) | map({category: .[0].category, count: length})' .logs

# Get stats on priority distribution
jq '.entries | group_by(.priority) | map({priority: .[0].priority, count: length})' .logs
```

---

## Support

For questions or improvements to this system, refer to `CHANGELOG_GUIDE.md` or contact the dev team.
