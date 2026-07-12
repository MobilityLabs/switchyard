# Process-Deviation Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a server-side "process-deviation" attention signal (PR-open-not-in-review, merged-PR-not-done, stale-claim) from the event log, surface it through the existing `attention` channel + UI chip, and push it once-per-episode via the existing webhook fan-out.

**Architecture:** A new pure-derivation service (`deviation.ts`) computes drift from `events` + issue status + PR status — no stored column. `attention.ts` becomes a thin aggregator that widens its flag union and composes the deviation source, so every existing consumer (REST list/detail, MCP, search filter, UI) picks it up for free. A per-tick emitter records a deduped `process_deviation` event so registered webhooks fan it out.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes in `src/`), Drizzle ORM over better-sqlite3, Vitest, React + Vite UI (bundler resolution, no import suffixes in `ui/`).

## Global Constraints

- **Derive, don't store.** No new stored/drift-prone column. Deviation *state* is always computed from `events` + issue status + PR status. The only rows written are `process_deviation` audit/notification events (idempotent per episode).
- **No autonomous board mutation.** `deviation.ts` and the emitter MUST NOT write to the `issues` table (never change `status`/`assignee`). They only read and (for the emitter) record events.
- **All business logic in `src/services/*`;** REST/MCP/UI are thin adapters.
- **`src/` imports use explicit `.js` suffixes** (NodeNext). **`ui/` imports use no suffix.**
- **`claims.deviation_seconds` default = 3600** (1h) — flags a claim as going stale *before* the 4h `claims.stale_seconds` auto-release.
- **Deviation priority** (when several apply to one issue): `merged_pr_not_done` > `open_pr_not_in_review` > `stale_claim`. **`delivery_failed` outranks all deviations** in the aggregated `attention` flag.

---

### Task 1: `getMergedPrEvent` helper in pr-status.ts

Keeps all PR-lifecycle derivation in one module. Returns the latest merge event's PR number + event id (the event id is the episode-start marker the emitter needs for `merged_pr_not_done`).

**Files:**
- Modify: `src/services/pr-status.ts`
- Test: `tests/services/pr-status.test.ts`

**Interfaces:**
- Produces: `getMergedPrEvent(db: Db, issueId: number): { prNumber: number; eventId: number } | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/services/pr-status.test.ts` (the file already imports `openDb`, `createActor`, `createProject`, `createIssue`, `getIssue`, `recordDeliveryEvent`, `recordEvent` and defines `setup()`):

```ts
import { getOpenPr, listOpenPrByIssueId, getMergedPrEvent } from "../../src/services/pr-status.js";

describe("getMergedPrEvent", () => {
  it("returns null when the issue has no merge event", () => {
    const { db } = setup();
    expect(getMergedPrEvent(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("returns the prNumber + event id of a delivered event", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    const merged = getMergedPrEvent(db, issue.id);
    expect(merged?.prNumber).toBe(41);
    expect(merged?.eventId).toBeGreaterThan(0);
  });

  it("returns the prNumber of a gh_pr_merged event (webhook path)", () => {
    const { db, agent } = setup();
    const issue = getIssue(db, "SYD-1");
    recordEvent(db, {
      issueId: issue.id,
      actorId: agent.id,
      type: "gh_pr_merged",
      payload: { prNumber: 41, url: "https://github.com/acme/widgets/pull/41", mergeSha: "abc" },
    });
    expect(getMergedPrEvent(db, issue.id)?.prNumber).toBe(41);
  });

  it("returns the most recent merge event when several exist", () => {
    const { db, human } = setup();
    const issue = getIssue(db, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivered", prNumber: 41, mergeSha: "a", deploy: { ran: false } });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivered", prNumber: 42, mergeSha: "b", deploy: { ran: false } });
    expect(getMergedPrEvent(db, issue.id)?.prNumber).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/pr-status.test.ts -t "getMergedPrEvent"`
Expected: FAIL — `getMergedPrEvent is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/pr-status.ts` (the file already imports `sql` from `drizzle-orm` and `Db`):

```ts
export type MergedPrEvent = { prNumber: number; eventId: number };

// The latest merge event for an issue (a `delivered` self-publish or a
// `gh_pr_merged` webhook), with its event id — used by the process-deviation
// signal both to name the PR and as the "episode start" marker for webhook
// dedup. Note `delivered` payloads carry no url, so only prNumber is returned.
export function getMergedPrEvent(db: Db, issueId: number): MergedPrEvent | null {
  const row = db.all<{ prNumber: number; eventId: number }>(sql`
    SELECT json_extract(payload, '$.prNumber') AS prNumber, id AS eventId
    FROM events
    WHERE issue_id = ${issueId} AND type IN ('gh_pr_merged', 'delivered')
    ORDER BY id DESC
    LIMIT 1
  `)[0];
  return row ? { prNumber: row.prNumber, eventId: row.eventId } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/pr-status.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/pr-status.ts tests/services/pr-status.test.ts
git commit -m "feat: getMergedPrEvent PR-lifecycle helper (SYD-188)"
```

---

### Task 2: `deviation.ts` derivation service + `claims.deviation_seconds` setting

The core. Pure derivation of the three deviation cases, plus the new setting `stale_claim` depends on.

**Files:**
- Create: `src/services/deviation.ts`
- Modify: `src/services/settings.ts:40` (add registry entry)
- Test: `tests/services/deviation.test.ts` (create)

**Interfaces:**
- Consumes: `getOpenPr`, `listOpenPrByIssueId`, `getMergedPrEvent` (Task 1) from `./pr-status.js`; `getSetting` from `./settings.js`.
- Produces:
  - `type DeviationReason = "open_pr_not_in_review" | "merged_pr_not_done" | "stale_claim"`
  - `type DeviationFlag = { reason: DeviationReason; message: string }`
  - `getDeviation(db: Db, issueId: number): DeviationFlag | null`
  - `listDeviationByIssueId(db: Db): Map<number, DeviationFlag>`
  - `type DeviationComputation = { reason: DeviationReason; message: string; episodeStartId: number; prNumber: number | null }` and `computeDeviation(...)` (used by Task 4's emitter)

- [ ] **Step 1: Add the setting (prerequisite)**

In `src/services/settings.ts`, inside the `REGISTRY` object, add directly after the `"claims.stale_seconds"` line (currently `settings.ts:33`):

```ts
  "claims.deviation_seconds": { type: "number", default: 3600 },
```

- [ ] **Step 2: Write the failing test**

Create `tests/services/deviation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { events } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { recordEvent } from "../../src/services/events.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { getDeviation, listDeviationByIssueId } from "../../src/services/deviation.js";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  return { db, human, agent };
}

function ageAllEvents(db: Db, issueId: number, secondsAgo: number) {
  const old = Math.floor(Date.now() / 1000) - secondsAgo;
  db.update(events).set({ createdAt: old }).where(eq(events.issueId, issueId)).run();
}

describe("getDeviation — open_pr_not_in_review", () => {
  it("flags an in_progress issue with an open PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // -> in_progress
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("open_pr_not_in_review");
    expect(flag?.message).toContain("#41");
  });

  it("flags a todo issue with an open PR", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
    });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });

  it("does NOT flag an in_review issue with an open PR (correct state)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("getDeviation — merged_pr_not_done", () => {
  it("flags an in_review issue whose PR is merged", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    const flag = getDeviation(db, getIssue(db, "SYD-1").id);
    expect(flag?.reason).toBe("merged_pr_not_done");
    expect(flag?.message).toContain("#41");
  });

  it("does NOT flag a done issue with a merged PR", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    updateIssue(db, human, "SYD-1", { status: "in_review" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    updateIssue(db, human, "SYD-1", { status: "done" });
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("getDeviation — stale_claim", () => {
  it("flags an in_progress issue idle past claims.deviation_seconds", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600); // 2h > 1h default
    expect(getDeviation(db, getIssue(db, "SYD-1").id)?.reason).toBe("stale_claim");
  });

  it("does NOT flag a fresh in_progress claim", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag an idle claim that is waiting on human input", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", { question: "which db?" });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 2 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });

  it("does NOT flag a stale issue that is not in_progress", () => {
    const { db, human } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    ageAllEvents(db, getIssue(db, "SYD-1").id, 5 * 3600);
    expect(getDeviation(db, getIssue(db, "SYD-1").id)).toBeNull();
  });
});

describe("listDeviationByIssueId", () => {
  it("returns one flag per drifting issue and omits clean ones", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Has PR" }); // SYD-1
    createIssue(db, human, { projectKey: "SYD", title: "Clean" }); // SYD-2
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    const map = listDeviationByIssueId(db);
    expect(map.get(getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
    expect(map.has(getIssue(db, "SYD-2").id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/services/deviation.test.ts`
Expected: FAIL — cannot import `../../src/services/deviation.js`.

- [ ] **Step 4: Write minimal implementation**

Create `src/services/deviation.ts`:

```ts
// Process-deviation signal (SYD-188): derived, like attention.ts / pr-status.ts,
// purely from issue status + the event log — no stored column. Flags issues that
// have drifted out of the board process (claim -> in_progress -> PR -> in_review
// -> human stamps done). NEVER mutates the issues table; it only reads (and, via
// emitProcessDeviations in webhook-dispatcher, records notification events).
import { eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, issues } from "../db/schema.js";
import { getOpenPr, listOpenPrByIssueId, getMergedPrEvent, type OpenPr } from "./pr-status.js";
import { getSetting } from "./settings.js";

export type DeviationReason = "open_pr_not_in_review" | "merged_pr_not_done" | "stale_claim";
export type DeviationFlag = { reason: DeviationReason; message: string };

// Richer computation shared by the read-path (getDeviation) and the webhook
// emitter (Task 4). `episodeStartId` is the id of the event that began this drift
// episode — the dedup key that makes the webhook fire once per episode.
export type DeviationComputation = DeviationFlag & {
  episodeStartId: number;
  prNumber: number | null;
};

type IssueRow = typeof issues.$inferSelect;

const CANDIDATE_STATUSES = ["todo", "in_progress", "in_review"] as const;

function newestEventAt(db: Db, issue: IssueRow): number {
  const row = db
    .select({ createdAt: max(events.createdAt) })
    .from(events)
    .where(eq(events.issueId, issue.id))
    .get();
  return row?.createdAt ?? issue.createdAt;
}

function openingEventId(db: Db, issueId: number, prNumber: number): number {
  const row = db.all<{ eventId: number | null }>(sql`
    SELECT MAX(id) AS eventId FROM events
    WHERE issue_id = ${issueId}
      AND type IN ('pr_opened', 'gh_pr_opened')
      AND json_extract(payload, '$.prNumber') = ${prNumber}
  `)[0];
  return row?.eventId ?? 0;
}

function claimStartEventId(db: Db, issueId: number): number {
  const row = db.all<{ eventId: number | null }>(sql`
    SELECT MAX(id) AS eventId FROM events
    WHERE issue_id = ${issueId}
      AND type = 'status_changed'
      AND json_extract(payload, '$.to') = 'in_progress'
  `)[0];
  return row?.eventId ?? 0;
}

// Single source of truth for the three deviation cases, in priority order.
export function computeDeviation(
  db: Db,
  issue: IssueRow,
  openPr: OpenPr | null,
  now: number,
  thresholdSeconds: number,
): DeviationComputation | null {
  if (issue.status === "in_review" && openPr === null) {
    const merged = getMergedPrEvent(db, issue.id);
    if (merged) {
      return {
        reason: "merged_pr_not_done",
        message: `PR #${merged.prNumber} is merged — a human can stamp this done`,
        episodeStartId: merged.eventId,
        prNumber: merged.prNumber,
      };
    }
  }
  if ((issue.status === "todo" || issue.status === "in_progress") && openPr !== null) {
    return {
      reason: "open_pr_not_in_review",
      message: `PR #${openPr.prNumber} is open but issue is ${issue.status} — move it to in_review`,
      episodeStartId: openingEventId(db, issue.id, openPr.prNumber),
      prNumber: openPr.prNumber,
    };
  }
  if (issue.status === "in_progress" && !issue.needsInput) {
    const idle = now - newestEventAt(db, issue);
    if (idle > thresholdSeconds) {
      const idleHours = Math.max(1, Math.round(idle / 3600));
      return {
        reason: "stale_claim",
        message: `claimed but idle for ~${idleHours}h — post a progress note or release the claim`,
        episodeStartId: claimStartEventId(db, issue.id),
        prNumber: null,
      };
    }
  }
  return null;
}

export function getDeviation(db: Db, issueId: number): DeviationFlag | null {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) return null;
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const c = computeDeviation(db, issue, getOpenPr(db, issueId), now, threshold);
  return c ? { reason: c.reason, message: c.message } : null;
}

export function listDeviationByIssueId(db: Db): Map<number, DeviationFlag> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const openPrs = listOpenPrByIssueId(db);
  const rows = db
    .select()
    .from(issues)
    .where(inArray(issues.status, [...CANDIDATE_STATUSES]))
    .all();
  const out = new Map<number, DeviationFlag>();
  for (const issue of rows) {
    const c = computeDeviation(db, issue, openPrs.get(issue.id) ?? null, now, threshold);
    if (c) out.set(issue.id, { reason: c.reason, message: c.message });
  }
  return out;
}
```

If `OpenPr` is not currently exported from `pr-status.ts`, it is (`export type OpenPr` at `pr-status.ts:15`) — no change needed there.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/services/deviation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/deviation.ts src/services/settings.ts tests/services/deviation.test.ts
git commit -m "feat: derived process-deviation signal + claims.deviation_seconds (SYD-188)"
```

---

### Task 3: Fold deviation into the `attention` aggregator

Widen the `attention` flag union and compose the deviation source so REST/MCP/search/UI pick it up with no call-site changes. `delivery_failed` keeps top priority.

**Files:**
- Modify: `src/services/attention.ts`
- Test: `tests/services/attention.test.ts`

**Interfaces:**
- Consumes: `getDeviation`, `listDeviationByIssueId`, `type DeviationFlag` from `./deviation.js`.
- Produces (changed): `type AttentionFlag = { reason: "delivery_failed"; message: string } | DeviationFlag`.

- [ ] **Step 1: Write the failing test**

Append to `tests/services/attention.test.ts`. The existing `setup()` only creates SYD-1; these cases build their own drift. Add imports at the top of the file (merge with existing import lines):

```ts
import { updateIssue, claimIssue } from "../../src/services/issues.js";
```

Then append:

```ts
describe("getAttention — composes process deviations", () => {
  it("surfaces a process deviation as an attention flag", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(getAttention(db, getIssue(db, "SYD-1").id)?.reason).toBe("open_pr_not_in_review");
  });

  it("delivery_failed outranks a co-occurring deviation", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "merge conflict" });
    const flag = getAttention(db, getIssue(db, "SYD-1").id);
    expect(flag).toEqual({ reason: "delivery_failed", message: "merge conflict" });
  });

  it("includes deviations in the bulk map, delivery_failed winning on collision", () => {
    const { db, human, agent } = setup();
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(listAttentionByIssueId(db).get(getIssue(db, "SYD-1").id)?.reason).toBe(
      "open_pr_not_in_review",
    );
    recordDeliveryEvent(db, human, "SYD-1", { type: "delivery_failed", message: "boom" });
    expect(listAttentionByIssueId(db).get(getIssue(db, "SYD-1").id)?.reason).toBe("delivery_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/attention.test.ts -t "composes process deviations"`
Expected: FAIL — `getAttention` returns `null` for the deviation cases.

- [ ] **Step 3: Write minimal implementation**

Edit `src/services/attention.ts`. Replace the `AttentionFlag` type and both exported functions:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { getDeviation, listDeviationByIssueId, type DeviationFlag } from "./deviation.js";

export type AttentionFlag = { reason: "delivery_failed"; message: string } | DeviationFlag;

type Row = { issueId: number; message: string | null };

// (unresolvedDeliveryFailures stays exactly as-is)

export function getAttention(db: Db, issueId: number): AttentionFlag | null {
  const [row] = unresolvedDeliveryFailures(db, issueId);
  if (row) return { reason: "delivery_failed", message: row.message ?? "delivery failed" };
  return getDeviation(db, issueId);
}

export function listAttentionByIssueId(db: Db): Map<number, AttentionFlag> {
  // Start from deviations, then let unresolved delivery failures overwrite —
  // delivery_failed (a hard error) outranks any process deviation on collision.
  const map = new Map<number, AttentionFlag>(listDeviationByIssueId(db));
  for (const r of unresolvedDeliveryFailures(db)) {
    map.set(r.issueId, { reason: "delivery_failed", message: r.message ?? "delivery failed" });
  }
  return map;
}
```

Keep the existing `unresolvedDeliveryFailures` function unchanged. Update the top-of-file comment to note it now aggregates deviations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/attention.test.ts`
Expected: PASS (existing delivery_failed cases + new deviation cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/attention.ts tests/services/attention.test.ts
git commit -m "feat: aggregate process deviations into the attention signal (SYD-188)"
```

---

### Task 4: `emitProcessDeviations` webhook push, wired into the dispatcher tick

Record a deduped `process_deviation` event once per drift episode so the existing webhook fan-out delivers it.

**Files:**
- Modify: `src/services/deviation.ts` (add `emitProcessDeviations`)
- Modify: `src/services/webhook-dispatcher.ts` (call it each tick)
- Test: `tests/services/deviation.test.ts` (append)

**Interfaces:**
- Consumes: `computeDeviation` (Task 2), `recordEvent` from `./events.js`.
- Produces: `emitProcessDeviations(db: Db): number` — number of `process_deviation` events recorded this call.

- [ ] **Step 1: Write the failing test**

Append to `tests/services/deviation.test.ts`. Add these imports at the top (merge with existing):

```ts
import { listIssueEvents } from "../../src/services/events.js";
import { emitProcessDeviations } from "../../src/services/deviation.js";
```

Then append:

```ts
function deviationEvents(db: Db, ref: string) {
  return listIssueEvents(db, getIssue(db, ref).id).filter((e) => e.type === "process_deviation");
}

describe("emitProcessDeviations", () => {
  it("records one event per drifting issue", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    const evs = deviationEvents(db, "SYD-1");
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ reason: "open_pr_not_in_review", prNumber: 41 });
  });

  it("does not re-emit within the same episode", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    expect(emitProcessDeviations(db)).toBe(0);
    expect(deviationEvents(db, "SYD-1")).toHaveLength(1);
  });

  it("re-arms for a new episode (a new PR after the old one closed)", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1");
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 41,
      url: "https://github.com/acme/widgets/pull/41",
    });
    expect(emitProcessDeviations(db)).toBe(1);
    // PR #41 lands (clears the open-PR episode), then a new PR #42 opens.
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "delivered",
      prNumber: 41,
      mergeSha: "abc",
      deploy: { ran: false },
    });
    expect(emitProcessDeviations(db)).toBe(0); // in_progress, no open PR, fresh -> nothing
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    expect(emitProcessDeviations(db)).toBe(1); // new episode -> re-armed
    expect(deviationEvents(db, "SYD-1")).toHaveLength(2);
  });

  it("emits nothing when no issue is drifting", () => {
    const { db, human, agent } = setup();
    createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
    updateIssue(db, human, "SYD-1", { status: "todo" });
    claimIssue(db, agent, "SYD-1"); // fresh, no PR
    expect(emitProcessDeviations(db)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/deviation.test.ts -t "emitProcessDeviations"`
Expected: FAIL — `emitProcessDeviations` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/deviation.ts` (add `inArray` is already imported; add `recordEvent` import at top: `import { recordEvent } from "./events.js";`):

```ts
function alreadyEmitted(
  db: Db,
  issueId: number,
  reason: DeviationReason,
  episodeStartId: number,
): boolean {
  const row = db.all<{ id: number }>(sql`
    SELECT id FROM events
    WHERE issue_id = ${issueId}
      AND type = 'process_deviation'
      AND json_extract(payload, '$.reason') = ${reason}
      AND id > ${episodeStartId}
    LIMIT 1
  `)[0];
  return row !== undefined;
}

// Records a `process_deviation` event for every currently-drifting issue that
// has not already been flagged for this episode (dedup derived from events, so
// it self-re-arms on the next episode — no stored "notified" column). The event
// fans out through the existing webhook dispatcher. Attributed to the assignee
// (else creator), mirroring releaseStaleClaims. Returns the count recorded.
export function emitProcessDeviations(db: Db): number {
  const now = Math.floor(Date.now() / 1000);
  const threshold = getSetting(db, "claims.deviation_seconds");
  const rows = db
    .select()
    .from(issues)
    .where(inArray(issues.status, [...CANDIDATE_STATUSES]))
    .all();
  let emitted = 0;
  for (const issue of rows) {
    const c = computeDeviation(db, issue, getOpenPr(db, issue.id), now, threshold);
    if (!c) continue;
    if (alreadyEmitted(db, issue.id, c.reason, c.episodeStartId)) continue;
    recordEvent(db, {
      issueId: issue.id,
      actorId: issue.assigneeId ?? issue.creatorId,
      type: "process_deviation",
      payload: c.prNumber != null ? { reason: c.reason, prNumber: c.prNumber } : { reason: c.reason },
    });
    emitted++;
  }
  return emitted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/deviation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the dispatcher tick**

Edit `src/services/webhook-dispatcher.ts`. Add the import near the existing service imports:

```ts
import { emitProcessDeviations } from "./deviation.js";
```

Inside `startWebhookDispatcher`'s `setInterval` callback, add a guarded block. Emit BEFORE `dispatchPending` so a deviation detected this tick fans out on the same tick:

```ts
  const timer = setInterval(() => {
    try {
      emitProcessDeviations(db);
    } catch (err) {
      console.error("process deviation emit:", err);
    }
    dispatchPending(db).catch((err) => console.error("webhook dispatch:", err));
    try {
      releaseStaleClaims(db);
    } catch (err) {
      console.error("stale claim release:", err);
    }
    try {
      sweepOrphanedAgentSessions(db);
    } catch (err) {
      console.error("orphaned agent session sweep:", err);
    }
  }, intervalMs);
```

- [ ] **Step 6: Run the full dispatcher + deviation suites**

Run: `npx vitest run tests/services/webhook-dispatcher.test.ts tests/services/deviation.test.ts`
Expected: PASS. (The dispatcher's existing tests call `dispatchPending` directly, not `startWebhookDispatcher`, so they are unaffected.)

- [ ] **Step 7: Commit**

```bash
git add src/services/deviation.ts src/services/webhook-dispatcher.ts tests/services/deviation.test.ts
git commit -m "feat: push process-deviation events via webhook fan-out, deduped per episode (SYD-188)"
```

---

### Task 5: UI — widen the attention type and render deviations as a warn chip

Reuse the existing attention rendering. Add a shared `attentionChip` helper so the three views agree on label + severity, and teach `AttentionBanner` to render deviations as a warn banner without the Retry button.

**Files:**
- Modify: `ui/src/types.ts:41`
- Create: `ui/src/attention.ts`
- Modify: `ui/src/views/Board.tsx:190-194`
- Modify: `ui/src/views/Review.tsx:228-232`
- Modify: `ui/src/views/IssueDetail.tsx:242-260`
- Test: `ui/src/attention.test.ts` (create)

**Interfaces:**
- Produces: `attentionChip(attention): { label: string; className: string } | null`

- [ ] **Step 1: Widen the UI type**

In `ui/src/types.ts`, replace line 41 (`attention: { reason: "delivery_failed"; message: string } | null;`) with:

```ts
  attention:
    | { reason: "delivery_failed"; message: string }
    | { reason: "merged_pr_not_done"; message: string }
    | { reason: "open_pr_not_in_review"; message: string }
    | { reason: "stale_claim"; message: string }
    | null;
```

- [ ] **Step 2: Write the failing helper test**

Create `ui/src/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { attentionChip } from "./attention";

describe("attentionChip", () => {
  it("returns null when there is no attention", () => {
    expect(attentionChip(null)).toBeNull();
  });

  it("renders delivery_failed as a danger chip", () => {
    const chip = attentionChip({ reason: "delivery_failed", message: "boom" });
    expect(chip).toEqual({ label: "⛔ delivery failed", className: "badge danger" });
  });

  it("renders each deviation as a warn chip", () => {
    expect(attentionChip({ reason: "open_pr_not_in_review", message: "x" })).toEqual({
      label: "⚠ PR open — move to review",
      className: "badge warn",
    });
    expect(attentionChip({ reason: "merged_pr_not_done", message: "x" })).toEqual({
      label: "⚠ merged — stamp done",
      className: "badge warn",
    });
    expect(attentionChip({ reason: "stale_claim", message: "x" })).toEqual({
      label: "⚠ claim going stale",
      className: "badge warn",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run ui/src/attention.test.ts`
Expected: FAIL — cannot import `./attention`.

- [ ] **Step 4: Implement the helper**

Create `ui/src/attention.ts`:

```ts
import type { Issue } from "./types";

// Single source of truth for how an attention flag renders as a chip. Hard
// errors (delivery_failed) stay red danger; process deviations (SYD-188) render
// as a softer warn nudge.
export function attentionChip(
  attention: Issue["attention"],
): { label: string; className: string } | null {
  if (!attention) return null;
  switch (attention.reason) {
    case "delivery_failed":
      return { label: "⛔ delivery failed", className: "badge danger" };
    case "merged_pr_not_done":
      return { label: "⚠ merged — stamp done", className: "badge warn" };
    case "open_pr_not_in_review":
      return { label: "⚠ PR open — move to review", className: "badge warn" };
    case "stale_claim":
      return { label: "⚠ claim going stale", className: "badge warn" };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run ui/src/attention.test.ts`
Expected: PASS.

- [ ] **Step 6: Use the helper in Board.tsx**

In `ui/src/views/Board.tsx`, add to the imports (near `import type { Issue, Status } from "../types";`):

```tsx
import { attentionChip } from "../attention";
```

Replace the block at lines 190-194:

```tsx
      {issue.attention && (
        <span className="badge danger" title={issue.attention.message}>
          ⛔ delivery failed
        </span>
      )}
```

with:

```tsx
      {issue.attention &&
        (() => {
          const chip = attentionChip(issue.attention)!;
          return (
            <span className={chip.className} title={issue.attention.message}>
              {chip.label}
            </span>
          );
        })()}
```

- [ ] **Step 7: Use the helper in Review.tsx**

In `ui/src/views/Review.tsx`, add `import { attentionChip } from "../attention";` to the imports. Replace lines 228-232:

```tsx
            {current.attention && (
              <span className="badge danger" title={current.attention.message}>
                ⛔ delivery failed
              </span>
            )}
```

with:

```tsx
            {current.attention &&
              (() => {
                const chip = attentionChip(current.attention)!;
                return (
                  <span className={chip.className} title={current.attention.message}>
                    {chip.label}
                  </span>
                );
              })()}
```

- [ ] **Step 8: Update AttentionBanner in IssueDetail.tsx**

In `ui/src/views/IssueDetail.tsx`, replace the `AttentionBanner` function body (lines 242-260) so deviations render as a warn banner and only delivery_failed shows Retry:

```tsx
export function AttentionBanner({
  attention,
  onRetry,
}: {
  attention: Issue["attention"];
  onRetry?: () => void;
}) {
  if (!attention) return null;
  const isError = attention.reason === "delivery_failed";
  return (
    <p className={`banner ${isError ? "danger" : "warn"} issue-attention`}>
      {isError ? "⛔" : "⚠"} {attention.message}
      {isError && onRetry && (
        <button className="retry-delivery" onClick={onRetry}>
          Retry delivery
        </button>
      )}
    </p>
  );
}
```

(No import change needed — the banner uses `attention.message` directly and derives severity from `reason`.)

- [ ] **Step 9: Typecheck + full UI test run**

Run: `npm run typecheck`
Expected: PASS (both app and ui tsconfigs — the widened union is exhaustively handled).

Run: `npx vitest run ui/src/attention.test.ts ui/src/views` (or the affected view tests if named differently)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ui/src/types.ts ui/src/attention.ts ui/src/attention.test.ts ui/src/views/Board.tsx ui/src/views/Review.tsx ui/src/views/IssueDetail.tsx
git commit -m "feat: render process-deviation attention chips in the UI (SYD-188)"
```

---

### Task 6: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (app + ui).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — all suites green, including the new `deviation.test.ts` and the extended `attention.test.ts` / `pr-status.test.ts`.

- [ ] **Step 3: UI build**

Run: `npm run build:ui`
Expected: build succeeds (no type or bundling errors).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the dev server (`npm run dev`), create/claim an issue and open a PR event against it, and confirm the deviation chip appears on the board and issue detail, and that a `process_deviation` event lands in the activity feed exactly once. Attach a screenshot to SYD-188 (UI verification convention).

---

## Self-Review

**Spec coverage:**
- open_pr_not_in_review / merged_pr_not_done / stale_claim derivation → Task 2 (`computeDeviation`), tested positive + negative.
- Derive-not-store → Task 2 (no issues-table writes; only `process_deviation` events). ✓
- No autonomous mutation → enforced by design; Global Constraints + Task 2/4 never touch `issues`. ✓
- Reuse attention rendering / attention chip → Task 3 (aggregator) + Task 5 (UI chip). ✓
- Warn-earlier threshold `claims.deviation_seconds`=3600 → Task 2 Step 1. ✓
- Webhook push, deduped per episode, via existing fan-out → Task 4 (`emitProcessDeviations` + dispatcher wiring), tested for once-per-episode + re-arm. ✓
- `attention` search filter now includes deviations (intended) → falls out of Task 3 since `search.ts` uses `listAttentionByIssueId` unchanged. ✓
- Tests for each case + negatives → Tasks 1–5. ✓

**Placeholder scan:** no TBD/TODO; every code + test step shows real content. ✓

**Type consistency:** `DeviationReason` / `DeviationFlag` / `DeviationComputation` names and the `{ prNumber, eventId }` shape of `getMergedPrEvent` match across Tasks 1, 2, 4. `AttentionFlag = { reason: "delivery_failed"; message } | DeviationFlag` (Task 3) matches the UI union (Task 5). `attentionChip` signature matches its test. `emitProcessDeviations(db): number` consistent across Task 4 impl/test/wiring. ✓
