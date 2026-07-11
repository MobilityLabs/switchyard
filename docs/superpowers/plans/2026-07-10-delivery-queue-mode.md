# Delivery Queue Mode (SYD-164) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework deliver.ts's per-ref flow from merge→verify→deploy to rebase→verify→merge→deploy behind a `delivery.mode: "queue"` config flag, so semantic conflicts are rejected before main moves and stale branches never trigger LLM repair sessions.

**Architecture:** All new *decisions* are pure functions in `scripts/delivery-lib.ts` (unit-tested); all new *I/O* is a thin helper in `scripts/delivery-exec.ts` (integration-tested against a real temp git repo, matching existing style); `scripts/deliver.ts` stays a dumb imperative wiring layer (no test file, per existing idiom — its logic must all live in the lib planner). The existing `attemptAutoRebase` already implements the whole tier-1 primitive (clean clone → fetch branch → rebase onto origin/main → verify rebased tree → force-push-with-lease); queue mode promotes it from fallback to primary path and adds an optimistic-concurrency guard (re-check origin/main before merging; re-rebase if it moved, max 3 attempts).

**Tech Stack:** TypeScript (tsx), vitest, gh CLI via argv builders, real-git-repo test fixtures (see `tests/scripts/delivery-exec.test.ts` for the pattern).

**Background:** `docs/2026-07-10-merge-queue-research.md` (cited research), SYD-164 (issue). Every production merge system (bors-ng, Zuul, GitLab trains, SubmitQueue, Chromium CQ) verifies the exact post-merge state before advancing main, and bounces failures to the author instead of repairing in-queue.

## Global Constraints

- Business logic in services applies to `src/`; this work is worker-script-side (`scripts/`), where the analogous rule is: decisions in `delivery-lib.ts` (pure), I/O in `delivery-exec.ts`, wiring in `deliver.ts`.
- gh/git are ALWAYS invoked via argv arrays built by pure `build*Args` functions in delivery-lib.ts — never string interpolation into a shell.
- Tokens never in argv.
- Before EVERY commit: `npm run typecheck && npm run build:ui && npx vitest run` must pass, run in-transcript (no unrun evidence).
- Stage specific files only (`git add <paths>`), never `git add -A`.
- Queue mode v1 does NOT dispatch conflict-resolution sessions (bounce-don't-repair). `delivery.conflictResolution` and `delivery.autoRebase` are ignored in queue mode; document this in the `DeliveryConfig` type comments.
- Default behavior unchanged: `delivery.mode` absent or `"merge-first"` ⇒ exactly today's flow.
- Branch: `feat/delivery-queue-mode` (interactive session work, from current main). Commits reference SYD-164.

---

### Task 1: Queue decision planner (pure)

**Files:**
- Modify: `scripts/delivery-lib.ts` (append near `RebaseOutcome`, ~line 278)
- Test: `tests/scripts/delivery-lib.test.ts` (append)

**Interfaces:**
- Consumes: `RebaseOutcome` (existing type; Task 3 adds `mainSha` to its `rebased` variant — this task only needs `status`).
- Produces: `QUEUE_MAX_REBASE_ATTEMPTS = 3`, `type QueueDecision`, `decideQueueAction(outcome, mainMoved, attempt, maxAttempts?)` — Task 5 consumes all three.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/delivery-lib.test.ts` (add `decideQueueAction`, `QUEUE_MAX_REBASE_ATTEMPTS`, and `type QueueDecision` to the existing import block from `../../scripts/delivery-lib.js`):

```typescript
describe("decideQueueAction (SYD-164 queue mode planner)", () => {
  const rebased = { status: "rebased", sha: "abc123", mainSha: "main111" } as const;

  it("merges when the rebase verified clean and main has not moved", () => {
    expect(decideQueueAction(rebased, false, 1)).toEqual({ kind: "merge" });
  });

  it("retries the rebase when main moved and attempts remain", () => {
    expect(decideQueueAction(rebased, true, 1)).toEqual({ kind: "retry-rebase", attempt: 2 });
    expect(decideQueueAction(rebased, true, 2)).toEqual({ kind: "retry-rebase", attempt: 3 });
  });

  it("bounces as main-hot when main moved on the final attempt", () => {
    expect(decideQueueAction(rebased, true, QUEUE_MAX_REBASE_ATTEMPTS)).toEqual({
      kind: "bounce", reason: "main-hot", attempts: QUEUE_MAX_REBASE_ATTEMPTS,
    });
  });

  it("bounces conflicts with the conflicted files — never a resolver dispatch", () => {
    expect(decideQueueAction({ status: "conflict", files: ["src/a.ts"] }, false, 1)).toEqual({
      kind: "bounce", reason: "conflict", files: ["src/a.ts"],
    });
  });

  it("bounces a failed verify with the tail (semantic-conflict rejection)", () => {
    expect(decideQueueAction({ status: "verify-failed", tail: "FAIL foo" }, false, 1)).toEqual({
      kind: "bounce", reason: "verify-failed", tail: "FAIL foo",
    });
  });

  it("bounces a missing agent branch", () => {
    expect(decideQueueAction({ status: "no-branch" }, false, 1)).toEqual({
      kind: "bounce", reason: "no-branch",
    });
  });

  it("mainMoved is irrelevant for non-rebased outcomes", () => {
    expect(decideQueueAction({ status: "no-branch" }, true, 3).kind).toBe("bounce");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts -t "decideQueueAction"`
Expected: FAIL — `decideQueueAction` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `scripts/delivery-lib.ts`, directly below the `RebaseOutcome` type:

```typescript
/** Queue mode (SYD-164): how many rebase→verify cycles to attempt when main
 * keeps moving between our verify and our merge (e.g. a human merging by
 * hand). Beyond this we bounce rather than chase a hot main forever. */
export const QUEUE_MAX_REBASE_ATTEMPTS = 3;

/** Queue mode (SYD-164): the planner's verdict after one rebase attempt.
 * Pure so every branch of the delivery loop is unit-testable; deliver.ts
 * only executes these, it never decides. Bouncing (comment + delivery_failed,
 * PR left open for the author to regenerate) is the ONLY failure handling —
 * queue mode never dispatches conflict-resolution sessions (research:
 * docs/2026-07-10-merge-queue-research.md, "eject and bounce, never repair"). */
export type QueueDecision =
  | { kind: "merge" }
  | { kind: "retry-rebase"; attempt: number }
  | { kind: "bounce"; reason: "conflict"; files: string[] }
  | { kind: "bounce"; reason: "verify-failed"; tail: string }
  | { kind: "bounce"; reason: "no-branch" }
  | { kind: "bounce"; reason: "main-hot"; attempts: number };

export function decideQueueAction(
  outcome: RebaseOutcome,
  mainMoved: boolean,
  attempt: number,
  maxAttempts: number = QUEUE_MAX_REBASE_ATTEMPTS
): QueueDecision {
  if (outcome.status === "no-branch") return { kind: "bounce", reason: "no-branch" };
  if (outcome.status === "conflict") return { kind: "bounce", reason: "conflict", files: outcome.files };
  if (outcome.status === "verify-failed") return { kind: "bounce", reason: "verify-failed", tail: outcome.tail };
  if (!mainMoved) return { kind: "merge" };
  if (attempt >= maxAttempts) return { kind: "bounce", reason: "main-hot", attempts: attempt };
  return { kind: "retry-rebase", attempt: attempt + 1 };
}
```

Note: the test's `rebased` fixture includes `mainSha`, which `RebaseOutcome` doesn't have until Task 3. Use `as const` + a cast if tsc complains, OR do Task 3's one-line type change first — the plan orders them 1→3 so that the cast is needed only transiently; either is acceptable, but the final state after Task 3 must have no cast.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add scripts/delivery-lib.ts tests/scripts/delivery-lib.test.ts
git commit -m "feat: pure queue-mode delivery planner (SYD-164)"
```

---

### Task 2: Bounce comments, delivered note, and git argv builders (pure)

**Files:**
- Modify: `scripts/delivery-lib.ts` (append near the other comment formatters, ~line 310+)
- Test: `tests/scripts/delivery-lib.test.ts` (append)

**Interfaces:**
- Consumes: `QueueDecision` (Task 1), `agentBranch(ref)`, `MAIN_BRANCH`, `tailOf` (existing).
- Produces: `queueBounceComment(ref: string, decision: Extract<QueueDecision, {kind:"bounce"}>): string`, `queueBounceEventMessage(decision): string`, `queueDeliveredNote(ref: string, attempts: number): string`, `buildFetchMainArgs(): string[]`, `buildOriginMainShaArgs(): string[]`. Tasks 3 and 5 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/delivery-lib.test.ts` (extend the import block):

```typescript
describe("queue-mode comments and argv builders (SYD-164)", () => {
  it("buildFetchMainArgs / buildOriginMainShaArgs", () => {
    expect(buildFetchMainArgs()).toEqual(["fetch", "origin", "main"]);
    expect(buildOriginMainShaArgs()).toEqual(["rev-parse", "origin/main"]);
  });

  it("conflict bounce names the files and prescribes regeneration, not repair", () => {
    const body = queueBounceComment("SYD-9", { kind: "bounce", reason: "conflict", files: ["src/a.ts", "ui/b.tsx"] });
    expect(body).toContain("agent/SYD-9");
    expect(body).toContain("src/a.ts");
    expect(body).toContain("ui/b.tsx");
    expect(body.toLowerCase()).toContain("re-dispatch");
    expect(body).not.toContain("undefined");
  });

  it("verify-failed bounce carries the tail and says main was not touched", () => {
    const body = queueBounceComment("SYD-9", { kind: "bounce", reason: "verify-failed", tail: "FAIL src/x.test.ts" });
    expect(body).toContain("FAIL src/x.test.ts");
    expect(body.toLowerCase()).toContain("main was not");
  });

  it("main-hot bounce reports the attempt count", () => {
    const body = queueBounceComment("SYD-9", { kind: "bounce", reason: "main-hot", attempts: 3 });
    expect(body).toContain("3");
  });

  it("no-branch bounce mentions the missing branch", () => {
    expect(queueBounceComment("SYD-9", { kind: "bounce", reason: "no-branch" })).toContain("agent/SYD-9");
  });

  it("event messages are one-line and reason-tagged", () => {
    expect(queueBounceEventMessage({ kind: "bounce", reason: "conflict", files: ["a"] })).toContain("conflict");
    expect(queueBounceEventMessage({ kind: "bounce", reason: "verify-failed", tail: "t" })).toContain("verify");
    expect(queueBounceEventMessage({ kind: "bounce", reason: "main-hot", attempts: 3 })).toContain("main");
    expect(queueBounceEventMessage({ kind: "bounce", reason: "no-branch" })).toContain("branch");
  });

  it("queueDeliveredNote reads naturally for 1 and N attempts", () => {
    expect(queueDeliveredNote("SYD-9", 1)).toContain("rebased onto main and verified");
    expect(queueDeliveredNote("SYD-9", 3)).toContain("3");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts -t "SYD-164"`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Write the implementation**

Append to `scripts/delivery-lib.ts` beside the other argv builders / comment formatters:

```typescript
export function buildFetchMainArgs(): string[] {
  return ["fetch", "origin", MAIN_BRANCH];
}

export function buildOriginMainShaArgs(): string[] {
  return ["rev-parse", `origin/${MAIN_BRANCH}`];
}

/** Queue mode (SYD-164): the human-facing bounce comment. One formatter per
 * reason keeps the copy testable; the shared framing states what the queue
 * did, that main was never touched, and what to do next. */
export function queueBounceComment(ref: string, d: Extract<QueueDecision, { kind: "bounce" }>): string {
  const branch = agentBranch(ref);
  const header = `⛔ Delivery bounced — main was not touched.`;
  const retry = `To retry: fix ${branch} (or re-dispatch this issue so a fresh session regenerates the change against current ${MAIN_BRANCH}), then stamp done again or hit Retry delivery.`;
  switch (d.reason) {
    case "conflict":
      return [
        header,
        `Rebasing ${branch} onto ${MAIN_BRANCH} hit real conflicts in:`,
        ...d.files.map((f) => `- \`${f}\``),
        `Queue mode does not auto-resolve conflicts — re-dispatch beats repairing a stale branch (see docs/2026-07-10-merge-queue-research.md).`,
        retry,
      ].join("\n");
    case "verify-failed":
      return [
        header,
        `${branch} rebased onto ${MAIN_BRANCH} cleanly, but typecheck/tests FAILED on the combined result — this change conflicts semantically with something that landed after its branch was cut.`,
        "```",
        tailOf(d.tail),
        "```",
        retry,
      ].join("\n");
    case "main-hot":
      return [
        header,
        `${MAIN_BRANCH} moved during ${d.attempts} consecutive rebase→verify cycles, so the verified result kept going stale before it could merge. Retry when the branch settles.`,
      ].join("\n");
    case "no-branch":
      return `${header}\nNo ${branch} branch exists on the remote — nothing to deliver.`;
  }
}

/** One-line machine-facing message for the delivery_failed event strip. */
export function queueBounceEventMessage(d: Extract<QueueDecision, { kind: "bounce" }>): string {
  switch (d.reason) {
    case "conflict":
      return `queue bounce: rebase conflicts in ${d.files.join(", ") || "(unknown files)"}`;
    case "verify-failed":
      return "queue bounce: verify failed on the rebased result (semantic conflict)";
    case "main-hot":
      return `queue bounce: main moved during ${d.attempts} rebase attempts`;
    case "no-branch":
      return "queue bounce: agent branch missing on remote";
  }
}

/** Prefix for the delivery comment when queue mode landed the PR. */
export function queueDeliveredNote(ref: string, attempts: number): string {
  const cycles = attempts > 1 ? ` (took ${attempts} rebase cycles — ${MAIN_BRANCH} was moving)` : "";
  return `🔁 ${agentBranch(ref)} was rebased onto main and verified pre-merge by queue mode${cycles}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/delivery-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add scripts/delivery-lib.ts tests/scripts/delivery-lib.test.ts
git commit -m "feat: queue-mode bounce comments and argv builders (SYD-164)"
```

---

### Task 3: `mainSha` on RebaseOutcome + `currentOriginMainSha` exec helper

**Files:**
- Modify: `scripts/delivery-lib.ts:278-282` (the `RebaseOutcome` type)
- Modify: `scripts/delivery-exec.ts` (`attemptAutoRebase`, ~line 238; new helper below it)
- Test: `tests/scripts/delivery-exec.test.ts` (append)

**Interfaces:**
- Consumes: `runGit` (existing, hook-proof git exec returning trimmed stdout), `buildFetchMainArgs`/`buildOriginMainShaArgs` (Task 2), `MAIN_BRANCH`.
- Produces: `RebaseOutcome`'s rebased variant becomes `{ status: "rebased"; sha: string; mainSha: string }`; `currentOriginMainSha(cloneDir: string): Promise<string>` exported from delivery-exec.ts. Task 5 consumes both.

- [ ] **Step 1: Write the failing test**

Append to `tests/scripts/delivery-exec.test.ts` (real-git style, no npm/network; extend the import from `../../scripts/delivery-exec.js` with `currentOriginMainSha`):

```typescript
describe("currentOriginMainSha (SYD-164)", () => {
  it("re-fetches and reports origin/main's tip, seeing commits added after clone", async () => {
    const upstream = mkdtempSync(path.join(tmpdir(), "queue-upstream-"));
    await execFileP("git", ["init", "-q", "-b", "main", upstream]);
    await execFileP("git", ["-C", upstream, "config", "user.email", "t@e.c"]);
    await execFileP("git", ["-C", upstream, "config", "user.name", "t"]);
    writeFileSync(path.join(upstream, "a.txt"), "1");
    await execFileP("git", ["-C", upstream, "add", "a.txt"]);
    await execFileP("git", ["-C", upstream, "commit", "-q", "-m", "one"]);

    const clone = mkdtempSync(path.join(tmpdir(), "queue-clone-"));
    await execFileP("git", ["clone", "-q", upstream, clone]);
    const shaBefore = await currentOriginMainSha(clone);

    writeFileSync(path.join(upstream, "b.txt"), "2");
    await execFileP("git", ["-C", upstream, "add", "b.txt"]);
    await execFileP("git", ["-C", upstream, "commit", "-q", "-m", "two"]);
    const upstreamTip = (await execFileP("git", ["-C", upstream, "rev-parse", "main"])).stdout.trim();

    const shaAfter = await currentOriginMainSha(clone);
    expect(shaAfter).toBe(upstreamTip);
    expect(shaAfter).not.toBe(shaBefore);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/delivery-exec.test.ts -t "currentOriginMainSha"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `scripts/delivery-lib.ts`, change the `RebaseOutcome` rebased variant:

```typescript
export type RebaseOutcome =
  | { status: "no-branch" }
  | { status: "conflict"; files: string[] }
  | { status: "verify-failed"; tail: string }
  | { status: "rebased"; sha: string; mainSha: string };
```

In `scripts/delivery-exec.ts`, change the last lines of `attemptAutoRebase` to also capture the main tip it rebased onto (ensureCleanClone just fetched, so `origin/main` in the clone IS the rebase target — no extra fetch here):

```typescript
  await runGit(["-C", cloneDir, ...buildForcePushWithLeaseArgs(ref)]);
  const sha = await runGit(["-C", cloneDir, "rev-parse", "HEAD"]);
  const mainSha = await runGit(["-C", cloneDir, ...buildOriginMainShaArgs()]);
  return { status: "rebased", sha, mainSha };
```

Add below `attemptAutoRebase` (import `buildFetchMainArgs`/`buildOriginMainShaArgs` from `./delivery-lib.js`):

```typescript
/** Queue mode (SYD-164): the freshest origin/main tip, re-fetched now. Used
 * as the optimistic-concurrency check between "verified the rebased tree"
 * and "merge the PR" — if this differs from the mainSha the rebase used,
 * the verified result is stale and the planner retries the rebase. */
export async function currentOriginMainSha(cloneDir: string): Promise<string> {
  await runGit(["-C", cloneDir, ...buildFetchMainArgs()]);
  return runGit(["-C", cloneDir, ...buildOriginMainShaArgs()]);
}
```

Remove any transient cast left in Task 1's test fixture.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/delivery-exec.test.ts tests/scripts/delivery-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add scripts/delivery-lib.ts scripts/delivery-exec.ts tests/scripts/delivery-exec.test.ts tests/scripts/delivery-lib.test.ts
git commit -m "feat: capture rebase-target main sha + currentOriginMainSha helper (SYD-164)"
```

---

### Task 4: `delivery.mode` config + validation + example

**Files:**
- Modify: `scripts/worker-select.ts:80-113` (the `DeliveryConfig` type)
- Modify: `scripts/init-worker-lib.ts` (`validateWorkerConfig`, ~line 39-70)
- Modify: `switchyard-worker.example.json`
- Test: `tests/init-worker-lib.test.ts` (append — note: this test file lives at `tests/`, NOT `tests/scripts/`)

**Interfaces:**
- Produces: `DeliveryConfig.mode?: "merge-first" | "queue"`; `isQueueMode(config: WorkerConfig): boolean` exported from `scripts/delivery-lib.ts`. Task 5 consumes `isQueueMode`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/init-worker-lib.test.ts` (match its existing fixture style — read the top of the file for the minimal-valid-config helper it uses and reuse it):

```typescript
describe("validateWorkerConfig delivery.mode (SYD-164)", () => {
  it("accepts absent, merge-first, and queue", () => {
    for (const mode of [undefined, "merge-first", "queue"]) {
      const cfg = { ...validConfig(), delivery: mode === undefined ? {} : { mode } };
      expect(validateWorkerConfig(cfg)).toEqual([]);
    }
  });

  it("rejects an unknown mode with a pointed message", () => {
    const problems = validateWorkerConfig({ ...validConfig(), delivery: { mode: "yolo" } });
    expect(problems.some((p) => p.includes("delivery.mode"))).toBe(true);
  });
});
```

And to `tests/scripts/delivery-lib.test.ts`:

```typescript
describe("isQueueMode (SYD-164)", () => {
  const base = { url: "http://x", label: "l", intervalSeconds: 60, maxConcurrent: 1, projects: {} };
  it("false when delivery or mode is absent or merge-first", () => {
    expect(isQueueMode(base as never)).toBe(false);
    expect(isQueueMode({ ...base, delivery: {} } as never)).toBe(false);
    expect(isQueueMode({ ...base, delivery: { mode: "merge-first" } } as never)).toBe(false);
  });
  it("true only for mode queue", () => {
    expect(isQueueMode({ ...base, delivery: { mode: "queue" } } as never)).toBe(true);
  });
});
```

(If `validConfig()` doesn't exist in tests/init-worker-lib.test.ts, use whatever minimal-config helper that file already uses; only if there is none, inline the smallest object that passes validation today.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/init-worker-lib.test.ts tests/scripts/delivery-lib.test.ts -t "SYD-164"`
Expected: FAIL — `mode` rejected as unknown / `isQueueMode` missing. (If validateWorkerConfig silently ignores unknown delivery keys, the "rejects an unknown mode" test is the one that must fail.)

- [ ] **Step 3: Implement**

In `scripts/worker-select.ts`, add to `DeliveryConfig`:

```typescript
  /**
   * Delivery strategy (SYD-164). "merge-first" (default): today's flow —
   * merge, then verify merged main, deploy; conflicts fall back to
   * autoRebase and optional conflictResolution sessions. "queue": rebase
   * agent/<ref> onto current main, verify the REBASED tree, and only merge
   * on green (bors/Zuul-style pre-merge gating; see
   * docs/2026-07-10-merge-queue-research.md). In queue mode `autoRebase`
   * and `conflictResolution` are ignored — the rebase IS the pipeline, and
   * failures bounce to the author instead of dispatching repair sessions.
   */
  mode?: "merge-first" | "queue";
```

In `scripts/init-worker-lib.ts` inside `validateWorkerConfig`, beside the other checks (adapt to the local style of accessing the untyped candidate):

```typescript
  const mode = (c as { delivery?: { mode?: unknown } }).delivery?.mode;
  if (mode !== undefined && mode !== "merge-first" && mode !== "queue") {
    problems.push('`delivery.mode` must be "merge-first" or "queue" when set');
  }
```

In `scripts/delivery-lib.ts`:

```typescript
/** Queue mode flag (SYD-164). */
export function isQueueMode(config: WorkerConfig): boolean {
  return config.delivery?.mode === "queue";
}
```

In `switchyard-worker.example.json`, inside the `"delivery"` block add:

```json
    "mode": "merge-first",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/init-worker-lib.test.ts tests/scripts/delivery-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add scripts/worker-select.ts scripts/init-worker-lib.ts scripts/delivery-lib.ts switchyard-worker.example.json tests/init-worker-lib.test.ts tests/scripts/delivery-lib.test.ts
git commit -m "feat: delivery.mode config flag with validation (SYD-164)"
```

---

### Task 5: Wire `deliverViaQueue` into deliver.ts

**Files:**
- Modify: `scripts/deliver.ts` (the `deliver()` function, ~lines 140-260)

**Interfaces:**
- Consumes: `decideQueueAction`, `queueBounceComment`, `queueBounceEventMessage`, `queueDeliveredNote`, `isQueueMode` (lib); `attemptAutoRebase`, `currentOriginMainSha`, `pollUntilMergeable`, `mergeAgentPr`, `ensureCleanClone`, `runVerification`, `runDeploy` (exec); `postComment`, `postDeliveryEvent`, `deliveryComment`, `verificationFailureComment` (existing in deliver.ts/lib).
- Produces: nothing new for later tasks — this is the integration point. deliver.ts has no test file (existing idiom: it must contain NO decisions, only wiring; all branching added here must be a direct planner-decision dispatch).

- [ ] **Step 1: Extract the shared post-merge block**

Inside `scripts/deliver.ts`, extract lines ~235-260 of `deliver()` (post-merge verify backstop, deploy, comment, delivered event) into a function directly above `deliver()`. It is used verbatim by both modes; in queue mode the verify backstop stays on by default (defense in depth — it catches the residual check-then-merge race and any manual merge landing between our check and gh's merge):

```typescript
/** Post-merge steps shared by both delivery modes: verify-backstop (unless
 * delivery.verify === false), deploy, then the delivery comment + event.
 * `note` prefixes the comment (rebase/resolution/queue provenance). */
async function finishDelivery(
  ref: string, prNumber: number, mergeSha: string, note: string | null,
  project: WorkerProject, cloneDir: string, config: WorkerConfig, token: string
): Promise<void> {
  let deploy: Awaited<ReturnType<typeof runDeploy>> = { ran: false };
  if (config.delivery?.deploy !== false) {
    await ensureCleanClone(project.repo, cloneDir);
    if (config.delivery?.verify !== false) {
      const verify = await runVerification(cloneDir);
      if (!verify.ok) {
        console.error(`${ref}: post-merge verification FAILED — main is red, deploy skipped`);
        await postComment(config, token, ref, verificationFailureComment(prNumber, mergeSha, verify.tail));
        await postDeliveryEvent(config, token, ref, {
          type: "delivery_failed",
          message: `post-merge verification failed after merging PR #${prNumber} at ${mergeSha} — deploy skipped:\n${verify.tail}`,
        }).catch((e: Error) => console.error(`could not record delivery_failed event for ${ref}: ${e.message}`));
        return;
      }
    }
    deploy = await runDeploy(cloneDir);
    console.log(`${ref}: deploy ${deploy.ran ? (deploy.ok ? "succeeded" : "FAILED") : "skipped"}`);
  }
  const commentBody = deliveryComment({ prNumber, mergeSha, deploy });
  await postComment(config, token, ref, note ? `${note}\n\n${commentBody}` : commentBody);
  await postDeliveryEvent(config, token, ref, { type: "delivered", prNumber, mergeSha, deploy }).catch((e: Error) =>
    console.error(`could not record delivered event for ${ref}: ${e.message}`)
  );
}
```

Replace the tail of the existing merge-first path with a call to `finishDelivery(ref, prNumber, mergeSha, note, project, cloneDir, config, token)` where `note` is the existing `resolvedConflict ? conflictResolvedNote(ref) : rebased ? autoRebasedNote(ref) : null`.

- [ ] **Step 2: Add the queue-mode flow**

Directly above `deliver()`:

```typescript
/** Queue-mode delivery (SYD-164): rebase → verify → merge → deploy. Every
 * decision comes from decideQueueAction (pure, tested); this loop only
 * executes. Bounces leave main untouched and the PR open. */
async function deliverViaQueue(
  ref: string, prNumber: number, project: WorkerProject, cloneDir: string,
  config: WorkerConfig, token: string
): Promise<void> {
  let attempt = 1;
  for (;;) {
    const outcome = await attemptAutoRebase(project.repo, cloneDir, ref);
    let mainMoved = false;
    if (outcome.status === "rebased") {
      const mergeable = await pollUntilMergeable(project.repo, prNumber);
      console.log(`${ref}: queue attempt ${attempt} rebased at ${outcome.sha}, mergeability=${mergeable}`);
      mainMoved = (await currentOriginMainSha(cloneDir)) !== outcome.mainSha;
    }
    const decision = decideQueueAction(outcome, mainMoved, attempt);
    if (decision.kind === "retry-rebase") {
      console.log(`${ref}: main moved during verify — retrying rebase (attempt ${decision.attempt})`);
      attempt = decision.attempt;
      continue;
    }
    if (decision.kind === "bounce") {
      console.log(`${ref}: queue bounce (${decision.reason})`);
      await postComment(config, token, ref, queueBounceComment(ref, decision));
      await postDeliveryEvent(config, token, ref, {
        type: "delivery_failed", message: queueBounceEventMessage(decision),
      }).catch((e: Error) => console.error(`could not record delivery_failed event on ${ref}: ${e.message}`));
      return;
    }
    const mergeSha = await mergeAgentPr(project.repo, prNumber);
    console.log(`${ref}: merged PR #${prNumber} at ${mergeSha} (queue mode)`);
    await finishDelivery(ref, prNumber, mergeSha, queueDeliveredNote(ref, attempt), project, cloneDir, config, token);
    return;
  }
}
```

In `deliver()`, right after the `cloneDir` is computed (line ~158) and before the existing merge-first `try`:

```typescript
    if (isQueueMode(config)) {
      await deliverViaQueue(ref, prNumber, project, cloneDir, config, token);
      return;
    }
```

(The surrounding outer `try/catch` in `deliver()` still guards the queue path: an unexpected throw — gh/network/git — still produces the generic `deliveryFailureComment` + `delivery_failed` event, same as today.)

Update imports at the top of deliver.ts: add `decideQueueAction`, `queueBounceComment`, `queueBounceEventMessage`, `queueDeliveredNote`, `isQueueMode` to the delivery-lib import; add `currentOriginMainSha` to the delivery-exec import.

- [ ] **Step 3: Dry-run smoke test**

Run: `SWITCHYARD_TOKEN=dummy npx tsx scripts/deliver.ts --dry-run --once 2>&1 | tail -5`
Expected: starts, scans (or fails on unreachable server with a clean error — NOT a typecheck/import crash). The point is import wiring, not behavior.

- [ ] **Step 4: Gates, then commit**

```bash
npm run typecheck && npm run build:ui && npx vitest run
git add scripts/deliver.ts
git commit -m "feat: queue-mode delivery flow — rebase, verify, then merge (SYD-164)"
```

---

### Task 6: PR, review, rollout

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/delivery-queue-mode
gh pr create --title "SYD-164: delivery queue mode — rebase → verify → merge" --body "Implements SYD-164 behind delivery.mode: \"queue\" (default unchanged). Research: docs/2026-07-10-merge-queue-research.md. Planner decisions are pure and fully unit-tested; exec helper integration-tested against a real git repo; deliver.ts remains decision-free wiring."
```

- [ ] **Step 2: Request code review** (superpowers:requesting-code-review / /code-review) and address findings.

- [ ] **Step 3: Rollout (with Sean, after merge)**
  1. Set `"mode": "queue"` in the `delivery` block of `switchyard-worker.json`.
  2. Restart the deliver job: `launchctl kickstart -k gui/501/com.switchyard.deliver`.
  3. Watch the first stamped issue: `tail -f .superpowers/worker-logs/deliver.out.log` — expect `queue attempt 1 rebased at …` then `merged … (queue mode)`, or a bounce comment on the issue.
  4. Leave SYD-163 open until a week of queue-mode deliveries confirms no resolver cascades remain to circuit-break.

## Self-review notes

- Spec coverage: issue items 1-4 → Tasks 1/2/3/5; item 5 (file-disjointness fast-path) deliberately deferred — YAGNI until rebase cost is observed (it's an npm-ci-free git op; cheap already). Recorded in SYD-164 comment at PR time.
- The `attempt` passed to `queueDeliveredNote` on merge is the count of rebase cycles performed (1-3), consistent with `decideQueueAction`'s attempt semantics (attempt N = Nth cycle).
- Type consistency: `QueueDecision` retry carries the NEXT attempt number; the loop assigns it directly. `RebaseOutcome.mainSha` exists only on `rebased` (Tasks 1's fixture updated in Task 3).
- deliver.ts gains zero conditional logic beyond dispatching planner decisions — the idiom that keeps it test-file-free holds.
