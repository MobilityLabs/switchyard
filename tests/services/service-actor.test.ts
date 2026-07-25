import { describe, it, expect, beforeEach } from "vitest";
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
let db: Db, human: Actor, agent: Actor, service: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
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

describe("service actor — DENIED (config / dependencies / tokens)", () => {
  it("cannot remove a dependency", () => {
    addDependency(db, human, "AIPI-1", "AIPI-2");
    expect(() => removeDependency(db, service, "AIPI-1", "AIPI-2")).toThrowError(/only humans/i);
  });

  it("cannot link a GitHub repo", () => {
    expect(() =>
      addGithubRepo(db, service, { fullName: "acme/other", projectKey: "AIPI" }),
    ).toThrowError(/only humans/i);
  });

  it("cannot change a setting", () => {
    expect(() => setSetting(db, service, "intervalSeconds", 999)).toThrowError(/human/i);
  });

  it("cannot add a webhook", () => {
    expect(() =>
      addWebhook(db, service, { url: "https://example.com/hook", projectKey: "AIPI" }),
    ).toThrowError(/human/i);
  });

  it("cannot rotate an actor's token", () => {
    expect(() => rotateActorToken(db, service, agent.id)).toThrowError(/only humans/i);
  });

  it("cannot revoke an actor's token", () => {
    expect(() => revokeActorToken(db, service, agent.id)).toThrowError(/only humans/i);
  });

  it("cannot create a project", () => {
    expect(() => createProject(db, service, { key: "NEW", name: "new" })).toThrowError(
      /only humans/i,
    );
  });

  it("cannot snooze an issue", () => {
    expect(() => snoozeIssue(db, service, "AIPI-1", 9999999999)).toThrowError(/only humans/i);
  });

  it("cannot mark an issue a duplicate", () => {
    expect(() => markDuplicate(db, service, "AIPI-1", "AIPI-2")).toThrowError(/only humans/i);
  });
});
