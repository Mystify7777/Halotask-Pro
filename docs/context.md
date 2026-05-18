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

## Offline Architecture

The app is built to tolerate network interruption.

Core offline pieces:
- `offline/cache.ts` - cached auth/task data helpers
- `offline/db.ts` - IndexedDB wrapper
- `offline/network.ts` - network helpers
- `offline/syncQueue.ts` - queued write actions
- `offline/queueProcessor.ts` - replay and retry logic

Important offline behavior:
- Tasks can be cached and replayed later
- Write actions are queued when offline
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