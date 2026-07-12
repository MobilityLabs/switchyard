# Out-of-band Attachment Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents attach on-disk images to an issue without base64-encoding them through an MCP tool argument, by shipping a node uploader that streams the file to the existing REST endpoint, baking it into the worker image, and pointing `attach_file` at it.

**Architecture:** No new endpoint — `POST /api/issues/:ref/attachments` already streams multipart uploads to `saveAttachment`. Add `scripts/attach.mjs` (a standalone node uploader that reads a file and POSTs it with the caller's `SWITCHYARD_TOKEN`), bake it into `Dockerfile.worker` as `switchyard-attach`, and update the `attach_file` tool description to prefer it. base64 stays as a fallback.

**Tech Stack:** Node 24 (global `fetch`/`FormData`/`Blob`), Hono (existing REST), vitest, Docker (`Dockerfile.worker`, `node:24-slim`).

## Global Constraints

- **node, not curl** — the uploader must use node built-ins; curl is not in the worker image (`node:24-slim` + git + ca-certificates only).
- **Token via env only, never argv** — read `SWITCHYARD_TOKEN` from `process.env`, never accept it as a CLI arg (tokens-never-in-argv invariant).
- **No new endpoint, no `path` param on `attach_file`** — the MCP handler is server-side; base64 stays as the MCP fallback, unchanged.
- **`saveAttachment` guarantees untouched** — type allowlist, 20MB cap, filename sanitize, no-SVG all stay as-is (SVG support is tracked separately in SYD-184).
- **Uploader is standalone/importable-by-subprocess** — kept as its own script so it's unit-testable without a container, mirroring `scripts/prime-workspace-trust.mjs`.
- Commit message convention: reference the ref, e.g. `feat: … (SYD-182)`.

---

### Task 1: `scripts/attach.mjs` uploader

**Files:**
- Create: `scripts/attach.mjs`
- Test: `tests/scripts/attach.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - An importable `export async function uploadAttachment({ url, token, ref, file }): Promise<string>` — reads `file`, POSTs it as multipart field `file` (filename = basename) to `${url}/api/issues/<ref>/attachments` with `Authorization: Bearer <token>`, returns the endpoint's raw JSON response body (`{id,url,markdown}`) on 2xx, and throws on missing `url`/`token`, a missing file (ENOENT), or a non-2xx response.
  - A CLI `node scripts/attach.mjs <ISSUE_REF> <FILE>` that reads `SWITCHYARD_URL` + `SWITCHYARD_TOKEN` from env only, calls `uploadAttachment`, prints the response to stdout, and exits 0 on success / non-zero (stderr) on failure. Env-only for the token; never argv.

> **Test mechanism note (why not a subprocess):** the repo's other `.mjs` script test (`prime-workspace-trust.test.ts`) runs the script via `execFileSync`, but that pattern cannot be verified in this project's sandboxed Bash: a spawned grandchild process (vitest worker → `execFileSync` child) is denied loopback network access, so a subprocess-hits-a-local-server test hangs. An **in-process** fetch to a local server from inside a vitest worker *does* work (probed). So the uploader exposes `uploadAttachment` and the test imports and calls it directly against an in-process capture server. The test is authored as `.mjs` (not `.ts`) because `tsconfig.json` has `allowJs` off with `include: ["scripts","tests"]`, so a `.ts` test importing `attach.mjs` would fail `tsc` with a missing-declaration error; tsc ignores `.mjs`.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/attach.test.mjs`. It imports `uploadAttachment` and exercises it against a throwaway in-process `node:http` capture server — real multipart encoding, no subprocess, no app, no Docker.

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadAttachment } from "../../scripts/attach.mjs";

let server;
let captured;
let respond;
let baseUrl;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("latin1");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

beforeEach(async () => {
  captured = null;
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 7, url: "/api/attachments/7/shot.png", markdown: "![shot.png](/api/attachments/7/shot.png)" }));
  };
  server = createServer(async (req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      auth: req.headers["authorization"] ?? "",
      body: await readBody(req),
    };
    respond(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.close();
});

function tmpFile(name, contents = "PNGBYTES") {
  const dir = mkdtempSync(path.join(tmpdir(), "attach-test-"));
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe("uploadAttachment", () => {
  it("POSTs the file to the issue's attachments endpoint and returns the response body", async () => {
    const file = tmpFile("shot.png");
    const out = await uploadAttachment({ url: baseUrl, token: "tok123", ref: "SYD-1", file });

    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/issues/SYD-1/attachments");
    expect(captured.auth).toBe("Bearer tok123");
    expect(captured.body).toContain('name="file"');
    expect(captured.body).toContain('filename="shot.png"');
    expect(out).toContain("![shot.png](/api/attachments/7/shot.png)");
  });

  it("strips a trailing slash on the base URL", async () => {
    const file = tmpFile("shot.png");
    await uploadAttachment({ url: `${baseUrl}/`, token: "tok", ref: "SYD-2", file });
    expect(captured.url).toBe("/api/issues/SYD-2/attachments");
  });

  it("throws when the token is missing", async () => {
    const file = tmpFile("shot.png");
    await expect(uploadAttachment({ url: baseUrl, token: "", ref: "SYD-1", file })).rejects.toThrow(/SWITCHYARD_TOKEN/);
  });

  it("throws when the URL is missing", async () => {
    const file = tmpFile("shot.png");
    await expect(uploadAttachment({ url: "", token: "tok", ref: "SYD-1", file })).rejects.toThrow(/SWITCHYARD_URL/);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      uploadAttachment({ url: baseUrl, token: "tok", ref: "SYD-1", file: "/no/such/file.png" }),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it("throws and surfaces the server error on a non-2xx response", async () => {
    respond = (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not an allowed attachment type" }));
    };
    const file = tmpFile("notes.txt");
    await expect(uploadAttachment({ url: baseUrl, token: "tok", ref: "SYD-1", file })).rejects.toThrow(
      /upload failed \(400\)/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/attach.test.mjs`
Expected: FAIL — `attach.mjs` doesn't exist yet, so the import fails (`Cannot find module …/scripts/attach.mjs`) and all 6 tests error.

- [ ] **Step 3: Write `scripts/attach.mjs`**

```js
#!/usr/bin/env node
// Upload a local file to a Switchyard issue as an attachment, out-of-band: the
// bytes stream straight to the tracker's REST endpoint instead of being
// base64-encoded through an MCP tool argument, which burns model output tokens
// (SYD-182). Kept standalone (and baked into the worker image as
// `switchyard-attach`) so any dispatched worker can use it regardless of the
// target repo. `uploadAttachment` is exported so it's unit-testable in-process
// without spawning a subprocess.
//
// Usage: node attach.mjs <ISSUE_REF> <FILE>
// Env:   SWITCHYARD_URL, SWITCHYARD_TOKEN  (both required; token via env, never argv)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Returns the endpoint's raw response body ({id,url,markdown} as JSON text).
// Throws on missing url/token, a missing file (ENOENT from readFile), or a
// non-2xx response.
export async function uploadAttachment({ url, token, ref, file }) {
  if (!url) throw new Error("SWITCHYARD_URL must be set");
  if (!token) throw new Error("SWITCHYARD_TOKEN must be set");

  const bytes = await readFile(file);

  const form = new FormData();
  form.set("file", new Blob([bytes]), path.basename(file));

  const endpoint = `${url.replace(/\/$/, "")}/api/issues/${ref}/attachments`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upload failed (${res.status}): ${text}`);
  }
  return text;
}

async function main() {
  const ref = process.argv[2];
  const file = process.argv[3];
  if (!ref || !file) {
    throw new Error("usage: attach.mjs <ISSUE_REF> <FILE>");
  }
  const text = await uploadAttachment({
    url: process.env.SWITCHYARD_URL,
    token: process.env.SWITCHYARD_TOKEN,
    ref,
    file,
  });
  // The endpoint returns {id,url,markdown} — print it so the caller can quote
  // the markdown snippet in a comment.
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

// Run as CLI only when invoked directly, so importing uploadAttachment in a
// test does not trigger a real upload. fetch()'s undici keep-alive agent holds
// a socket open after the response is read, keeping the event loop alive — so
// exit explicitly once the CLI is done rather than hang.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/scripts/attach.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/attach.mjs tests/scripts/attach.test.mjs
git commit -m "feat: attach.mjs — out-of-band attachment uploader (SYD-182)"
```

---

### Task 2: Bake `switchyard-attach` into the worker image

**Files:**
- Modify: `Dockerfile.worker` (add COPY + wrapper before the `USER node` line, ~line 15)
- Test: `tests/scripts/dockerfile-worker.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `scripts/attach.mjs` (Task 1).
- Produces: an on-`PATH` `switchyard-attach <ISSUE_REF> <FILE>` in the worker image that execs `node /opt/switchyard/attach.mjs`.

**Why a wrapper, not a bare rename:** a file with no extension run by node defaults to CommonJS, which breaks `attach.mjs`'s ESM `import`s. So keep the `.mjs` on disk and put a tiny shell wrapper on `PATH` that execs node on it.

- [ ] **Step 1: Write the failing test**

Append to `tests/scripts/dockerfile-worker.test.ts`:

```ts
describe("Dockerfile.worker attachment uploader (SYD-182)", () => {
  const raw = readFileSync(path.join(__dirname, "../../Dockerfile.worker"), "utf8");
  const lines = raw.split("\n").map((l) => l.trim());
  const userIndex = lines.findIndex((l) => l.startsWith("USER "));

  it("copies attach.mjs into the image before dropping root", () => {
    const copyIndex = lines.findIndex(
      (l) => l.startsWith("COPY ") && l.includes("scripts/attach.mjs"),
    );
    expect(copyIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeLessThan(userIndex);
  });

  it("installs a switchyard-attach launcher on PATH", () => {
    expect(raw).toContain("/usr/local/bin/switchyard-attach");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/dockerfile-worker.test.ts`
Expected: FAIL — no COPY of `scripts/attach.mjs`, no `/usr/local/bin/switchyard-attach`.

- [ ] **Step 3: Edit `Dockerfile.worker`**

Insert these lines immediately after the existing `RUN chmod +x /entry.sh` line and before the `RUN mkdir -p /work …` / `USER node` block:

```dockerfile
# Out-of-band attachment uploader (SYD-182): baked in so any dispatched worker
# can `switchyard-attach <ISSUE_REF> <FILE>` regardless of the target repo,
# streaming the bytes to the tracker instead of base64-ing them through an MCP
# tool arg. Shell wrapper (not a bare rename) so node runs the .mjs as ESM.
COPY scripts/attach.mjs /opt/switchyard/attach.mjs
RUN printf '#!/bin/sh\nexec node /opt/switchyard/attach.mjs "$@"\n' > /usr/local/bin/switchyard-attach \
    && chmod +x /usr/local/bin/switchyard-attach
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/scripts/dockerfile-worker.test.ts`
Expected: PASS (existing SYD-117 tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.worker tests/scripts/dockerfile-worker.test.ts
git commit -m "feat: bake switchyard-attach uploader into the worker image (SYD-182)"
```

---

### Task 3: Point `attach_file` at the uploader

**Files:**
- Modify: `src/mcp/server.ts` (the `attach_file` tool `description`, ~lines 295-299)

**Interfaces:**
- Consumes: the `switchyard-attach` command (Task 2) / `scripts/attach.mjs` (Task 1).
- Produces: no code change — only the tool description text. base64 behavior is unchanged.

- [ ] **Step 1: Edit the description**

Replace the existing `description` string in the `attach_file` registration:

```ts
      description:
        "Attach an image or short video to an issue as evidence (png/jpg/gif/webp/avif/mp4/webm/mov, " +
        "≤20MB decoded). The issue's activity feed shows a thumbnail/link for this automatically. " +
        "Also include the returned markdown snippet in your next comment when you want to call out " +
        "or discuss the attachment, not just record it.",
```

with:

```ts
      description:
        "Attach an image or short video to an issue as evidence (png/jpg/gif/webp/avif/mp4/webm/mov, " +
        "≤20MB decoded). The issue's activity feed shows a thumbnail/link for this automatically. " +
        "Also include the returned markdown snippet in your next comment when you want to call out " +
        "or discuss the attachment, not just record it. " +
        "PREFER uploading from disk instead of base64: if the file is already on disk and you have a " +
        "shell, run `switchyard-attach <ISSUE_REF> <FILE>` (dispatched workers) or " +
        "`node scripts/attach.mjs <ISSUE_REF> <FILE>` (Switchyard repo) — it streams the bytes to the " +
        "tracker without spending output tokens base64-encoding the image, and prints the same markdown. " +
        "Use content_base64 below only when you lack a shell or the SWITCHYARD_URL/SWITCHYARD_TOKEN env vars.",
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: steer attach_file toward the out-of-band uploader (SYD-182)"
```

---

### Task 4: Make on-disk landing explicit in the endpoint test

The endpoint's happy path is already covered by `tests/rest/api-attachments.test.ts`, including a byte round-trip through the GET route (which reads from `attachmentsDir`). Add one explicit assertion that the file is written to disk at the id-named path, so the disk contract is named directly rather than only implied.

**Files:**
- Modify: `tests/rest/api-attachments.test.ts` (the `"round-trips bytes and sets nosniff on GET"` test, ~lines 141-157)

- [ ] **Step 1: Add the failing/─trivially-true assertion**

Add these imports to the existing `node:fs` import at the top of the file (change line 2):

```ts
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
```

Then, inside the `"round-trips bytes and sets nosniff on GET"` test, after `const uploaded = await body<…>(await upload(ref, "shot.png", data));`, add:

```ts
    // The bytes must land on disk at the id-named path saveAttachment writes to.
    const onDisk = readFileSync(path.join(attachmentsDir, String(uploaded.id)));
    expect(onDisk.equals(data)).toBe(true);
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/rest/api-attachments.test.ts`
Expected: PASS (the write already happens; this names the contract).

- [ ] **Step 3: Commit**

```bash
git add tests/rest/api-attachments.test.ts
git commit -m "test: assert uploaded bytes land on disk (SYD-182)"
```

---

### Task 5: Full verification, deploy, and worker smoke check

**Files:** none (verification + ops).

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: all files pass (existing count + the new `attach.test.mjs` and the 2 new Dockerfile assertions).

- [ ] **Step 2: Typecheck + UI build (subagent-commit gate)**

Run: `npm run typecheck && npm run build:ui`
Expected: both clean/succeed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/syd-182-attachment-upload
gh pr create --title "feat: out-of-band attachment upload (SYD-182)" \
  --body "Ships scripts/attach.mjs (node uploader), bakes it into the worker image as switchyard-attach, and points attach_file at it. No new endpoint; base64 kept as fallback. Closes SYD-182."
```

(Push/PR need the sandbox disabled — SSH to github.com is not on the sandbox network allowlist.)

- [ ] **Step 4: Rebuild + redeploy the worker image so dispatched workers get `switchyard-attach`**

After the PR merges to main:

```bash
npm run build:worker-image
npm run deploy
```

- [ ] **Step 5: Manual worker smoke check (documented, run once)**

Dispatch a trivial UI issue to a containerized worker, have it capture a screenshot and run `switchyard-attach <REF> <shot.png>`, then confirm on the board that the attachment appears in the issue's activity feed with a thumbnail. Record the result as a comment on SYD-182.

---

## Self-Review

**Spec coverage:**
- Component 1 (`scripts/attach.mjs`) → Task 1. ✓
- Component 2 (bake into worker image) → Task 2. ✓
- Component 3 (`attach_file` description) → Task 3. ✓
- Component 4 (extend endpoint test for on-disk; `attach.mjs` unit test; manual smoke) → Task 4 (on-disk), Task 1 (unit test), Task 5 Step 5 (smoke). ✓
- Non-goals (no new endpoint, no `path` param, base64 fallback, saveAttachment untouched, SVG deferred to SYD-184) → respected; nothing in any task alters `saveAttachment` or adds a `path` param. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✓

**Type consistency:** The uploader's env var names (`SWITCHYARD_URL`, `SWITCHYARD_TOKEN`), the endpoint path (`/api/issues/<ref>/attachments`), the multipart field name (`file`), and the response shape (`{id,url,markdown}`) match across Task 1 (script + test), Task 3 (description), and the existing route in `src/rest/api-routes.ts`. The Docker path `/opt/switchyard/attach.mjs` and command name `switchyard-attach` match between Task 2's Dockerfile edit and its test / Task 3's description. ✓
