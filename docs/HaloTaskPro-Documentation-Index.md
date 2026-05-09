# HaloTaskPro Documentation Index

This is the single consolidated non-upgrade documentation file for HaloTaskPro.
The active upgrade plans are intentionally kept separate:
- [HalotaskPro-Client-UpgradePlan.md](HalotaskPro-Client-UpgradePlan.md)
- [Server_Upgrade_Plan.docx](Server_Upgrade_Plan.docx)

## Scope

This index replaces the scattered root, ops, product, and helper docs that were previously spread across the `docs/` tree. It keeps the important project knowledge in one place while leaving upgrade plans untouched.

## Core Reference Docs

### API and Integration
- `06_API_Contract.md` - endpoint shapes, auth/task payloads, and client-server contract details.
- `CORS.md` - allowed origin rules, local dev configuration, and CORS validation notes.
- `DUAL_EMAIL_TRANSPORT.md` - primary SMTP delivery with Resend fallback behavior and operational expectations.
- `PASSWORD_RESET_FLOW.md` - token-based reset flow, expiration behavior, and security considerations.

### Deployment
- `DEPLOYMENT.md` - production rollout steps, environment setup, and release checklist items.

## Operational Notes

- `ops/context.md` - live project snapshot and current working context.
- `ops/todo.md` - current work queue and completed tracking.
- `ops/logs.md` - execution history and batch-by-batch implementation notes.
- `ops/bugs.md` - known defects and open issues.
- `ops/metrics.md` - success criteria and tracking signals.
- `ops/variables.md` - shared constants, enums, and reference values.
- `ops/master-ai-prompt.md` - process rules and documentation hygiene guidance.

## Product Docs

- `product/01_Product_Vision.md` - product purpose, audience, and high-level direction.
- `product/02_Feature_Roadmap.md` - phased feature delivery plan.
- `product/03_System_Architecture.md` - frontend/backend architecture and reliability approach.
- `product/04_Database_Schema.md` - core entities and data relationships.
- `product/05_MVP_Scope.md` - build boundaries for the minimum shippable version.

## Upgrade Plan Notes

### Client Upgrade Plan
- [HalotaskPro-Client-UpgradePlan.md](HalotaskPro-Client-UpgradePlan.md) remains the live client-side upgrade backlog and should continue to be updated independently.

### Server Upgrade Plan
- [Server_Upgrade_Plan.docx](Server_Upgrade_Plan.docx) remains the retained server-side upgrade record.
- Key themes from the plan: auth and security hardening, CORS and schema validation tightening, startup/shutdown reliability, route validation, and broader test coverage.
- The server plan is intentionally left as a separate binary artifact so its review history stays distinct from the consolidated markdown index.

## Retention Policy

All non-upgrade docs previously scattered across `docs/`, `docs/ops/`, and `docs/product/` were consolidated into this file and removed from their original locations.
