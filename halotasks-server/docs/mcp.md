# HaloTask Pro MCP, Phase 1 (read-only) — Issue #66

## Status and switch

Phase 1 is a read-only Model Context Protocol endpoint, `POST /mcp` (Streamable HTTP, stateless, MCP TypeScript SDK v2).
It is **opt-in**: nothing is mounted unless the server is started with `MCP_ENABLED=true` (the exact string; default off).
With the flag off, `/mcp` is the ordinary unknown-route 404, and the MCP route module and the SDK packages are **never loaded**.

Why opt-in: the endpoint takes the user's session JWT (see "Authentication"), so it is off until someone chooses to expose it.

**Runtime.** The SDK packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`) are ESM-only and declare `"engines": {"node": ">=20"}`.
The CommonJS build loads them with a native dynamic `import()` (kept as written in the compiled `dist/app.js`), not `require()`, so
the `require(esm)` restriction (Node 22.12+) does not apply. Supported: **Node 20 or newer**, the SDK's own declared floor; the
server has no `engines` field of its own. Verified: the compiled CJS build was driven through a real MCP exchange (`initialize`,
`tools/list`) on **Node 20.20.2** and **22.23.5**, and the flag off/on behaviour was checked on both. CI runs Node 22 only; Node 20 is
not a CI job. Node 18 is below the SDK's floor and was not tried. The package is loaded lazily behind the flag: a load failure is logged once
(`[MCP] The MCP endpoint could not be loaded: ...`), every `/mcp` request then returns the generic 500, and the rest of the API is unaffected.

## Layers (team/projects spec D15: identity → scope → authorization → domain service)

```
MCP client ── Authorization: Bearer <HaloTask JWT> ──> /mcp
  requireAuth        existing JWT signature + tokenVersion (revoked sessions are rejected)
  mcpLimiter         per user 120/min, per IP 300/min (after auth, so it keys on the user)
  personalScope(id)  the scope is built from the AUTHENTICATED identity, never from tool input
  tool handlers      mcp/server.ts: zod-validated input, read-only annotations; import no model and no mongoose
  readService        the only module that touches the database; every query carries the owner
```

An argument named `userId`, `scope` or `projectId` in a tool call is not part of any tool's schema and changes nothing.
Project scopes are deliberately not representable yet; no project capability is advertised (it is added, additively, with the
project work).

## Authentication (an interim choice, flagged)

The endpoint reuses the existing `Authorization: Bearer <JWT>` login token: signature checked with `JWT_SECRET`, `tokenVersion`
checked against the account, so a password reset or change revokes it. There is no server-wide MCP secret.

Honest limits of that choice, which Issue #66's security section asks to be settled before this is exposed to a real AI client:
- The token is the user's **whole session** (7 days). A client that holds it can call every `/api` endpoint, not only MCP.
- It cannot be revoked per client; the only revocation is a password change/reset or its expiry.
- A client that needs OAuth (or cannot send a custom `Authorization` header) cannot use it. No real MCP client was tested.
A per-user, revocable, MCP-only credential (or OAuth) is the intended next step and is **not** part of this phase.

## Tools (all read-only, no write tool exists)

| Tool | Purpose |
| --- | --- |
| `halo_get_project_context` | Workspace context derived from the user's tasks (counts, priorities, up to 50 tags). HaloTask has no first-class project entity yet and the answer says so. |
| `halo_list_tasks` | Paginated (default 20, max 100, newest first, stable order), optional `completed`, `priority`, `tag`, literal `search`. |
| `halo_get_task` | One task of the authenticated user. |
| `halo_list_subtasks` | Embedded subtasks of one task of the authenticated user. |
| `halo_get_project_summary` | Counts plus overdue / due today / upcoming and the 5 most recently updated tasks. |

A task id that belongs to another user, does not exist, or is malformed gives the same answer, "Task not found."

Responses are an **allow-list projection**: a field reaches the client only if `readService` names it. `userId`, `completionId`,
`appliedMutations`, `clientKey` and `reminderSent` are never returned, and the context no longer echoes the user id.

### Due dates in the summary

Due dates are calendar days (Issues #41/#42). "Overdue" is judged by **day in the account's time zone**, and a timed task due
today is overdue only once its exact deadline has passed. An account with no (or an invalid) `timeZone` is read as UTC, and the
answer reports the zone it used. (The first draft compared `dueDate < now` as instants, which called every date-only task due
today overdue from midnight.)

## Verification

Server: `tests/mcp.routes.test.ts` (33 tests: the real app, real auth and limiter, the real SDK handler, strict in-memory
User/Task doubles; mutation-checked), `tests/mcp.flag.test.ts` (17 tests: the `MCP_ENABLED` opt-in, each case from a fresh module registry with a wrapped SDK load counter) and `tests/mcp.readService.realmongo.test.ts` (real MongoDB; **CI is the gate**, it cannot run
without a MongoDB binary). Not verified: any real MCP client (ChatGPT, Claude, an inspector) and real-device use.

```bash
cd halotasks-server
npm test && npm run typecheck && npm run typecheck:tests && npm run build
MCP_ENABLED=true npm run dev   # then POST /mcp with an Accept header of application/json, text/event-stream
```
