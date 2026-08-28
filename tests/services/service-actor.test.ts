import { describe, it, expect, beforeEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { openDb, type Db } from "../../src/db/index.js";
import {
  createActor,
  rotateActorToken,
  revokeActorToken,
  type Actor,
} from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addDependency, removeDependency } from "../../src/services/dependencies.js";
import { addComment } from "../../src/services/comments.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import {
  getDeliveryWork,
  startDeliveryAttempt,
  finishDeliveryAttempt,
} from "../../src/services/delivery-attempts.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { setSetting } from "../../src/services/settings.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { snoozeIssue, markDuplicate } from "../../src/services/triage-actions.js";
import { requestHumanInput } from "../../src/services/needs-input.js";
import { getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

// SYD-213: a `service` actor is trusted worker-host infra (poller/deliver). It
// sits ABOVE agent (may post PR/delivery events) and STRICTLY BELOW human
// (cannot stamp/triage/remove-deps/mint-login/manage config). This matrix is
// the security contract: adding the type must not leak any human capability.
let db: Db, human: HumanActor, agent: Actor, service: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createHuman(db, "sean");
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  service = createActor(db, { name: "github-poller", type: "service" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  addGithubRepo(db, human, { fullName: "acme/widgets", projectKey: "AIPI" });
  createIssue(db, human, { projectKey: "AIPI", title: "Schema", priority: "high" }); // AIPI-1
  createIssue(db, human, { projectKey: "AIPI", title: "API", priority: "urgent" }); // AIPI-2
  updateIssue(db, human, "AIPI-1", { status: "todo" });
  updateIssue(db, human, "AIPI-2", { status: "todo" });
});

describe("service actor — GRANTED (event/queue infra + reads/comments)", () => {
  it("may post a delivery event (like a human infra token, unlike an agent)", () => {
    expect(() =>
      recordDeliveryEvent(db, service, "AIPI-1", {
        type: "pr_opened",
        prNumber: 7,
        url: "https://github.com/acme/widgets/pull/7",
        repo: "acme/widgets",
      }),
    ).not.toThrow();
  });

  it("may read the delivery work queue", () => {
    expect(() => getDeliveryWork(db, service)).not.toThrow();
  });

  it("may start and finish a delivery attempt (same infra gate as the queue)", () => {
    const issueId = getIssue(db, "AIPI-1").id;
    // The human todo-move in beforeEach recorded a status_changed event, which
    // authorizes a delivery attempt (delivery-attempts.ts).
    const auth = listIssueEvents(db, issueId).find((e) => e.type === "status_changed")!;
    const attempt = startDeliveryAttempt(db, service, "AIPI-1", { authorizationId: auth.id });
    expect(attempt.id).toBeGreaterThan(0);
    expect(() =>
      finishDeliveryAttempt(db, service, attempt.id, { outcome: "merged_deployed" }),
    ).not.toThrow();
  });

  it("may add a comment", () => {
    expect(() => addComment(db, service, "AIPI-1", "poller note")).not.toThrow();
  });

  it("reads are open to it (issue lookup)", () => {
    expect(getIssue(db, "AIPI-1").ref).toBe("AIPI-1");
  });
});

// Fail-closed (SYD-213 review): a service token posts events, reads, and
// comments — it has no issue create/mutate mandate. Rather than convert each
// `type === "agent"` guard in issues.ts to `!== "human"` one at a time (the
// leak class the reviewers caught — auto-label, reopen-done, reassign,
// backlog-bypass, free status machine all fell through), service is denied
// createIssue/updateIssue wholesale. These cases each exercise a capability a
// leaked service token could otherwise chain into unattended dispatch.
describe("service actor — DENIED all issue create/modify (fail-closed)", () => {
  it("cannot stamp an issue done", () => {
    expect(() => updateIssue(db, service, "AIPI-1", { status: "done" })).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });

  it("cannot move an issue out of triage", () => {
    createIssue(db, agent, {
      projectKey: "AIPI",
      title: "from agent",
      description: "landed in triage",
      provenance: { sourceType: "session", detail: "test" },
    }); // AIPI-3, lands in triage
    expect(() => updateIssue(db, service, "AIPI-3", { status: "todo" })).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });

  it("cannot apply the `auto` label (would opt an issue into unattended dispatch)", () => {
    expect(() => updateIssue(db, service, "AIPI-1", { labels: ["auto"] })).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });

  it("cannot reopen a done issue", () => {
    updateIssue(db, human, "AIPI-1", { status: "done" });
    expect(() => updateIssue(db, service, "AIPI-1", { status: "todo" })).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });

  it("cannot reassign an issue to another actor", () => {
    expect(() =>
      updateIssue(db, service, "AIPI-1", { assigneeName: "claude/worker" }),
    ).toThrowError(/cannot (create or )?modify issues/i);
  });

  it("cannot make an arbitrary status transition (no allow-list)", () => {
    expect(() => updateIssue(db, service, "AIPI-2", { status: "in_review" })).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });

  it("cannot create an issue", () => {
    expect(() => createIssue(db, service, { projectKey: "AIPI", title: "injected" })).toThrowError(
      /cannot create.*issues/i,
    );
  });

  it("cannot flag an issue needs-input (would stall auto-dispatch)", () => {
    // deliver.ts escalates via delivery_failed events, never needsInput — so a
    // service token has no legitimate use for this, and it writes board state.
    expect(() => requestHumanInput(db, service, "AIPI-1", "please advise")).toThrowError(
      /cannot (create or )?modify issues/i,
    );
  });
});

// SYD-281: the "service actor — DENIED (config / dependencies / tokens)" block
// that stood here asserted the service tier is refused by nine human-only
// services. Those gates no longer live in the service layer — the six private
// `requireHuman` helpers collapsed into `requireHumanCaller` at the adapter, so
// the services now take a `HumanActor` and cannot be handed a service actor at
// all.
//
// The assertions were not dropped; they moved to
// tests/rest/api-service-actor.test.ts, which now walks 17 human-only routes
// against BOTH the agent and service tiers — wider coverage than this block had.
// Re-asserting here would require manufacturing a `HumanActor` in a test, which
// is the state-constructing shape this story exists to remove.
