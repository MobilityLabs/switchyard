# Delivery Gate (SYD-49) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Code from unattended agent sessions never lands on `main` or the NAS until a human stamps the issue `done` — workers open PRs, a delivery worker merges + deploys on the done-stamp.

**Architecture:** Three pieces. (1) `scripts/agent-worker.ts` gains a post-exit publish step for containerized dispatches: push `agent/<ref>` to GitHub and open a PR (`gh` lives on the host; containers keep zero GitHub credentials). (2) A new long-lived `scripts/deliver.ts` polls `GET /api/events` for `status_changed → done` (only humans can produce that event — server-enforced), merges the matching open `agent/<ref>` PR, deploys from a dedicated clean clone (never Sean's working tree), and comments the merge SHA + deploy result on the issue. (3) A one-time attempt to enable branch protection on `main` (block force-push/deletion), with the expected private-repo/free-plan failure documented as the SYD-19 upgrade path. Pure decision logic goes in a new `scripts/delivery-lib.ts` (unit-tested); process exec stays in a thin `scripts/delivery-exec.ts`.

**Tech Stack:** TypeScript ESM via `tsx`, Node `child_process.execFile` (never a shell — PR titles contain issue text), `gh` CLI, vitest.

## Global Constraints

- Interactive Claude sessions keep direct merges; ONLY unattended agent work (containerized dispatches producing `agent/<ref>` branches) is gated.
- Tokens never appear in argv (repo rule) — `SWITCHYARD_TOKEN` comes from env / repo `.env` (0600); `gh` uses its own keyring auth.
- Deploys run from a dedicated clean clone, never from a working tree. Default clone root: `~/.switchyard/deliver-clones/<PROJECT_KEY>`.
- All subprocess calls use `execFile` with argv arrays — no shell interpolation anywhere.
- GitHub repo: `MobilityLabs/switchyard`, default branch `main`, remote name `origin`.
- Pure logic is unit-tested; exec wrappers stay thin and are exercised by the live dry run in Task 6.
- Run tests with `npx vitest run <file>`; typecheck with `npm run typecheck`.

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `scripts/delivery-lib.ts` | create | Pure: deliverable-event selection, branch/PR/merge argv builders, comment bodies, cursor parsing, output tail |
| `scripts/delivery-exec.ts` | create | Thin execFile wrappers: publish branch→PR, find/merge PR, ensure clean clone, run deploy |
| `scripts/deliver.ts` | create | Entry: poll loop, cursor persistence, per-ref delivery, REST comment, `--once`/`--dry-run` |
| `scripts/pidfile.ts` | create | `acquirePidLock` extracted from agent-worker so deliver.ts can reuse it |
| `scripts/agent-worker.ts` | modify | Use `acquirePidLock`; publish on containerized exit |
| `scripts/worker-select.ts` | modify | Add `delivery?: DeliveryConfig` to `WorkerConfig` |
| `scripts/init-worker-lib.ts` | modify | Validate the `delivery` block |
| `switchyard-worker.example.json` | modify | Show the `delivery` block |
| `tests/scripts/delivery-lib.test.ts` | create | Unit tests for all pure logic |
| `tests/scripts/pidfile.test.ts` | create | Lock/reclaim/contention tests |
| `tests/init-worker-lib.test.ts` | modify | `delivery` validation cases |
| `README.md` | modify | "Delivery gate" section |
| `codemaps/workers.md` | modify | Add deliver.ts to the satellite-process map |

---

### Task 1: Pure delivery logic (`scripts/delivery-lib.ts`)

**Files:**
- Create: `scripts/delivery-lib.ts`
- Test: `tests/scripts/delivery-lib.test.ts`

**Interfaces:**
- Consumes: `projectKeyOf(ref)` from `scripts/worker-select.js`.
- Produces (used by Tasks 4–5): `agentBranch(ref): string`, `findDeliverableRefs(feed, projectKeys, lastEventId): {refs: string[], lastEventId: number|null}`, `buildPushArgs(ref): string[]`, `buildPrListArgs(ref): string[]`, `buildPrCreateArgs(ref, issueTitle, serverUrl): string[]`, `buildPrMergeArgs(prNumber): string[]`, `buildPrTitle(ref, issueTitle): string`, `buildPrBody(ref, serverUrl): string`, `deliveryComment(r: DeliveryResult): string`, `deliveryFailureComment(ref, message): string`, `parseCursorText(text): number|null`, `tailOf(text, maxLines?, maxChars?): string`, `type DeliveryFeedEvent`, `type DeliveryResult`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scripts/delivery-lib.test.ts
import { describe, it, expect } from "vitest";
import {
  agentBranch,
  findDeliverableRefs,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrTitle,
  buildPrBody,
  deliveryComment,
  deliveryFailureComment,
  parseCursorText,
  tailOf,
  type DeliveryFeedEvent,
} from "../../scripts/delivery-lib.js";

const ev = (o: Partial<DeliveryFeedEvent>): DeliveryFeedEvent => ({
  id: 1,
  type: "status_changed",
  issue: "SYD-9",
  payload: { from: "in_review", to: "done" },
  ...o,
});

describe("findDeliverableRefs", () => {
  const keys = ["SYD"];

  it("null cursor initializes to newest id without firing on history", () => {
    const feed = [ev({ id: 7 }), ev({ id: 3 })];
    expect(findDeliverableRefs(feed, keys, null)).toEqual({ refs: [], lastEventId: 7 });
  });

  it("empty feed leaves the cursor untouched", () => {
    expect(findDeliverableRefs([], keys, null)).toEqual({ refs: [], lastEventId: null });
    expect(findDeliverableRefs([], keys, 5)).toEqual({ refs: [], lastEventId: 5 });
  });

  it("fires on status_changed→done newer than the cursor", () => {
    const feed = [ev({ id: 10 })];
    expect(findDeliverableRefs(feed, keys, 5)).toEqual({ refs: ["SYD-9"], lastEventId: 10 });
  });

  it("ignores events at or below the cursor", () => {
    expect(findDeliverableRefs([ev({ id: 5 })], keys, 5).refs).toEqual([]);
  });

  it("ignores non-done transitions and other event types", () => {
    const feed = [
      ev({ id: 11, payload: { from: "todo", to: "in_progress" } }),
      ev({ id: 12, type: "commented", payload: {} }),
    ];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual([]);
  });

  it("ignores unconfigured projects and dedupes refs", () => {
    const feed = [ev({ id: 11, issue: "OTHER-1" }), ev({ id: 12 }), ev({ id: 13 })];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual(["SYD-9"]);
  });

  it("never moves the cursor backwards", () => {
    expect(findDeliverableRefs([ev({ id: 3 })], keys, 9).lastEventId).toBe(9);
  });
});

describe("argv builders", () => {
  it("agentBranch", () => {
    expect(agentBranch("SYD-9")).toBe("agent/SYD-9");
  });

  it("buildPushArgs", () => {
    expect(buildPushArgs("SYD-9")).toEqual(["push", "origin", "agent/SYD-9"]);
  });

  it("buildPrListArgs", () => {
    expect(buildPrListArgs("SYD-9")).toEqual([
      "pr", "list", "--head", "agent/SYD-9", "--state", "open", "--json", "number",
    ]);
  });

  it("buildPrCreateArgs embeds title and body as discrete argv entries", () => {
    const args = buildPrCreateArgs("SYD-9", "Fix the; thing `rm -rf`", "http://host:3300/");
    expect(args.slice(0, 5)).toEqual(["pr", "create", "--base", "main", "--head"]);
    expect(args).toContain("agent/SYD-9");
    expect(args).toContain("SYD-9: Fix the; thing `rm -rf`");
    expect(args.join(" ")).toContain("http://host:3300/issue/SYD-9");
  });

  it("buildPrMergeArgs", () => {
    expect(buildPrMergeArgs(41)).toEqual(["pr", "merge", "41", "--merge", "--delete-branch"]);
  });

  it("buildPrTitle / buildPrBody", () => {
    expect(buildPrTitle("SYD-9", "A title")).toBe("SYD-9: A title");
    expect(buildPrBody("SYD-9", "http://host:3300")).toContain("http://host:3300/issue/SYD-9");
  });
});

describe("comment bodies", () => {
  it("success with deploy", () => {
    const body = deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: true, ok: true, tail: "done" } });
    expect(body).toContain("PR #41");
    expect(body).toContain("abc123");
    expect(body).toContain("Deploy: succeeded");
  });

  it("deploy failure includes the output tail", () => {
    const body = deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: true, ok: false, tail: "boom" } });
    expect(body).toContain("Deploy: FAILED");
    expect(body).toContain("boom");
  });

  it("deploy skipped", () => {
    expect(deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: false } }))
      .toContain("Deploy: skipped");
  });

  it("failure comment names the ref and reason", () => {
    const body = deliveryFailureComment("SYD-9", "merge conflict");
    expect(body).toContain("SYD-9");
    expect(body).toContain("merge conflict");
  });
});

describe("parseCursorText", () => {
  it("parses a plain integer", () => {
    expect(parseCursorText("42\n")).toBe(42);
  });
  it("rejects junk", () => {
    expect(parseCursorText("")).toBeNull();
    expect(parseCursorText("abc")).toBeNull();
    expect(parseCursorText("-3")).toBeNull();
    expect(parseCursorText("1.5")).toBeNull();
  });
});

describe("tailOf", () => {
  it("keeps the last N lines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const tail = tailOf(text, 20);
    expect(tail.startsWith("line10")).toBe(true);
    expect(tail.endsWith("line29")).toBe(true);
  });
  it("caps total characters", () => {
    expect(tailOf("x".repeat(5000), 20, 2000).length).toBe(2000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/delivery-lib.js'`

- [ ] **Step 3: Write the implementation**

```ts
// scripts/delivery-lib.ts
// Pure logic for the delivery gate (SYD-49): selecting human done-stamps off
// the event feed, building the git/gh argv for publishing and merging
// agent/<ref> PRs, and formatting the comments deliver.ts posts back. I/O-free
// so it's trivially unit-testable; the exec side lives in delivery-exec.ts.

import { projectKeyOf } from "./worker-select.js";

/** The subset of a GET /api/events row the delivery worker needs. */
export type DeliveryFeedEvent = {
  id: number;
  type: string;
  issue: string; // "<PROJECT>-<number>"
  payload: Record<string, unknown>;
};

export const MAIN_BRANCH = "main";

export function agentBranch(ref: string): string {
  return `agent/${ref}`;
}

/**
 * Scans the global event feed for done-stamps (status_changed → done) newer
 * than `lastEventId` on configured projects. Only human actors can move an
 * issue to done (server-enforced), so every match is a human approval — the
 * delivery gate's trigger. Same cursor semantics as findResumeRefs: a null
 * cursor initializes to the newest event id without firing on history, so a
 * fresh deliver.ts never replays old approvals.
 */
export function findDeliverableRefs(
  feed: DeliveryFeedEvent[],
  projectKeys: Iterable<string>,
  lastEventId: number | null
): { refs: string[]; lastEventId: number | null } {
  if (feed.length === 0) return { refs: [], lastEventId };
  const keys = new Set(projectKeys);
  const newestId = Math.max(...feed.map((e) => e.id));
  if (lastEventId === null) return { refs: [], lastEventId: newestId };

  const refs = new Set<string>();
  for (const e of feed) {
    if (e.id <= lastEventId) continue;
    if (e.type !== "status_changed") continue;
    if (e.payload?.to !== "done") continue;
    if (!keys.has(projectKeyOf(e.issue))) continue;
    refs.add(e.issue);
  }
  return { refs: [...refs], lastEventId: Math.max(newestId, lastEventId) };
}

export function buildPrTitle(ref: string, issueTitle: string): string {
  return `${ref}: ${issueTitle}`;
}

export function buildPrBody(ref: string, serverUrl: string): string {
  return [
    `Agent work for Switchyard issue **${ref}**.`,
    "",
    `Issue: ${serverUrl.replace(/\/$/, "")}/issue/${ref}`,
    "",
    "Merged automatically by scripts/deliver.ts when a human moves the issue to done.",
  ].join("\n");
}

// argv builders are pure so tests can assert exact argument vectors; every
// caller passes them to execFile (never a shell), so issue-title content can
// never be interpreted.

export function buildPushArgs(ref: string): string[] {
  return ["push", "origin", agentBranch(ref)];
}

export function buildPrListArgs(ref: string): string[] {
  return ["pr", "list", "--head", agentBranch(ref), "--state", "open", "--json", "number"];
}

export function buildPrCreateArgs(ref: string, issueTitle: string, serverUrl: string): string[] {
  return [
    "pr", "create",
    "--base", MAIN_BRANCH,
    "--head", agentBranch(ref),
    "--title", buildPrTitle(ref, issueTitle),
    "--body", buildPrBody(ref, serverUrl),
  ];
}

export function buildPrMergeArgs(prNumber: number): string[] {
  return ["pr", "merge", String(prNumber), "--merge", "--delete-branch"];
}

export type DeliveryResult = {
  prNumber: number;
  mergeSha: string;
  deploy: { ran: false } | { ran: true; ok: boolean; tail: string };
};

export function deliveryComment(r: DeliveryResult): string {
  const lines = [`Delivered: merged PR #${r.prNumber} at \`${r.mergeSha}\`.`];
  if (!r.deploy.ran) {
    lines.push("Deploy: skipped (no deploy script in the merged project).");
  } else if (r.deploy.ok) {
    lines.push("Deploy: succeeded.");
  } else {
    lines.push("Deploy: FAILED — output tail:", "```", r.deploy.tail, "```");
  }
  return lines.join("\n");
}

export function deliveryFailureComment(ref: string, message: string): string {
  return (
    `Delivery FAILED for ${ref}: ${message}\n` +
    `The agent PR was not delivered — check scripts/deliver.ts logs, resolve, ` +
    `and re-stamp the issue done (or merge manually).`
  );
}

/** Contents of .superpowers/deliver-cursor — the last processed event id. */
export function parseCursorText(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && text.trim() !== "" ? n : null;
}

/** Last `maxLines` lines of subprocess output, capped at `maxChars`. */
export function tailOf(text: string, maxLines = 20, maxChars = 2000): string {
  const tail = text.trimEnd().split("\n").slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean

```bash
git add scripts/delivery-lib.ts tests/scripts/delivery-lib.test.ts
git commit -m "feat: pure delivery-gate logic — done-stamp selection, PR argv, comments (SYD-49)"
```

---

### Task 2: Config surface — `delivery` block

**Files:**
- Modify: `scripts/worker-select.ts` (WorkerConfig type, after the `runner` field ~line 34)
- Modify: `scripts/init-worker-lib.ts` (validateWorkerConfig, before the final `return problems`)
- Modify: `switchyard-worker.example.json`
- Test: `tests/init-worker-lib.test.ts` (append cases)

**Interfaces:**
- Produces: `WorkerConfig.delivery?: DeliveryConfig` with `openPrs?: boolean` (default true), `pollSeconds?: number` (default 30), `cloneDir?: string` (default `~/.switchyard/deliver-clones`), `deploy?: boolean` (default true). Tasks 4–5 read these.

- [ ] **Step 1: Write the failing tests**

Append to `tests/init-worker-lib.test.ts` (inside the existing `validateWorkerConfig` describe block if present, else a new one; base config: copy a passing config literal already used in that file):

```ts
describe("validateWorkerConfig delivery block", () => {
  const base = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo" } },
  };

  it("accepts a valid delivery block", () => {
    expect(validateWorkerConfig({
      ...base,
      delivery: { openPrs: true, pollSeconds: 30, cloneDir: "/tmp/clones", deploy: false },
    })).toEqual([]);
  });

  it("accepts an absent delivery block", () => {
    expect(validateWorkerConfig(base)).toEqual([]);
  });

  it("rejects a non-object delivery block", () => {
    expect(validateWorkerConfig({ ...base, delivery: "yes" }).join()).toContain("delivery");
  });

  it("rejects bad field types", () => {
    const problems = validateWorkerConfig({
      ...base,
      delivery: { openPrs: "true", pollSeconds: -5, cloneDir: "", deploy: 1 },
    });
    expect(problems.some((p) => p.includes("delivery.openPrs"))).toBe(true);
    expect(problems.some((p) => p.includes("delivery.pollSeconds"))).toBe(true);
    expect(problems.some((p) => p.includes("delivery.cloneDir"))).toBe(true);
    expect(problems.some((p) => p.includes("delivery.deploy"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/init-worker-lib.test.ts`
Expected: FAIL — valid `delivery` block currently passes (no error) but bad-type cases produce no problems, so the `rejects` tests fail.

- [ ] **Step 3: Implement**

In `scripts/worker-select.ts`, after the `runner?: "cli" | "sdk";` field of `WorkerConfig`:

```ts
  /** Delivery gate (SYD-49): worker-side PR publishing + deliver.ts settings. */
  delivery?: DeliveryConfig;
```

and above the `WorkerConfig` type:

```ts
export type DeliveryConfig = {
  /** Open a GitHub PR when a containerized session pushes agent/<ref> (default true). */
  openPrs?: boolean;
  /** How often deliver.ts scans the event feed for human done-stamps (default 30s). */
  pollSeconds?: number;
  /** Where deliver.ts keeps its clean deploy clones (default ~/.switchyard/deliver-clones). */
  cloneDir?: string;
  /** Run the merged project's `npm run deploy` after merging (default true). */
  deploy?: boolean;
};
```

In `scripts/init-worker-lib.ts`, inside `validateWorkerConfig` before the final `return problems;`:

```ts
  if (c.delivery !== undefined) {
    if (typeof c.delivery !== "object" || c.delivery === null || Array.isArray(c.delivery)) {
      problems.push("`delivery` must be an object");
    } else {
      const d = c.delivery as Record<string, unknown>;
      if (d.pollSeconds !== undefined && (typeof d.pollSeconds !== "number" || !(d.pollSeconds > 0))) {
        problems.push("`delivery.pollSeconds` must be a positive number");
      }
      if (d.cloneDir !== undefined && (typeof d.cloneDir !== "string" || d.cloneDir.trim() === "")) {
        problems.push("`delivery.cloneDir` must be a non-empty path");
      }
      for (const key of ["openPrs", "deploy"] as const) {
        if (d[key] !== undefined && typeof d[key] !== "boolean") {
          problems.push(`\`delivery.${key}\` must be true or false`);
        }
      }
    }
  }
```

In `switchyard-worker.example.json`, add after `"runner": "cli"`:

```json
  "delivery": {
    "openPrs": true,
    "pollSeconds": 30,
    "deploy": true
  }
```

(keep valid JSON — add the comma on the previous line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/init-worker-lib.test.ts && npm run typecheck`
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add scripts/worker-select.ts scripts/init-worker-lib.ts switchyard-worker.example.json tests/init-worker-lib.test.ts
git commit -m "feat: delivery config block in switchyard-worker.json (SYD-49)"
```

---

### Task 3: Extract `acquirePidLock` (`scripts/pidfile.ts`)

**Files:**
- Create: `scripts/pidfile.ts`
- Modify: `scripts/agent-worker.ts:78-107` (replace `acquireLock` with the shared helper)
- Test: `tests/scripts/pidfile.test.ts`

**Interfaces:**
- Produces: `acquirePidLock(lockPath: string, hint?: string): () => void` — throws if a live process holds the lock; reclaims stale files; returns a release function. Task 5 consumes it for `.superpowers/deliver.pid`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scripts/pidfile.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquirePidLock } from "../../scripts/pidfile.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("acquirePidLock", () => {
  it("writes our pid and releases cleanly", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "sub", "worker.pid"); // parent dir is created
    const release = acquirePidLock(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws while a live process holds the lock", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "worker.pid");
    writeFileSync(lockPath, String(process.pid)); // we are definitely alive
    expect(() => acquirePidLock(lockPath, "stop it first")).toThrow(/already running/);
  });

  it("reclaims a stale lock from a dead pid", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pidlock-"));
    const lockPath = path.join(dir, "worker.pid");
    writeFileSync(lockPath, "999999"); // beyond macOS/Linux default pid range
    const release = acquirePidLock(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/pidfile.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/pidfile.js'`

- [ ] **Step 3: Implement**

```ts
// scripts/pidfile.ts
// Single-instance pidfile lock shared by the long-lived loops (agent-worker,
// deliver): a live pid in the file blocks startup; stale files from crashed
// processes are reclaimed. Not safe against two processes racing the same
// path simultaneously — good enough for "don't run two loops by accident".

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

export function acquirePidLock(lockPath: string, hint = "stop it first"): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws ESRCH if no such process
        throw new Error(`another instance is already running (pid ${pid}, ${lockPath}) — ${hint}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        // Stale pidfile from a crash — reclaim it.
      }
    }
  }
  writeFileSync(lockPath, String(process.pid));
  return () => {
    try { rmSync(lockPath); } catch { /* already gone */ }
  };
}
```

In `scripts/agent-worker.ts`: delete the whole `acquireLock` function (lines 78–107) and its now-unused fs imports if any become unused (`openSync`/`closeSync` etc. stay — check with typecheck). Add to the imports:

```ts
import { acquirePidLock } from "./pidfile.js";
```

Replace the call in `main()`:

```ts
  const releaseLock = acquirePidLock(
    path.join(repoRoot(), ".superpowers", "worker.pid"),
    "stop it first (launchctl unload ~/Library/LaunchAgents/com.switchyard.worker.plist, or kill the pid)"
  );
```

- [ ] **Step 4: Run tests + full suite to verify nothing broke**

Run: `npx vitest run tests/scripts/pidfile.test.ts && npx vitest run tests/scripts/agent-worker.test.ts && npm run typecheck`
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add scripts/pidfile.ts scripts/agent-worker.ts tests/scripts/pidfile.test.ts
git commit -m "refactor: extract pidfile lock for reuse by deliver.ts (SYD-49)"
```

---

### Task 4: Publish agent branches as PRs on container exit

**Files:**
- Create: `scripts/delivery-exec.ts`
- Modify: `scripts/agent-worker.ts:203-211` (containerized `child.on("exit")` handler in `dispatch()`)

**Interfaces:**
- Consumes: argv builders + `agentBranch`/`tailOf` from `scripts/delivery-lib.js` (Task 1); `WorkerConfig.delivery` (Task 2).
- Produces (Task 5 also consumes): `run(cmd, args, opts?): Promise<string>`, `publishAgentBranch(repo, ref, issueTitle, serverUrl): Promise<string>`, `findOpenAgentPr(repo, ref): Promise<number|null>`, `mergeAgentPr(repo, prNumber): Promise<string>` (returns merge SHA), `ensureCleanClone(sourceRepo, cloneDir): Promise<void>`, `runDeploy(cloneDir): Promise<{ran:false}|{ran:true; ok:boolean; tail:string}>`.

- [ ] **Step 1: Implement the exec module**

No unit tests for this file — it is a thin wrapper over `git`/`gh`/`npm` argv already unit-tested in Task 1; it gets exercised live in Task 6. Keep every function free of decision logic beyond "which command next".

```ts
// scripts/delivery-exec.ts
// Thin subprocess wrappers for the delivery gate. All decision logic (which
// events fire, exact argv, comment text) lives in delivery-lib.ts and is
// unit-tested there; this file only sequences git/gh/npm calls. Everything
// uses execFile — never a shell — so issue-title content is inert.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  agentBranch,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  tailOf,
  MAIN_BRANCH,
} from "./delivery-lib.js";

const execFileP = promisify(execFile);

export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Host-side publish step after a containerized session exits: if the session
 * pushed agent/<ref> into the host repo with commits ahead of main, push the
 * branch to GitHub and open a PR (unless one is already open). Returns a
 * human-readable outcome for the worker log. gh runs on the host with the
 * user's keyring auth — containers never see GitHub credentials.
 */
export async function publishAgentBranch(
  repo: string,
  ref: string,
  issueTitle: string,
  serverUrl: string
): Promise<string> {
  const branch = agentBranch(ref);
  try {
    await run("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return `no ${branch} branch in ${repo} — nothing to publish`;
  }
  const ahead = await run("git", ["-C", repo, "rev-list", `${MAIN_BRANCH}..${branch}`, "--count"]);
  if (ahead === "0") return `${branch} has no commits ahead of ${MAIN_BRANCH} — nothing to publish`;

  await run("git", ["-C", repo, ...buildPushArgs(ref)]);
  const open = JSON.parse(await run("gh", buildPrListArgs(ref), { cwd: repo })) as { number: number }[];
  if (open.length > 0) return `pushed ${branch}; PR #${open[0].number} already open`;
  const url = await run("gh", buildPrCreateArgs(ref, issueTitle, serverUrl), { cwd: repo });
  return `opened PR for ${branch}: ${url}`;
}

export async function findOpenAgentPr(repo: string, ref: string): Promise<number | null> {
  const open = JSON.parse(await run("gh", buildPrListArgs(ref), { cwd: repo })) as { number: number }[];
  return open.length > 0 ? open[0].number : null;
}

/** Merges the PR (merge commit, deletes the remote branch) and returns the merge SHA. */
export async function mergeAgentPr(repo: string, prNumber: number): Promise<string> {
  await run("gh", buildPrMergeArgs(prNumber), { cwd: repo });
  return run(
    "gh",
    ["pr", "view", String(prNumber), "--json", "mergeCommit", "--jq", ".mergeCommit.oid"],
    { cwd: repo }
  );
}

/**
 * Deploys must never run from a working tree (stale/dirty trees must not be
 * shippable) — keep a dedicated clone hard-reset to origin/main instead.
 */
export async function ensureCleanClone(sourceRepo: string, cloneDir: string): Promise<void> {
  if (!existsSync(path.join(cloneDir, ".git"))) {
    const remote = await run("git", ["-C", sourceRepo, "remote", "get-url", "origin"]);
    mkdirSync(path.dirname(cloneDir), { recursive: true });
    await run("git", ["clone", remote, cloneDir]);
  }
  await run("git", ["-C", cloneDir, "fetch", "origin", MAIN_BRANCH]);
  await run("git", ["-C", cloneDir, "reset", "--hard", `origin/${MAIN_BRANCH}`]);
  await run("git", ["-C", cloneDir, "clean", "-fd"]);
}

/** Runs the project's `npm run deploy` from the clean clone, if it has one. */
export async function runDeploy(
  cloneDir: string
): Promise<{ ran: false } | { ran: true; ok: boolean; tail: string }> {
  const pkgPath = path.join(cloneDir, "package.json");
  if (!existsSync(pkgPath)) return { ran: false };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.deploy) return { ran: false };
  try {
    const out = await run("npm", ["run", "deploy"], { cwd: cloneDir });
    return { ran: true, ok: true, tail: tailOf(out) };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ran: true, ok: false, tail: tailOf(`${e.stdout ?? ""}\n${e.stderr ?? e.message}`) };
  }
}
```

- [ ] **Step 2: Wire the publish step into `agent-worker.ts`**

Add to imports:

```ts
import { publishAgentBranch } from "./delivery-exec.js";
```

Replace the containerized-relevant `child.on("exit", ...)` handler in `dispatch()` (currently lines 203–211) with:

```ts
  child.on("exit", (code) => {
    active.delete(issue.ref);
    console.log(`${issue.ref} exited with code ${code}`);
    const logLine = (text: string) => {
      try {
        appendFileSync(logPath, text);
      } catch (err) {
        console.error(`could not append to ${logPath}: ${(err as Error).message}`);
      }
    };
    logLine(`\n[worker] exited with code ${code}\n`);
    // Delivery gate (SYD-49): a containerized session that pushed agent/<ref>
    // gets its branch published to GitHub as a PR, host-side (gh + git auth
    // live here, never in the container). Merging still waits for a human
    // done-stamp via scripts/deliver.ts.
    if (config.containerized && config.delivery && config.delivery.openPrs !== false) {
      publishAgentBranch(project.repo, issue.ref, issue.title, config.url)
        .then((outcome) => {
          console.log(`${issue.ref}: ${outcome}`);
          logLine(`[worker] ${outcome}\n`);
        })
        .catch((err: Error) => {
          console.error(`publish failed for ${issue.ref}: ${err.message}`);
          logLine(`[worker] publish failed: ${err.message}\n`);
        });
    }
  });
```

- [ ] **Step 3: Verify types and existing tests**

Run: `npm run typecheck && npx vitest run tests/scripts/`
Expected: clean / PASS (no existing worker behavior changed when `delivery` is absent — the guard requires `config.delivery`)

- [ ] **Step 4: Commit**

```bash
git add scripts/delivery-exec.ts scripts/agent-worker.ts
git commit -m "feat: worker publishes agent/<ref> branches as GitHub PRs on container exit (SYD-49)"
```

---

### Task 5: The delivery worker (`scripts/deliver.ts`)

**Files:**
- Create: `scripts/deliver.ts`
- Modify: `README.md` (new "## Delivery gate" section after "### Containerized mode")
- Modify: `codemaps/workers.md` (add deliver.ts entry)

**Interfaces:**
- Consumes: `findDeliverableRefs`, `parseCursorText`, `deliveryComment`, `deliveryFailureComment` (Task 1); `findOpenAgentPr`, `mergeAgentPr`, `ensureCleanClone`, `runDeploy` (Task 4); `acquirePidLock` (Task 3); `projectKeyOf`, `newTickGate`, `runGated`, `validateWorkerConfig` (existing); `WorkerConfig.delivery` (Task 2).

- [ ] **Step 1: Implement the entry script**

```ts
// scripts/deliver.ts
// Delivery worker (SYD-49): watches the event feed for a HUMAN stamping an
// issue done (agents can't — server-enforced) and delivers the matching agent
// work: merges the open agent/<ref> PR, deploys from a dedicated clean clone
// (never a working tree), and comments the merge SHA + deploy result on the
// issue. Issues without an open agent PR (interactive work) are skipped.
//
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts            # loop forever
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --once     # single scan
//   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --dry-run  # print, don't merge
//
// Config: the `delivery` block of switchyard-worker.json (pollSeconds,
// cloneDir, deploy). The event cursor persists in .superpowers/deliver-cursor
// so approvals stamped while this worker is down are delivered on restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, validateWorkerConfig } from "./init-worker-lib.js";
import { projectKeyOf, newTickGate, runGated, type WorkerConfig } from "./worker-select.js";
import {
  findDeliverableRefs,
  parseCursorText,
  deliveryComment,
  deliveryFailureComment,
  type DeliveryFeedEvent,
} from "./delivery-lib.js";
import { findOpenAgentPr, mergeAgentPr, ensureCleanClone, runDeploy } from "./delivery-exec.js";
import { acquirePidLock } from "./pidfile.js";

const DEFAULT_POLL_SECONDS = 30;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function loadDotEnv(): void {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envPath, "utf8")))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadConfig(): WorkerConfig {
  const configPath = path.join(repoRoot(), "switchyard-worker.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath} — copy switchyard-worker.example.json and edit it.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const problems = validateWorkerConfig(raw);
  if (problems.length > 0) throw new Error(`invalid ${configPath}:\n  - ${problems.join("\n  - ")}`);
  return raw as WorkerConfig;
}

const cursorPath = () => path.join(repoRoot(), ".superpowers", "deliver-cursor");

function readCursor(): number | null {
  try {
    return parseCursorText(readFileSync(cursorPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeCursor(id: number): void {
  mkdirSync(path.dirname(cursorPath()), { recursive: true });
  writeFileSync(cursorPath(), `${id}\n`);
}

function cloneRootOf(config: WorkerConfig): string {
  return config.delivery?.cloneDir ?? path.join(os.homedir(), ".switchyard", "deliver-clones");
}

async function postComment(config: WorkerConfig, token: string, ref: string, body: string): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/issues/${ref}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`POST comment on ${ref} failed: ${res.status} ${await res.text()}`);
}

async function deliver(ref: string, config: WorkerConfig, token: string, dryRun: boolean): Promise<void> {
  const project = config.projects[projectKeyOf(ref)];
  if (!project) return;

  const prNumber = await findOpenAgentPr(project.repo, ref);
  if (prNumber === null) {
    console.log(`${ref} stamped done but has no open agent PR — interactive work, skipping`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] would merge PR #${prNumber} for ${ref}, deploy from a clean clone, and comment`);
    return;
  }

  try {
    const mergeSha = await mergeAgentPr(project.repo, prNumber);
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha}`);
    let deploy: Awaited<ReturnType<typeof runDeploy>> = { ran: false };
    if (config.delivery?.deploy !== false) {
      const cloneDir = path.join(cloneRootOf(config), projectKeyOf(ref));
      await ensureCleanClone(project.repo, cloneDir);
      deploy = await runDeploy(cloneDir);
      console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
    }
    await postComment(config, token, ref, deliveryComment({ prNumber, mergeSha, deploy }));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`delivery failed for ${ref}: ${message}`);
    await postComment(config, token, ref, deliveryFailureComment(ref, message)).catch((e: Error) =>
      console.error(`could not comment the failure on ${ref}: ${e.message}`)
    );
  }
}

async function tick(config: WorkerConfig, token: string, gate: ReturnType<typeof newTickGate>, dryRun: boolean): Promise<void> {
  await runGated(gate, async () => {
    const url = `${config.url.replace(/\/$/, "")}/api/events?limit=200`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /api/events failed: ${res.status} ${await res.text()}`);
    const feed = (await res.json()) as DeliveryFeedEvent[];

    const cursor = readCursor();
    const { refs, lastEventId } = findDeliverableRefs(feed, Object.keys(config.projects), cursor);
    for (const ref of refs) {
      // Sequential on purpose: deliveries deploy; two at once would race the clone.
      await deliver(ref, config, token, dryRun);
    }
    // Written after delivery so a crash mid-batch re-runs the refs — safe,
    // because a merged PR is no longer open and gets skipped on the retry.
    if (lastEventId !== null && lastEventId !== cursor) writeCursor(lastEventId);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");

  loadDotEnv();
  const token = process.env.SWITCHYARD_TOKEN;
  if (!token) {
    console.error("SWITCHYARD_TOKEN is required (set it in the environment or the repo .env)");
    process.exit(1);
  }
  const config = loadConfig();
  const gate = newTickGate();

  if (once) {
    await tick(config, token, gate, dryRun);
    return;
  }

  const releaseLock = acquirePidLock(path.join(repoRoot(), ".superpowers", "deliver.pid"));
  await tick(config, token, gate, dryRun);

  const pollSeconds = config.delivery?.pollSeconds ?? DEFAULT_POLL_SECONDS;
  console.log(`delivery worker polling every ${pollSeconds}s (projects: ${Object.keys(config.projects).join(", ")})`);
  const timer = setInterval(() => {
    tick(config, token, gate, dryRun).catch((err) => console.error(`delivery tick failed: ${(err as Error).message}`));
  }, pollSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", releaseLock);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Document — README section**

Add to `README.md` after the "### Containerized mode (recommended)" section (before "Escalations resume fast"):

```markdown
## Delivery gate

Unattended agent work never lands on `main` (or the NAS) until a human stamps
the issue `done`. Three pieces (SYD-49):

1. **Workers open PRs.** When a containerized session exits having pushed
   `agent/<ref>` into the host repo, the worker pushes that branch to GitHub
   and opens a PR titled with the ref — host-side, so containers never hold
   GitHub credentials. Controlled by `delivery.openPrs` (default true when the
   `delivery` block exists).
2. **A delivery worker merges + deploys on the done-stamp.**

   ```bash
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts            # loop forever
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --once     # single scan
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --dry-run  # print, don't merge
   ```

   It polls `GET /api/events` (every `delivery.pollSeconds`, default 30s) for
   `status_changed → done` — a transition only humans can make, server-enforced
   — merges the open `agent/<ref>` PR, deploys via `npm run deploy` from a
   dedicated clean clone (`delivery.cloneDir`, default
   `~/.switchyard/deliver-clones` — never a working tree), and comments the
   merge SHA + deploy result on the issue. Issues without an open agent PR
   (interactive work) are skipped: interactive sessions keep direct merges.
   The event cursor persists in `.superpowers/deliver-cursor`, so approvals
   stamped while the worker was down are delivered on restart.
3. **Branch protection on `main`** blocks force-pushes and deletion. Required
   PR reviews stay off for now: all pushes authenticate as one GitHub identity
   and GitHub forbids self-approval — full can't-push-to-main enforcement is
   the SYD-19 (second identity) upgrade path.
```

- [ ] **Step 3: Update `codemaps/workers.md`**

Add after the "## Worker doctor" section:

```markdown
## Delivery worker (`scripts/deliver.ts`)

Merges + deploys agent work when a human stamps the issue done (SYD-49).
Polls `/api/events` (`delivery.pollSeconds`, 30s) for `status_changed→done`
(human-only, server-enforced) → merges open `agent/<ref>` PR via `gh` →
deploys `npm run deploy` from a clean clone (`delivery.cloneDir`, default
`~/.switchyard/deliver-clones/<KEY>`) → comments merge SHA + deploy result.
No open agent PR ⇒ skip (interactive work merges directly). Cursor persists in
`.superpowers/deliver-cursor`; lock `.superpowers/deliver.pid`. Pure logic in
`scripts/delivery-lib.ts`, exec in `scripts/delivery-exec.ts`. The dispatch
worker publishes `agent/<ref>` → PR on container exit (`delivery.openPrs`).
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: clean / all PASS

Run (no token needed for a config error check): `npx tsx scripts/deliver.ts --once` with `SWITCHYARD_TOKEN` unset
Expected: exits 1 with "SWITCHYARD_TOKEN is required"

- [ ] **Step 5: Commit**

```bash
git add scripts/deliver.ts README.md codemaps/workers.md
git commit -m "feat: delivery worker — human done-stamp merges the agent PR and deploys from a clean clone (SYD-49)"
```

---

### Task 6: Ops + live verification + issue handoff

**Files:**
- No new source files. Operational commands + SYD-49 comment.

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npx vitest run`
Expected: clean / all PASS

- [ ] **Step 2: Live dry run of the delivery worker**

Run: `npx tsx scripts/deliver.ts --once --dry-run`
(SWITCHYARD_TOKEN comes from the repo `.env`.)
Expected: exits 0. First-ever run initializes the cursor to the newest event id and prints nothing else (`.superpowers/deliver-cursor` now exists). Run it a second time — still exits 0, no deliverables (no new done-stamps since the cursor).

- [ ] **Step 3: Attempt branch protection on main**

```bash
gh api -X PUT repos/MobilityLabs/switchyard/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Expected: EITHER 200 (protection active — verify with `gh api repos/MobilityLabs/switchyard/branches/main/protection`) OR 403 "Upgrade to GitHub Team" — the repo is private under a free org plan. If 403: do not retry variants; record the outcome in the SYD-49 comment as the known limitation with SYD-19 (second identity / paid plan) as the upgrade path. This matches the design note already in the issue.

- [ ] **Step 4: Comment verification evidence on SYD-49 and move to in_review**

Using the switchyard MCP tools: `comment` on SYD-49 with — what was built (three pieces, file list), test evidence (vitest totals), the dry-run output, the branch-protection outcome from Step 3, and the branch name `feat/delivery-gate`. Then `update_issue` SYD-49 → `in_review`. (Never `done` — a human stamps that.)

- [ ] **Step 5: Final commit if anything moved**

```bash
git status --short   # expect clean; commit any stragglers with context
```

---

## Self-review notes

- **Spec coverage:** design piece 1 → Task 4; piece 2 → Tasks 1, 2, 3, 5; piece 3 → Task 6 Step 3; "unit tests on event selection/PR mapping" → Task 1; "live dry run" → Task 6 Step 2; "interactive sessions keep direct merges" → deliver.ts skips refs with no open agent PR, and publish only triggers on containerized dispatches.
- **Why the done-stamp needs no actor-type check:** the server rejects agent `done` transitions (`tests/services/issues-update.test.ts` covers it), so every `status_changed→done` event is human by construction.
- **Idempotency:** re-processing a delivered ref is safe — the merged PR is no longer open, so `findOpenAgentPr` returns null and the ref is skipped. Cursor is written only after the batch completes.
- **Type consistency check:** `DeliveryFeedEvent` (lib + deliver.ts import), `DeliveryResult.deploy` union (lib + `runDeploy` return + `deliver()` local) match; `acquirePidLock` signature matches both call sites; `WorkerConfig.delivery` optional everywhere it's read (`?.`).
