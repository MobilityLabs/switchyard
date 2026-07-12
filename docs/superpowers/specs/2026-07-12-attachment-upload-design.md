# Out-of-band attachment upload (SYD-182)

**Date:** 2026-07-12
**Issue:** SYD-182 — "attach_file's base64 transport is impractical for large images — add an out-of-band upload path"
**Status:** design approved

## Problem

`attach_file` (MCP tool, `src/mcp/server.ts:293`) accepts the image as `content_base64`. To attach anything, the agent must **generate the entire base64 blob as a tool-call argument** — burning model output tokens, bloating the transcript, and capping ~20MB decoded. We want agents to routinely attach screenshots for UI work and diagrams for architecture work (SYD-183); base64-through-the-model makes that expensive enough to discourage it.

## Premise correction (what already exists)

The out-of-band upload path is **already built** and does not use base64:

- `POST /api/issues/:ref/attachments` (`src/rest/api-routes.ts:263`) — Hono route with `bodyLimit` (21MB) + `parseBody()` multipart. Reads the `file` field, calls the shared `saveAttachment`, returns `{ id, url, markdown }`.
- `saveAttachment` (`src/services/attachments.ts`) writes bytes to a file on disk in `ATTACHMENTS_DIR` (one file per id); only metadata is in the DB. Enforces the type allowlist, 20MB cap, filename sanitization, and no-SVG.
- Workers already have the credentials: `SWITCHYARD_URL` + `SWITCHYARD_TOKEN` in env (`scripts/worker-select.ts`), and that bearer token authenticates the REST API (`app.use("*")` in `api-routes.ts`).
- Workers already have `Bash` (DEFAULT_ALLOWED_TOOLS), `node` (image is `node:24-slim`), and egress to the tracker host (the egress proxy allows the tracker host, which serves both `/mcp` and `/api`).

**Therefore the gap is ergonomics and discoverability, not infrastructure.** Agents reach for `attach_file` (base64) because it is the only tool that mentions attaching. Nothing tells them the cheaper HTTP path exists or how to auth it.

### Rejected: a `path` parameter on `attach_file`

The MCP handler runs **server-side** (workers connect to `/mcp` over HTTP, in isolated containers with **no shared volume**). A `path` param would read the *server's* filesystem, not the caller's screenshot. And any MCP-tool transport inherently requires the model to generate the argument, so base64 is unavoidable *through MCP*. The only way to keep bytes out of the model is a non-MCP channel — direct HTTP upload — which already exists. No `path` param.

## Design

### Component 1 — `scripts/attach.mjs` (the uploader)

A small Node script; the mechanism for uploading an on-disk file out-of-band.

- **Invocation:** `node attach.mjs <ISSUE_REF> <FILE>` (installed in the worker image as `switchyard-attach <ISSUE_REF> <FILE>`).
- **Behavior:** validate args and that the file exists; require `SWITCHYARD_URL` and `SWITCHYARD_TOKEN` in env; read the file; POST it as multipart (`fetch` + `FormData` + `Blob`, all global in Node 24) to `${SWITCHYARD_URL%/}/api/issues/<ref>/attachments` with `Authorization: Bearer ${SWITCHYARD_TOKEN}`; on success print the returned JSON (`{id, url, markdown}`) to stdout so the agent can quote the markdown in a comment; on failure print the server error to stderr and exit non-zero.
- **Why node, not curl:** curl is not in the worker image (`node:24-slim` + `git` + `ca-certificates` only). node is guaranteed present.
- **Dependencies:** none beyond Node's built-ins and the two env vars.

### Component 2 — bake it into the worker image

A dispatched worker for a non-Switchyard project has that project's repo as cwd, so a repo-relative `scripts/attach.mjs` is not present. `Dockerfile.worker` will `COPY scripts/attach.mjs` to a fixed location and install a `switchyard-attach` entry on `PATH` (e.g. `/usr/local/bin/switchyard-attach` wrapping `node /opt/switchyard/attach.mjs "$@"`). Every dispatched worker can then run `switchyard-attach <ref> <file>` regardless of target repo.

- Requires `npm run build:worker-image` + redeploy of the worker image.
- `scripts/attach.mjs` in the repo remains the single source of truth; the Dockerfile copies it in.

### Component 3 — steer agents to it (`attach_file` description)

Update the `attach_file` MCP tool description: for a file already on disk, **prefer** `switchyard-attach <ref> <file>` (or, outside a worker, `node scripts/attach.mjs <ref> <file>`) — it uploads the bytes directly and avoids spending output tokens base64-encoding the image. Use `content_base64` only when you lack a shell or the env vars. base64 stays as a working fallback; the tool's behavior is unchanged.

### Component 4 — verification (enable + verify e2e)

The REST endpoint is **already covered** by `tests/rest/api-attachments.test.ts`: a real multipart upload → 200 + `{id, url, markdown}` + `attachment_added` event + `listAttachments`, plus SVG and >20MB rejection. So the residual testing work is:

- **Extend `tests/rest/api-attachments.test.ts`** with one assertion the suite lacks: after a successful upload, the bytes exist on disk under the test `attachmentsDir` (`readFileSync(path.join(dir, String(id)))` equals the uploaded buffer). This is the one link — "the file actually lands on disk" — the current suite implies but never checks.
- **Unit test for `attach.mjs`** (`tests/scripts/attach.test.ts`): with `fetch` mocked, assert it (a) errors clearly when `SWITCHYARD_URL`/`SWITCHYARD_TOKEN` are missing or the file does not exist, (b) POSTs to `${URL}/api/issues/<ref>/attachments` with the bearer header and a `file` multipart field named after the file's basename, (c) prints the server's returned markdown on success and exits non-zero on an error response. Factor `attach.mjs` so the upload function is importable/testable without spawning a process (mirrors the `worker-select.ts` "unit-testable without spawning docker" pattern).
- **Manual worker smoke check** (documented, run once after redeploy): dispatch a trivial UI issue, have the worker run `switchyard-attach` on a screenshot, confirm the attachment lands on the issue and renders in the feed.

## Non-goals / unchanged

- No new REST endpoint; no `path` param on `attach_file`.
- `saveAttachment`'s guarantees (type allowlist, 20MB cap, filename sanitize, no-SVG) are untouched.
- base64 `attach_file` remains as a fallback.
- The *norm* of when to attach (UI → screenshot, architecture → diagram) is SYD-183; this issue only makes the upload cheap and reachable.

## Security

- No new attack surface: the REST endpoint, its auth, and `saveAttachment`'s validation already exist and are unchanged.
- `SWITCHYARD_TOKEN` stays in env, never in argv (consistent with the tokens-never-in-argv invariant). `attach.mjs` reads it from `process.env`.
- The uploader only reads a caller-supplied local file and streams it to the caller's own tracker; it grants no new capability the caller didn't already have via curl/fetch.
