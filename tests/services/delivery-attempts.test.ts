import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, claimIssue } from "../../src/services/issues.js";
import { updateIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import { upsertPrState } from "../../src/services/pr-state.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { getAttention } from "../../src/services/attention.js";
import { deliveryAttempts, deliveryRollout, DELIVERY_OUTCOMES } from "../../src/db/schema.js";
import {
  listPendingDeliveryAuthorizations,
  startDeliveryAttempt,
  finishDeliveryAttempt,
  recordDerivedHead,
  listUnfinishedAttempts,
  deployRetryDue,
  listDeployRetries,
  ensureRolloutBackfill,
  MAX_DEPLOY_RETRIES,
  DEPLOY_RETRY_BACKOFF_SECONDS,
} from "../../src/services/delivery-attempts.js";

const REPO = "acme/widgets";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  return { db, human, agent };
}

/** Human-created issues land in "backlog" — a human can move straight to
 * "done" from there (only agents are gated on that transition).
 *
 * Also authors a pin on the stamp, matching what a real done-stamp over an
 * open agent PR produces (Fix 1, SYD-208 final review): a pin-less
 * done-stamp is interactive work and is no longer a pending delivery
 * authorization at all (see the "listPendingDeliveryAuthorizations" describe
 * block below), and most tests in this file only need *some* live
 * authorization to drive the start/finish-attempt flows they're actually
 * testing. Tests that specifically exercise the pin-less/interactive-skip
 * path call updateIssue directly instead of this helper. */
let stampDonePinSeq = 0;
function stampDone(
  db: ReturnType<typeof openDb>,
  human: ReturnType<typeof createActor>["actor"],
  ref: string,
) {
  const issue = getIssue(db, ref);
  updateIssue(db, human, ref, { status: "done" });
  stampDonePinSeq += 1;
  // The observation the pin refers to. Production derives a pin from
  // getOpenPr, which cannot return a PR without a pr_state row, so a pin
  // pointing at nothing is a state the system never produces — and since
  // SYD-287 the trigger predicate checks the PR is on agent/<ref>, because a
  // pinned PR the worker cannot rebase is not an authorization.
  upsertPrState(db, human, {
    repo: REPO,
    prNumber: stampDonePinSeq,
    status: "open",
    branch: `agent/${ref}`,
    headSha: `sha-${stampDonePinSeq}`,
  });
  recordEvent(db, {
    issueId: issue.id,
    actorId: human.id,
    type: "status_changed",
    payload: {
      from: "done",
      to: "done",
      pin: { repo: REPO, prNumber: stampDonePinSeq, headSha: `sha-${stampDonePinSeq}` },
    },
  });
}

describe("delivery_attempts schema", () => {
  it("stores and reads an attempt row with the full outcome enum available", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    // Create an event to reference as authorizationId
    recordEvent(db, {
      issueId: 1,
      actorId: human.id,
      type: "status_changed",
      payload: { reason: "test authorization" },
    });

    expect(DELIVERY_OUTCOMES).toEqual([
      "merged_deployed",
      "merged_deploy_failed",
      "verify_failed",
      "conflict_bounced",
      "merge_failed",
      "checks_timeout",
      "sha_chain_disarmed",
      "skipped_rollout",
    ]);

    db.insert(deliveryAttempts)
      .values({ issueRef: "SYD-1", prNumber: 7, headSha: "abc", authorizationId: 1 })
      .run();

    const row = db.select().from(deliveryAttempts).all()[0];
    expect(row.outcome).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.startedAt).toBeGreaterThan(0);
  });
});

describe("listPendingDeliveryAuthorizations", () => {
  it("returns a done-stamped issue's stamp with its pin payload", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 7,
      status: "open",
      branch: `agent/${issue.ref}`,
      headSha: "abc",
    });
    // Plain human stamp, bypassing the stampDone helper's auto-pin — this
    // issue has no bound github repo, so getOpenPr can't attribute the
    // upsertPrState row above anyway: a vanilla status_changed event with no
    // pin, same as real production behavior for interactive work.
    updateIssue(db, human, issue.ref, { status: "done" });
    // Author the pinned stamp directly, newer than the plain one above, so
    // it — and only it — is the live authorization (latest-stamp-per-issue).
    const pinnedEventId = recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "status_changed",
      payload: { from: "done", to: "done", pin: { repo: REPO, prNumber: 7, headSha: "abc" } },
    });

    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({
      authorizationId: pinnedEventId,
      ref: issue.ref,
      kind: "done_stamp",
      pin: { repo: REPO, prNumber: 7, headSha: "abc" },
      priorHeads: [],
    });
  });

  // SYD-231: a delivery whose prior attempt already force-pushed a rebased
  // head S1 leaves the branch at S1. A re-stamp still pins the original S0, so
  // the worker's SHA-chain anchor [S0] would reject its OWN rebase as a
  // "moved head" and disarm. Carrying the prior attempts' recorded derived
  // heads lets the worker recognize S1 as authorized and re-rebase instead.
  it("carries the worker's prior recorded derived heads for the PR (SYD-231)", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    updateIssue(db, human, issue.ref, { status: "done" });
    // A redeliver pin comes from deliveryPinFor in production, so the PR it
    // names always has a pr_state row behind it (SYD-287's trigger guard).
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 7,
      status: "open",
      branch: `agent/${issue.ref}`,
      headSha: "S0",
    });
    // First re-stamp: its attempt force-pushed a rebased head "S1" and bounced.
    const auth1 = recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: { pin: { repo: REPO, prNumber: 7, headSha: "S0" } },
    });
    const attempt1 = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: auth1,
      prNumber: 7,
      headSha: "S0",
    });
    finishDeliveryAttempt(db, human, attempt1.id, {
      outcome: "sha_chain_disarmed",
      derivedHeadSha: "S1",
    });
    // Second re-stamp: still pinned to S0, but the branch now sits at S1.
    const auth2 = recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: { pin: { repo: REPO, prNumber: 7, headSha: "S0" } },
    });

    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending.map((p) => p.authorizationId)).toEqual([auth2]);
    expect(pending[0].priorHeads).toContain("S1");
  });

  it("does not carry derived heads recorded for a different PR number (SYD-231)", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    updateIssue(db, human, issue.ref, { status: "done" });
    for (const prNumber of [7, 8]) {
      upsertPrState(db, human, {
        repo: REPO,
        prNumber,
        status: "open",
        branch: `agent/${issue.ref}`,
        headSha: `head-${prNumber}`,
      });
    }
    const auth1 = recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: { pin: { repo: REPO, prNumber: 8, headSha: "other-S0" } },
    });
    const attempt1 = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: auth1,
      prNumber: 8,
      headSha: "other-S0",
    });
    finishDeliveryAttempt(db, human, attempt1.id, {
      outcome: "sha_chain_disarmed",
      derivedHeadSha: "other-S1",
    });
    const auth2 = recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: { pin: { repo: REPO, prNumber: 7, headSha: "S0" } },
    });

    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending.map((p) => p.authorizationId)).toEqual([auth2]);
    expect(pending[0].priorHeads).not.toContain("other-S1");
  });

  it("no-spin: once an attempt row exists for the authorization, it is not pending", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    expect(pending).toBeDefined();

    startDeliveryAttempt(db, human, issue.ref, { authorizationId: pending.authorizationId });

    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);
  });

  it("status-retract disarms: stamp then move done->in_review leaves nothing pending", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    expect(listPendingDeliveryAuthorizations(db)).toHaveLength(1);

    updateIssue(db, human, issue.ref, { status: "in_review" });

    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);
  });

  it("stamp -> retract -> re-stamp yields exactly one pending authorization (the newest)", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    updateIssue(db, human, issue.ref, { status: "in_review" });
    stampDone(db, human, issue.ref);

    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("done_stamp");
    expect(pending[0].ref).toBe(issue.ref);
  });

  it("every redeliver_requested is its own authorization", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: {},
    });
    recordEvent(db, {
      issueId: issue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: {},
    });

    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending).toHaveLength(3);
    const kinds = pending.map((p) => p.kind).sort();
    expect(kinds).toEqual(["done_stamp", "redeliver", "redeliver"]);
    const ids = new Set(pending.map((p) => p.authorizationId));
    expect(ids.size).toBe(3);
    for (const p of pending.filter((p) => p.kind === "redeliver")) {
      expect(p.pin).toBeNull();
    }
  });

  it("observation lag: pr_state still open + finished attempt row => nothing pending (no re-merge)", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 9,
      status: "open",
      branch: `agent/${issue.ref}`,
      headSha: "abc",
    });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deployed" });

    // pr_state was never re-observed as merged (still "open") — the attempt
    // row alone is what disarms the authorization, not pr_state.
    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);
  });

  it("interactive done-stamp is never pending: no open agent PR means no pin, and no authorization", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Fix a typo" });

    // A human stamps done via the real production path — no pr_state row for
    // this issue at all, so updateIssue's getOpenPr check finds nothing and
    // the status_changed event carries no pin (ordinary interactive work).
    updateIssue(db, human, issue.ref, { status: "done" });

    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);

    // The rollout backfill consumes the exact same predicate (parity by
    // construction), so it must not write a row for this issue either.
    const result = ensureRolloutBackfill(db);
    expect(result).toEqual({ backfilled: 0, alreadyDone: false });
    expect(db.select().from(deliveryAttempts).all()).toEqual([]);
  });

  it("an older PINNED stamp does not resurrect once the newest stamp on the issue is pin-less", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });

    // A real open agent PR — the done-stamp below is pinned via the actual
    // production expectedHeadSha flow.
    recordDeliveryEvent(db, human, issue.ref, {
      type: "pr_opened",
      prNumber: 21,
      url: `https://github.com/${REPO}/pull/21`,
      headSha: "sha-open",
    });
    updateIssue(db, human, issue.ref, { status: "done", expectedHeadSha: "sha-open" });
    expect(listPendingDeliveryAuthorizations(db)).toHaveLength(1); // sanity: it WAS pending

    // Retract — the human's retract explicitly withdraws that trigger.
    updateIssue(db, human, issue.ref, { status: "in_review" });

    // The PR merges (no longer open), then the human re-stamps done. With no
    // open PR left, the real production path attaches no pin this time.
    recordDeliveryEvent(db, human, issue.ref, {
      type: "delivered",
      prNumber: 21,
      mergeSha: "sha-open",
      deploy: { ran: false },
    });
    updateIssue(db, human, issue.ref, { status: "done" });

    // The newest stamp governs, and it's pin-less — nothing pending, even
    // though an OLDER pinned stamp exists earlier in this issue's history.
    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);
  });
});

// SYD-228: getOpenPr reads pr_state, which only the webhook/poller populate —
// if a done-stamp lands while both are behind, the stamp gets no pin and is
// silently excluded from delivery forever (this is what happened to SYD-194
// and ten other PRs when the poller was down). SYD-204's done_without_merged_pr
// deviation makes that gap visible instead of silent; this traces the full
// incident-and-recovery narrative end to end: pin-less stamp -> excluded from
// delivery + flagged for a human -> poller catches up -> human re-stamps ->
// now pinned and pending, exactly the "recovery" the original bug report
// says is the only way out.
describe("poller-down done-stamp then recovery (SYD-228)", () => {
  it("flags the gap instead of silently losing the delivery, and recovers once pr_state catches up", () => {
    const { db, human, agent } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
    updateIssue(db, human, issue.ref, { status: "todo" });
    claimIssue(db, agent, issue.ref);
    updateIssue(db, human, issue.ref, { status: "in_review" });

    // The agent's PR is open on GitHub, but neither the webhook nor the
    // poller has recorded it yet — pr_state has no row for this issue.
    updateIssue(db, human, issue.ref, { status: "done" });

    // Silent no more: the stamp succeeded, but a human sees an attention flag...
    expect(getAttention(db, issue.id)?.reason).toBe("done_without_merged_pr");
    // ...and the pin-less stamp is correctly excluded from delivery.
    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);

    // The poller recovers and observes the still-open PR.
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 41,
      status: "open",
      branch: `agent/${issue.ref}`,
      url: `https://github.com/${REPO}/pull/41`,
      headSha: "sha-recovered",
    });

    // A human notices the flag and follows the documented recovery: retract
    // and re-stamp, now that pr_state has caught up.
    updateIssue(db, human, issue.ref, { status: "in_review" });
    updateIssue(db, human, issue.ref, {
      status: "done",
      expectedHeadSha: "sha-recovered",
    });

    // The re-stamp is properly pinned and picked up for delivery.
    const pending = listPendingDeliveryAuthorizations(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].pin).toEqual({ repo: REPO, prNumber: 41, headSha: "sha-recovered" });

    // The stale attention flag persists until the PR actually merges — it's
    // not the re-stamp that clears it, but real delivery.
    expect(getAttention(db, issue.id)?.reason).toBe("done_without_merged_pr");
    upsertPrState(db, human, {
      repo: REPO,
      prNumber: 41,
      status: "merged",
      branch: `agent/${issue.ref}`,
      url: `https://github.com/${REPO}/pull/41`,
      ghUpdatedAt: "2026-07-14T12:00:00Z",
      mergeSha: "sha-recovered",
    });
    expect(getAttention(db, issue.id)).toBeNull();
  });
});

describe("startDeliveryAttempt / finishDeliveryAttempt", () => {
  it("refuses agent actors", () => {
    const { db, human, agent } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);

    expect(() =>
      startDeliveryAttempt(db, agent, issue.ref, { authorizationId: pending.authorizationId }),
    ).toThrow(/agent/i);
  });

  it("is once-per-authorization: second start throws", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);

    startDeliveryAttempt(db, human, issue.ref, { authorizationId: pending.authorizationId });

    expect(() =>
      startDeliveryAttempt(db, human, issue.ref, { authorizationId: pending.authorizationId }),
    ).toThrow(/already has a delivery attempt/);
  });

  it("deployRetry start requires latest outcome merged_deploy_failed", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });

    // Not finished yet — deployRetry must refuse.
    expect(() =>
      startDeliveryAttempt(db, human, issue.ref, {
        authorizationId: pending.authorizationId,
        deployRetry: true,
      }),
    ).toThrow();

    finishDeliveryAttempt(db, human, attempt.id, { outcome: "verify_failed" });

    // Finished, but not with merged_deploy_failed — still refused.
    expect(() =>
      startDeliveryAttempt(db, human, issue.ref, {
        authorizationId: pending.authorizationId,
        deployRetry: true,
      }),
    ).toThrow();
  });

  it("deployRetry start succeeds once the latest outcome is merged_deploy_failed", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deploy_failed" });

    const retry = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
      deployRetry: true,
    });
    expect(retry.authorizationId).toBe(pending.authorizationId);
    expect(retry.id).not.toBe(attempt.id);
  });

  it("finish sets outcome + finishedAt; refuses a second finish", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });

    const finished = finishDeliveryAttempt(db, human, attempt.id, {
      outcome: "merged_deployed",
      derivedHeadSha: "deadbeef",
    });
    expect(finished.outcome).toBe("merged_deployed");
    expect(finished.derivedHeadSha).toBe("deadbeef");
    expect(finished.finishedAt).toBeGreaterThan(0);

    expect(() =>
      finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deployed" }),
    ).toThrow();
  });

  it("finish refuses skipped_rollout", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });

    expect(() =>
      finishDeliveryAttempt(db, human, attempt.id, { outcome: "skipped_rollout" }),
    ).toThrow(/skipped_rollout is written only by the rollout backfill/);
  });
});

describe("recordDerivedHead (SYD-209 interim S1 persist)", () => {
  it("persists derivedHeadSha on an open attempt without finishing it", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
      prNumber: 5,
      headSha: "s0-authorized-head",
    });

    const updated = recordDerivedHead(db, human, attempt.id, "s1-rebased-head");
    expect(updated.derivedHeadSha).toBe("s1-rebased-head");
    // Still open: no outcome, no finishedAt — this is a mid-attempt write so a
    // crash after the rebase re-anchors on S1 rather than disarming.
    expect(updated.outcome).toBeNull();
    expect(updated.finishedAt).toBeNull();

    // And it stays in the crash-resumption queue carrying S1.
    const unfinished = listUnfinishedAttempts(db);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].id).toBe(attempt.id);
    expect(unfinished[0].derivedHeadSha).toBe("s1-rebased-head");
  });

  it("refuses to record on an already-finished attempt", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deployed" });

    expect(() => recordDerivedHead(db, human, attempt.id, "s1")).toThrow(
      /does not exist or has already been finished/,
    );
  });

  it("refuses an agent actor (delivery infra is human-token only)", () => {
    const { db, human, agent } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });

    expect(() => recordDerivedHead(db, agent, attempt.id, "s1")).toThrow(
      /Only the delivery infrastructure/,
    );
  });
});

describe("listUnfinishedAttempts", () => {
  it("returns only attempts with no outcome yet, ordered by id", () => {
    const { db, human } = setup();
    const issueA = createIssue(db, human, { projectKey: "SYD", title: "A" });
    const issueB = createIssue(db, human, { projectKey: "SYD", title: "B" });
    stampDone(db, human, issueA.ref);
    stampDone(db, human, issueB.ref);
    const pending = listPendingDeliveryAuthorizations(db);
    const attemptA = startDeliveryAttempt(db, human, issueA.ref, {
      authorizationId: pending.find((p) => p.ref === issueA.ref)!.authorizationId,
    });
    startDeliveryAttempt(db, human, issueB.ref, {
      authorizationId: pending.find((p) => p.ref === issueB.ref)!.authorizationId,
    });
    finishDeliveryAttempt(db, human, attemptA.id, { outcome: "merged_deployed" });

    const unfinished = listUnfinishedAttempts(db);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].issueRef).toBe(issueB.ref);
  });
});

describe("deploy retries", () => {
  it("deployRetryDue: bounded at MAX_DEPLOY_RETRIES and backs off exponentially", () => {
    expect(deployRetryDue(1, 1000, 1000 + 300)).toBe(true);
    expect(deployRetryDue(1, 1000, 1000 + 299)).toBe(false);
    expect(deployRetryDue(2, 1000, 1000 + 600)).toBe(true);
    expect(deployRetryDue(4, 1000, 1_000_000)).toBe(false); // bound: 3 retries max
  });

  it("listDeployRetries surfaces only latest-attempt merged_deploy_failed past backoff", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
      prNumber: 5,
      headSha: "abc",
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deploy_failed" });
    // Pin the finishedAt to a known clock value so backoff math is exact.
    db.update(deliveryAttempts)
      .set({ finishedAt: 1_000_000 })
      .where(eq(deliveryAttempts.id, attempt.id))
      .run();

    expect(listDeployRetries(db, 1_000_000 + DEPLOY_RETRY_BACKOFF_SECONDS - 1)).toEqual([]);

    const due = listDeployRetries(db, 1_000_000 + DEPLOY_RETRY_BACKOFF_SECONDS);
    expect(due).toEqual([
      {
        authorizationId: pending.authorizationId,
        ref: issue.ref,
        prNumber: 5,
        headSha: "abc",
        retryNumber: 1,
      },
    ]);
  });

  it("a merged_deployed retry outcome clears the issue from the retry list", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deploy_failed" });
    db.update(deliveryAttempts)
      .set({ finishedAt: 1_000_000 })
      .where(eq(deliveryAttempts.id, attempt.id))
      .run();
    expect(listDeployRetries(db, 1_000_000 + DEPLOY_RETRY_BACKOFF_SECONDS)).toHaveLength(1);

    const retry = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
      deployRetry: true,
    });
    finishDeliveryAttempt(db, human, retry.id, { outcome: "merged_deployed" });

    expect(listDeployRetries(db, 1_000_000 + DEPLOY_RETRY_BACKOFF_SECONDS * 10)).toEqual([]);
  });
});

describe("ensureRolloutBackfill", () => {
  it("rollout fires nothing: writes skipped_rollout for BOTH kinds and empties the pending list", () => {
    const { db, human } = setup();
    const stampedIssue = createIssue(db, human, { projectKey: "SYD", title: "Stamped" });
    stampDone(db, human, stampedIssue.ref);
    const redeliverIssue = createIssue(db, human, { projectKey: "SYD", title: "Redeliver" });
    stampDone(db, human, redeliverIssue.ref);
    recordEvent(db, {
      issueId: redeliverIssue.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: {},
    });

    const before = listPendingDeliveryAuthorizations(db);
    expect(before).toHaveLength(3); // 2 done_stamp + 1 redeliver

    const result = ensureRolloutBackfill(db);
    expect(result).toEqual({ backfilled: 3, alreadyDone: false });
    expect(listPendingDeliveryAuthorizations(db)).toEqual([]);

    const rows = db.select().from(deliveryAttempts).all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.outcome).toBe("skipped_rollout");
      expect(row.finishedAt).toBeGreaterThan(0);
    }
  });

  it("is once-only: a second call is a no-op even with new pending authorizations", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
    stampDone(db, human, issue.ref);

    const first = ensureRolloutBackfill(db);
    expect(first).toEqual({ backfilled: 1, alreadyDone: false });
    expect(db.select().from(deliveryRollout).all()).toHaveLength(1);

    const newIssue = createIssue(db, human, { projectKey: "SYD", title: "New" });
    stampDone(db, human, newIssue.ref);

    const second = ensureRolloutBackfill(db);
    expect(second).toEqual({ backfilled: 0, alreadyDone: true });

    const stillPending = listPendingDeliveryAuthorizations(db);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].ref).toBe(newIssue.ref);
  });
});
