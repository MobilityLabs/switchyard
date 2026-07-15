// Task 6: exercises the divert (src/services/issues.ts updateIssue) together
// with the affirm executor (src/services/hard-gate.ts affirmPendingAction) as
// one end-to-end flow — a supervised proposal creates the pending row, then a
// human affirms it. Task 5's hard-gate.test.ts covers affirmPendingAction in
// isolation (rows created directly via findOrCreatePendingAction); this file
// checks the same guarantees hold when the row comes from the real divert.
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, updateIssue } from "../../src/services/issues.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { pendingActions } from "../../src/db/schema.js";
import { affirmPendingAction, getPendingAction } from "../../src/services/hard-gate.js";

const REPO = "acme/widgets";

let db: Db, human: Actor, issueId: number, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  issueId = createIssue(db, human, { projectKey: "SYD", title: "t", description: "d" }).id;
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
});

function onlyPendingId(): number {
  const rows = db.select().from(pendingActions).all();
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe("divert -> affirm end to end", () => {
  it("affirming the human's own pending action executes the done transition", () => {
    expect(() =>
      updateIssue(db, human, "SYD-1", { status: "done" }, {}, { sessionId }),
    ).toThrow(/awaiting human affirmation/i);
    const id = onlyPendingId();
    const view = affirmPendingAction(db, human, id);
    expect(view.status).toBe("done");
    expect(getIssue(db, "SYD-1").status).toBe("done");
    expect(getPendingAction(db, id)!.status).toBe("affirmed");
  });

  it("rolls back the claim when the executor's updateIssue throws, leaving the row pending", () => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
    recordDeliveryEvent(db, human, "SYD-1", {
      type: "pr_opened",
      prNumber: 7,
      url: `https://github.com/${REPO}/pull/7`,
      headSha: "current-sha",
    });
    // The divert parks the proposal without validating the SYD-208 pin — that
    // check only runs inside updateIssue's mutation transaction, which the
    // affirm executor re-drives.
    expect(() =>
      updateIssue(
        db,
        human,
        "SYD-1",
        { status: "done", expectedHeadSha: "stale-sha" },
        {},
        { sessionId },
      ),
    ).toThrow(/awaiting human affirmation/i);
    const id = onlyPendingId();

    expect(() => affirmPendingAction(db, human, id)).toThrow(/stale-sha/);
    expect(getPendingAction(db, id)!.status).toBe("pending");
    expect(getIssue(db, "SYD-1").status).not.toBe("done");
  });

  it("double-affirm: second affirm throws and exactly one done event is recorded", () => {
    expect(() =>
      updateIssue(db, human, "SYD-1", { status: "done" }, {}, { sessionId }),
    ).toThrow(/awaiting human affirmation/i);
    const id = onlyPendingId();

    affirmPendingAction(db, human, id);
    expect(() => affirmPendingAction(db, human, id)).toThrow(/no longer pending/i);

    const n = db.get<{ c: number }>(sql`SELECT COUNT(*) c FROM events WHERE issue_id = ${issueId} AND type='status_changed' AND json_extract(payload,'$.to') = 'done'`);
    expect(n!.c).toBe(1);
    expect(getIssue(db, "SYD-1").status).toBe("done");
  });
});
