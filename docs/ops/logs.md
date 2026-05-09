# Logs

[2026-04-19] - Foundation - Monorepo scaffold completed
[2026-04-19] - Backend - Auth + task routes added
[2026-04-19] - Backend - API routes verified with integration tests
[2026-04-19] - Docs - Product/ops split added for execution tracking
[2026-04-19] - Frontend - Routing, auth flow, dashboard shell, and task CRUD/filter UI implemented
[2026-04-19] - Frontend - Inline task editing, due date/tag fields, and auth redirect guards added
[2026-04-19] - Frontend - DashboardPage split into reusable components/hooks to stop oversized page growth
[2026-04-19] - Frontend - TaskList split into TaskCard and TaskEditForm for maintainable component boundaries
[2026-04-19] - Frontend - Task sorting system added with modular sorting hook and filter dropdown
[2026-04-19] - Frontend - Bulk actions system added (clear completed, selection mode, select all visible, mark complete, delete with confirmation)
[2026-04-19] - Frontend - Bulk actions reliability upgraded with Promise.allSettled partial-failure handling and retry-friendly selection retention
[2026-04-19] - Frontend - Tier 1 Smart Sections added (overdue, due today, upcoming, completed today, estimated workload)
[2026-04-19] - Frontend - Offline foundations Phase A added with IndexedDB cache-first loading and sync status indicator
[2026-04-19] - Frontend - Offline Phase B write queue added with optimistic local updates, reconnect replay, and pending sync indicators
[2026-04-19] - Frontend - Manual retry sync control added for errors-pending queue state with pending count visibility
[2026-04-19] - Frontend - Reminder Engine Phase 1 added with due-soon/overdue browser notifications and session duplicate prevention
[2026-04-19] - Frontend - Reminder Engine Phase 2 added with smart start-time alerts based on due date, estimated work, and default buffer
[2026-04-19] - Frontend - Reminder settings panel added with local persistence, buffer control, type toggles, and quiet hours
[2026-04-19] - Docs - Full project documentation refresh completed across README, product, ops, and API contract
[2026-05-09] - Frontend - Shared redirect hook extracted for authenticated pages; login/register emails now trim before auth calls
[2026-05-09] - Frontend - Forgot password resubmit guard added and reset-code copy synced to configurable TTL
[2026-05-09] - Frontend - GrowthTree static health constants moved out of component and TaskCard completion checkbox gained an aria-label
[2026-05-09] - Frontend - Shared TaskFormFields extracted for create/edit forms; TagInput suggestions gained listbox/option ARIA roles
[2026-05-09] - Frontend - TaskList empty state split into zero-task and filter-empty copy; ForgotPassword submit label now reflects sent-code success
[2026-05-09] - Frontend - ResetPassword submit button now disables after success and mirrors the redirecting success state
[2026-05-09] - Frontend - GrowthTree footer message extracted into a small helper to simplify render branching
[2026-05-09] - Frontend - TaskCard controls now expose task-specific accessibility labels for select, edit, and delete actions
[2026-05-09] - Frontend - TagInput chip and suggestion buttons now have visible keyboard focus styles
[2026-05-09] - Frontend - TaskList empty state now reflects the full active filter set from DashboardPage