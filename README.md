# HaloTasks

HaloTasks is an offline-first execution assistant that combines task management, sync reliability, and reminder intelligence.

## Current Delivery Status

Implemented:
- Auth and task CRUD (full-stack)
- Search, filters, sorting, and bulk actions
- Smart sections (overdue, due today, upcoming, completed today, workload)
- Offline cache-first reads (IndexedDB)
- Offline write queue with optimistic updates
- Reconnect replay, manual retry sync, and pending states
- Reminder engine (due soon, overdue, smart start-time alerts)
- Reminder settings panel (buffer, type toggles, quiet hours)

Next milestone:
- Growth Tree Phase 1 (logic + dashboard widget)

## Tech Stack

Frontend:
- React
- TypeScript
- Vite
- Zustand
- Axios

Backend:
- Node.js
- Express
- TypeScript
- MongoDB (Mongoose)

Offline/Client Infra:
- IndexedDB via idb

## Documentation Structure

Product docs:
- docs/product/01_Product_Vision.md
- docs/product/02_Feature_Roadmap.md
- docs/product/03_System_Architecture.md
- docs/product/04_Database_Schema.md
- docs/product/05_MVP_Scope.md

Operational docs:
- docs/ops/context.md
- docs/ops/todo.md
- docs/ops/logs.md
- docs/ops/bugs.md
- docs/ops/variables.md
- docs/ops/metrics.md
- docs/ops/master-ai-prompt.md

API reference:
- docs/06_API_Contract.md

Legacy root-level product docs in docs/ remain for compatibility and redirect to docs/product/.
