// SYD-241: addComment's needsInput-clearing status write used to go straight
// to tx.update(issues), a second door that never passed through updateIssue's
// hard-gate divert (src/services/hard-gate.ts). A supervised session could
// request_human_input and then answer its own escalation, writing `todo` and
// releasing its own claim with the gate never seeing it. Bounded today only
// because `supervised.hard_gate_actions` can only ever hold "done" (the
// settings validator rejects anything else, per EXECUTABLE_GATE_ACTIONS) and
// `todo` is not a gated transition. This test proves the fix is structural —
// not merely that today's config happens to be safe — by bypassing the
// validator to gate `todo` directly in the settings table, the way a future
// config change could, and confirming addComment's write is now diverted
// exactly like a direct updateIssue call would be.
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, claimIssue } from "../../src/services/issues.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { addComment } from "../../src/services/comments.js";
import { settings } from "../../src/db/schema.js";
import { isHardGated } from "../../src/services/hard-gate.js";

let db: Db, human: Actor, agent: Actor, sessionId: number;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "t", description: "d" });
  sessionId = openSupervisedSession(db, human, "claude-code").sessionId;
});

function gateTodo() {
  // Bypasses settings.ts's setSetting validator on purpose (it currently
  // rejects any hard_gate_actions value other than "done") to simulate the
  // scenario the issue calls out: "it starts to matter if someone gates
  // todo." Confirms the choke point holds even for a value the product
  // doesn't allow configuring yet.
  db.insert(settings).values({ key: "supervised.hard_gate_actions", value: ["todo"] }).run();
}

describe("addComment's answer-path status write vs the hard-gate", () => {
  it("diverts a supervised self-answer instead of silently writing a gated status", () => {
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?");
    gateTodo();
    expect(isHardGated(db, "todo")).toBe(true);

    expect(() => addComment(db, human, "SYD-1", "Go with option B.", { sessionId })).toThrow();

    // Nothing committed: not the status, not the claim release, not even the
    // needsInput flag or the comment itself — the whole write rolled back.
    const after = getIssue(db, "SYD-1");
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).not.toBeNull();
    expect(after.needsInput).toBe(true);
  });

  it("still answers normally when the target status is not gated (baseline)", () => {
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?");

    expect(() =>
      addComment(db, human, "SYD-1", "Go with option B.", { sessionId }),
    ).not.toThrow();

    const after = getIssue(db, "SYD-1");
    expect(after.status).toBe("todo");
    expect(after.assigneeId).toBeNull();
    expect(after.needsInput).toBe(false);
  });

  it("does not divert a non-supervised (plain) human self-answer", () => {
    claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?");
    gateTodo();

    // No sessionId in the attribution: this is a plain human comment, not a
    // supervised session's self-answer, so the divert must not apply to it —
    // mirrors updateIssue's own "does not divert a plain human done-stamp".
    expect(() => addComment(db, human, "SYD-1", "Go with option B.")).not.toThrow();
    expect(getIssue(db, "SYD-1").status).toBe("todo");
  });
});
