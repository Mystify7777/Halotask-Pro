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
[2026-05-10] - Frontend - App theme context added in App with exported useTheme hook and provider wiring around router tree
[2026-05-10] - Frontend - HomePage rebuilt with themed hero sky SVG, feature cards, CTA flow, and interactive theme preview dots via HomePage.module.css
[2026-05-10] - Frontend - Shared AuthPages.module.css introduced and auth screens migrated to branded module-based layouts
[2026-05-10] - Frontend - LoginPage upgraded with session-token redirect guard, trimmed-email login submit, and improved auth form UX/accessibility
[2026-05-10] - Frontend - RegisterPage upgraded with confirm-password validation, strength meter, trimmed payload fields, and guarded submit states
[2026-05-10] - Frontend - ForgotPasswordPage upgraded to neutral-account messaging flow with resend path, 429-specific feedback, and reset-route handoff
[2026-05-10] - Frontend - ResetPasswordPage upgraded with prefilled email from route state, numeric 6-digit code normalization, timer cleanup, and success redirect controls
[2026-05-10] - Frontend - AppLayout replaced with route-aware mobile shell including themed greeting header, bottom nav, growth orb tooltip, and FAB create-task handoff
[2026-05-10] - Frontend - ProtectedRoute and SmartEntryGate standardized with explicit guard intent/docs and preserved destination-aware auth redirects
[2026-05-10] - Frontend - TaskCard redesigned with module CSS, priority/due/estimate metadata row, visible action spinner, and improved checkbox/tag/action accessibility
[2026-05-10] - Ops - Client builds revalidated after each migration batch; latest tsc+vite build passing on updated auth/home/layout/task components

[2026-05-10] - Frontend - Global stylesheet `src/styles/app.css` replaced with user-provided global stylesheet (resets, app shell, and component overrides).
[2026-05-10] - Frontend - Theme tokens `src/styles/tokens.css` updated with refined sunrise/midday/sunset/night palettes, spacing, typography, and shadow scales.
[2026-05-10] - Frontend - `src/pages/HomePage.module.css` synced to global layout (added max-width and centering for comfortable reading width).
[2026-05-10] - Ops - Production build (tsc + vite) run after tokens update; build succeeded and dist assets generated.