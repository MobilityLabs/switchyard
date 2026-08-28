import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { claimLeases, sessions } from "../../src/db/schema.js";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, claimIssue, getIssue } from "../../src/services/issues.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";
import { attributionOf, NO_SESSION } from "../../src/services/attribution.js";
import { getActiveLease } from "../../src/services/leases.js";
import { ensureSupervisedClaimCutover } from "../../src/services/supervised-claim-cutover.js";

let db: Db, human: HumanActor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  createProject(db, human, { key: "SYD", name: "Switchyard" });
});

/** A supervised session, and the attribution its writes carry. */
function supervised() {
  const { sessionToken } = openSupervisedSession(db, human, "claude");
  const prin = resolveSupervisedPrincipal(db, sessionToken)!;
  return { attr: attributionOf(prin), agent: prin.viaAgent! };
}

function todoIssue(title: string) {
  const issue = createIssue(db, human, { projectKey: "SYD", title });
  updateIssue(db, human, issue.ref, { status: "todo" });
  return issue;
}

describe("ensureSupervisedClaimCutover", () => {
  it("releases a supervised claim and invalidates its lease, so the agent can re-claim AND WRITE", () => {
    const issue = todoIssue("Held by a supervised session");
    const { attr, agent } = supervised();
    claimIssue(db, human, issue.ref, {}, attr);
    expect(getIssue(db, issue.ref).assigneeId).toBe(agent.id);

    // Simulate the pre-deploy world: the claim was recorded with the HUMAN as
    // holder, which is what every claim written before the identity rule looks
    // like. The `assigned` event keeps its sessionId, which is the only thing
    // that marks it supervised.
    db.run(sql`UPDATE issues SET assignee_id = ${human.id} WHERE id = ${issue.id}`);
    db.run(sql`UPDATE claim_leases SET actor_id = ${human.id} WHERE issue_id = ${issue.id}`);

    const res = ensureSupervisedClaimCutover(db);
    expect(res.released).toBe(1);

    const after = getIssue(db, issue.ref);
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    // The lease must go too. Left active, the re-claim below mints a SECOND
    // active row and getActiveLease (no ORDER BY) can return the stale human one
    // — the agent would hold a token validateLease rejects, forever.
    expect(getActiveLease(db, issue.id)).toBeNull();

    // The whole point: re-claim, then actually WRITE with the new lease. A test
    // that stops at the re-claim goes green with the two-lease hole open — the
    // claim succeeds and the NEXT write is what fails.
    const { attr: attr2, agent: agent2 } = supervised();
    const { leaseToken } = claimIssue(db, human, issue.ref, {}, attr2);
    expect(getIssue(db, issue.ref).assigneeId).toBe(agent2.id);
    expect(
      db
        .select()
        .from(claimLeases)
        .where(and(eq(claimLeases.issueId, issue.id), isNull(claimLeases.invalidatedAt)))
        .all(),
    ).toHaveLength(1);
    expect(() =>
      updateIssue(db, human, issue.ref, { priority: "high" }, { presented: leaseToken }, attr2),
    ).not.toThrow();
  });

  it("leaves an in-person human claim alone — it is not ours to release", () => {
    const issue = todoIssue("Claimed by Sean at his desk");
    claimIssue(db, human, issue.ref, {}, NO_SESSION);
    expect(getIssue(db, issue.ref).assigneeId).toBe(human.id);

    const res = ensureSupervisedClaimCutover(db);
    expect(res.released).toBe(0);

    const after = getIssue(db, issue.ref);
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).toBe(human.id);
  });

  it("soft-closes open supervised sessions so they re-mint under the new naming", () => {
    supervised();
    supervised();
    expect(
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.kind, "supervised"), isNull(sessions.closedAt)))
        .all(),
    ).toHaveLength(2);

    const res = ensureSupervisedClaimCutover(db);
    expect(res.sessionsClosed).toBe(2);
    expect(
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.kind, "supervised"), isNull(sessions.closedAt)))
        .all(),
    ).toHaveLength(0);
    // Soft-close, never DELETE: sessions.id is an FK target for events.sessionId.
    expect(db.select().from(sessions).all()).toHaveLength(2);
  });

  it("is once-only across restarts", () => {
    const issue = todoIssue("Held");
    const { attr } = supervised();
    claimIssue(db, human, issue.ref, {}, attr);
    db.run(sql`UPDATE issues SET assignee_id = ${human.id} WHERE id = ${issue.id}`);

    expect(ensureSupervisedClaimCutover(db).released).toBe(1);
    const second = ensureSupervisedClaimCutover(db);
    expect(second.alreadyDone).toBe(true);
    expect(second.released).toBe(0);
  });
});
