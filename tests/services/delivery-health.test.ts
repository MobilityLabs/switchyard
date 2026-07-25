import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import {
  listPendingDeliveryAuthorizations,
  startDeliveryAttempt,
  finishDeliveryAttempt,
} from "../../src/services/delivery-attempts.js";
import { deliveryAttempts } from "../../src/db/schema.js";
import { getDeliveryHealth } from "../../src/services/delivery-health.js";

const REPO = "acme/widgets";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  return { db, human };
}

let stampDonePinSeq = 0;
function stampDone(
  db: ReturnType<typeof openDb>,
  human: ReturnType<typeof createActor>["actor"],
  ref: string,
) {
  const issue = getIssue(db, ref);
  updateIssue(db, human, ref, { status: "done" });
  stampDonePinSeq += 1;
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

function backdateAttempt(db: ReturnType<typeof openDb>, attemptId: number, startedAt: number) {
  db.update(deliveryAttempts).set({ startedAt }).where(eq(deliveryAttempts.id, attemptId)).run();
}

describe("getDeliveryHealth", () => {
  it("returns zeroed-out stats when there are no delivery attempts", () => {
    const { db } = setup();
    const health = getDeliveryHealth(db);
    expect(health.firstAttempt).toEqual({ total: 0, succeeded: 0, rate: null });
    expect(health.redeliverRequiredCount).toBe(0);
    expect(health.topByRedeliverCount).toEqual([]);
  });

  it("computes first-attempt success rate across finished attempts", () => {
    const { db, human } = setup();
    const issueA = createIssue(db, human, { projectKey: "SYD", title: "Ship A" });
    const issueB = createIssue(db, human, { projectKey: "SYD", title: "Ship B" });
    stampDone(db, human, issueA.ref);
    stampDone(db, human, issueB.ref);
    const [pendingA, pendingB] = listPendingDeliveryAuthorizations(db);

    const attemptA = startDeliveryAttempt(db, human, issueA.ref, {
      authorizationId: pendingA.authorizationId,
    });
    finishDeliveryAttempt(db, human, attemptA.id, { outcome: "merged_deployed" });

    const attemptB = startDeliveryAttempt(db, human, issueB.ref, {
      authorizationId: pendingB.authorizationId,
    });
    finishDeliveryAttempt(db, human, attemptB.id, { outcome: "verify_failed" });

    const health = getDeliveryHealth(db);
    expect(health.firstAttempt).toEqual({ total: 2, succeeded: 1, rate: 0.5 });
  });

  it("does not count an unfinished (in-flight) attempt toward the rate", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship A" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    startDeliveryAttempt(db, human, issue.ref, { authorizationId: pending.authorizationId });

    const health = getDeliveryHealth(db);
    expect(health.firstAttempt).toEqual({ total: 0, succeeded: 0, rate: null });
  });

  it("a deploy-only retry does not count as a second first-attempt, and the rate reflects the ORIGINAL outcome", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Ship A" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);

    const original = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, original.id, { outcome: "merged_deploy_failed" });

    const retry = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
      deployRetry: true,
    });
    finishDeliveryAttempt(db, human, retry.id, { outcome: "merged_deployed" });

    const health = getDeliveryHealth(db);
    // Two rows exist in delivery_attempts for this one authorization, but
    // first-attempt accounting only looks at the earliest (the original,
    // which failed) — the eventual retry success doesn't retroactively
    // count as a first-attempt success.
    expect(health.firstAttempt).toEqual({ total: 1, succeeded: 0, rate: 0 });
  });

  it("counts issues requiring a redeliver, keyed by distinct redeliver authorizations not attempt rows", () => {
    const { db, human } = setup();
    const flaky = createIssue(db, human, { projectKey: "SYD", title: "Flaky ship" });
    const clean = createIssue(db, human, { projectKey: "SYD", title: "Clean ship" });
    stampDone(db, human, flaky.ref);
    stampDone(db, human, clean.ref);
    const [pendingFlaky, pendingClean] = listPendingDeliveryAuthorizations(db);

    // Clean issue: one done-stamp, succeeds first try — never redelivered.
    const cleanAttempt = startDeliveryAttempt(db, human, clean.ref, {
      authorizationId: pendingClean.authorizationId,
    });
    finishDeliveryAttempt(db, human, cleanAttempt.id, { outcome: "merged_deployed" });

    // Flaky issue: done-stamp fails, then a redeliver is requested and its
    // own attempt needs a deploy retry (two attempt rows, one authorization).
    const flakyAttempt = startDeliveryAttempt(db, human, flaky.ref, {
      authorizationId: pendingFlaky.authorizationId,
    });
    finishDeliveryAttempt(db, human, flakyAttempt.id, { outcome: "verify_failed" });

    const redeliverEventId = recordEvent(db, {
      issueId: flaky.id,
      actorId: human.id,
      type: "redeliver_requested",
      payload: { pin: { repo: REPO, prNumber: 1, headSha: "sha-redeliver" } },
    });
    const redeliverAttempt = startDeliveryAttempt(db, human, flaky.ref, {
      authorizationId: redeliverEventId,
    });
    finishDeliveryAttempt(db, human, redeliverAttempt.id, { outcome: "merged_deploy_failed" });
    const redeliverRetry = startDeliveryAttempt(db, human, flaky.ref, {
      authorizationId: redeliverEventId,
      deployRetry: true,
    });
    finishDeliveryAttempt(db, human, redeliverRetry.id, { outcome: "merged_deployed" });

    const health = getDeliveryHealth(db);
    expect(health.redeliverRequiredCount).toBe(1);
    expect(health.topByRedeliverCount).toEqual([{ ref: flaky.ref, redeliverCount: 1 }]);
  });

  it("ranks top issues by redeliver count, descending", () => {
    const { db, human } = setup();
    const hot = createIssue(db, human, { projectKey: "SYD", title: "Hot issue" });
    const warm = createIssue(db, human, { projectKey: "SYD", title: "Warm issue" });
    stampDone(db, human, hot.ref);
    stampDone(db, human, warm.ref);

    for (const ref of [hot.ref, hot.ref, warm.ref]) {
      const issue = getIssue(db, ref);
      const eventId = recordEvent(db, {
        issueId: issue.id,
        actorId: human.id,
        type: "redeliver_requested",
        payload: {},
      });
      const attempt = startDeliveryAttempt(db, human, ref, { authorizationId: eventId });
      finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deployed" });
    }

    const health = getDeliveryHealth(db);
    expect(health.topByRedeliverCount).toEqual([
      { ref: hot.ref, redeliverCount: 2 },
      { ref: warm.ref, redeliverCount: 1 },
    ]);
  });

  it("excludes attempts started outside the rolling window", () => {
    const { db, human } = setup();
    const issue = createIssue(db, human, { projectKey: "SYD", title: "Old ship" });
    stampDone(db, human, issue.ref);
    const [pending] = listPendingDeliveryAuthorizations(db);
    const attempt = startDeliveryAttempt(db, human, issue.ref, {
      authorizationId: pending.authorizationId,
    });
    finishDeliveryAttempt(db, human, attempt.id, { outcome: "merged_deployed" });
    backdateAttempt(db, attempt.id, Math.floor(Date.now() / 1000) - 48 * 3600);

    const health = getDeliveryHealth(db, 24);
    expect(health.firstAttempt).toEqual({ total: 0, succeeded: 0, rate: null });
  });

  it("rejects a non-positive window", () => {
    const { db } = setup();
    expect(() => getDeliveryHealth(db, 0)).toThrow(/positive/);
    expect(() => getDeliveryHealth(db, -5)).toThrow(/positive/);
    expect(() => getDeliveryHealth(db, NaN)).toThrow(/positive/);
  });

  it("defaults to a 24 hour window and echoes it back", () => {
    const { db } = setup();
    const health = getDeliveryHealth(db);
    expect(health.windowHours).toBe(24);
    expect(health.since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 24 * 3600 + 1);
  });
});
