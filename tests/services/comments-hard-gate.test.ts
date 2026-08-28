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
// SYD-281: `{ sessionId }` alone is a shape production never produces —
// resolveSupervisedPrincipal always sets viaAgent AND sessionId together
// (supervised-sessions.ts). effectiveActor now fails closed on a supervised
// attribution with no resolvable agent, so these tests build the real thing.
import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, claimIssue, updateIssue } from "../../src/services/issues.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";
import { attributionOf, type Attribution } from "../../src/services/attribution.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { addComment } from "../../src/services/comments.js";
import { settings } from "../../src/db/schema.js";
import { isHardGated } from "../../src/services/hard-gate.js";

let db: Db, human: HumanActor, agent: Actor, sessionId: number, supAttr: Attribution;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "t", description: "d" });
  // An agent can only claim from "todo" (AGENT_STATUS_TRANSITIONS); a human
  // files into "backlog", so queue it first or claimIssue throws.
  updateIssue(db, human, "SYD-1", { status: "todo" });
  const _sess = openSupervisedSession(db, human, "claude-code");
  sessionId = _sess.sessionId;
  supAttr = attributionOf(resolveSupervisedPrincipal(db, _sess.sessionToken)!);
});

function gateTodo() {
  // Bypasses settings.ts's setSetting validator on purpose (it currently
  // rejects any hard_gate_actions value other than "done") to simulate the
  // scenario the issue calls out: "it starts to matter if someone gates
  // todo." Confirms the choke point holds even for a value the product
  // doesn't allow configuring yet.
  db.insert(settings)
    .values({ key: "supervised.hard_gate_actions", value: ["todo"] })
    .run();
}

describe("addComment's answer-path status write vs the hard-gate", () => {
  // SYD-281 moved this further back than SYD-241 did. The answer path is now
  // gated on a human ACTING, so a supervised session never reaches it at all —
  // there is no gated status write left to divert, because there is no status
  // write. An agent cannot answer its own escalation, which is the human-clear-
  // only rule SYD-220/225 established and a supervised principal was skipping.
  it("does not let a supervised session answer its own escalation, gated or not", () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?", leaseToken);
    gateTodo();
    expect(isHardGated(db, "todo")).toBe(true);

    // The comment itself is fine — commenting is not a human-only act.
    expect(() => addComment(db, human, "SYD-1", "Go with option B.", supAttr)).not.toThrow();

    // But the answer path did not run: the question still stands, the claim is
    // still held, and no status was written.
    const after = getIssue(db, "SYD-1");
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).not.toBeNull();
    expect(after.needsInput).toBe(true);
  });

  it("does not answer even when the target status is NOT gated (the divert is not what stops it)", () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?", leaseToken);

    expect(() => addComment(db, human, "SYD-1", "Go with option B.", supAttr)).not.toThrow();

    const after = getIssue(db, "SYD-1");
    expect(after.status).toBe("in_progress");
    expect(after.assigneeId).not.toBeNull();
    expect(after.needsInput).toBe(true);
  });

  it("does not divert a non-supervised (plain) human self-answer", () => {
    const { leaseToken } = claimIssue(db, agent, "SYD-1");
    requestHumanInput(db, agent, "SYD-1", "Which approach?", leaseToken);
    gateTodo();

    // No sessionId in the attribution: this is a plain human comment, not a
    // supervised session's self-answer, so the divert must not apply to it —
    // mirrors updateIssue's own "does not divert a plain human done-stamp".
    expect(() => addComment(db, human, "SYD-1", "Go with option B.")).not.toThrow();
    expect(getIssue(db, "SYD-1").status).toBe("todo");
  });
});
