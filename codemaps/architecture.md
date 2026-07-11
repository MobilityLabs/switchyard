> Generated: 2026-07-08 | Token-lean format for LLM context

# Architecture

Self-hosted agent-native project tracker. One service layer, three clients (MCP, REST, web UI) — no client has private powers. Node 20+, ESM, TypeScript, run via `tsx` (no build step for the server).

```
                 ┌──────────────────────── src/server.ts (Hono, :3300) ───────────────────────┐
                 │  /health   /auth/*   /api/*        /mcp (POST JSON-RPC)   /* static + SPA   │
                 └──────┬─────────┬────────┬───────────────┬─────────────────────┬────────────┘
                        │  auth-routes  api-routes    mcp/server.ts         dist/ui (vite build)
                        │         └────────┴───────────────┘
                        │                  │
                        │         src/services/*  ← ALL business logic
                        │                  │
                        │           src/db (drizzle + better-sqlite3, WAL, FK on)
                        │                  │
                        └───────── switchyard.db (SQLite; migrations auto-applied on open)
```

## Layers

| Layer | Path | Role |
|-------|------|------|
| HTTP shell | `src/server.ts` | Route mounting, MCP transport bridge (fetch-to-node), SPA fallback |
| REST adapter | `src/rest/api-routes.ts`, `auth-routes.ts`, `schemas.ts` | zod-validated thin wrappers over services |
| MCP adapter | `src/mcp/server.ts` | 12 tools, `guard()` maps `SwitchyardError` → isError result |
| Services | `src/services/*` | Business logic + server-side enforcement (see backend.md) |
| DB | `src/db/schema.ts`, `src/db/index.ts` | Drizzle tables; `openDb()` migrates from `drizzle/` |
| Web UI | `ui/src/*` | React 19 SPA, History-API router, 15s polling (no websockets) |
| Satellite processes | `scripts/*` | Worker, dreamer, slack notifier, deploy (see workers.md) |

## Auth (two parallel schemes)

| Client | Mechanism | Code path |
|--------|-----------|-----------|
| Agents (MCP + REST) | `Authorization: Bearer <token>`, sha256 hash in `actors.tokenHash` | `services/actors.ts:authenticate` |
| Humans (UI + REST) | Single-use login link (15 min) → 30-day session cookie | `services/auth.ts`, `rest/auth-routes.ts` |

Actor `type: human | agent` drives enforcement — triage exit, `done` transition, and dependency removal are human-only (in services, not prompts).

## Key invariants

- Issue state = mutable columns on `issues`, with `events` a co-written append-only audit log (not a fold/replay source); every mutation records an actor-attributed event alongside the column write. Only attention, open-PR, and unanswered-questions signals are actually derived by querying `events` (`services/attention.ts`, `pr-status.ts`, `events.ts`).
- Agent-filed issues always land in `triage` with required provenance (`sourceType`/`sourceDetail`/`sourceUrl`).
- Merging agent branches is a human decision; containers only ever push `agent/<ref>`.
- Tokens never appear in argv (env or file handoff only).

## Build / run

| Command | Effect |
|---------|--------|
| `npm run dev` | tsx src/server.ts, `SWITCHYARD_DB` (default `switchyard.db`), `PORT` (default 3300) |
| `npm run build:ui` | vite → `dist/ui`; SPA routes 404 as JSON until this exists |
| `npm test` | vitest: `tests/**` + `ui/src/**/*.test.{ts,tsx}` (jsdom) |
| `npm run typecheck` | `tsc --noEmit` && `tsc -p ui --noEmit` (two tsconfigs) |
| `npm run db:generate` | drizzle-kit generate after `src/db/schema.ts` edits |
| `npm run deploy` | tar working tree → NAS 100.85.158.109 → `sudo switchyard-deploy` container rebuild |

Admin CLI (`src/cli.ts`, first arg = db path): `add-actor <name> <human|agent>`, `add-project <KEY> <name>`, `mint-login <name>`, `add-webhook <url> [PROJECT] [secret]`, `list-webhooks`, `rm-webhook <id>`.

`worker-sdk/` is a dependency-isolated sub-package (SDK wants zod@4, app pins zod@3): `npm install --prefix worker-sdk`.
