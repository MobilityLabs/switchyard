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
import { getDeliveryWork } from "../../src/services/delivery-attempts.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { setSetting } from "../../src/services/settings.js";
import { addWebhook } from "../../src/services/webhooks.js";
import { snoozeIssue, markDuplicate } from "../../src/services/triage-actions.js";
import { getIssue } from "../../src/services/issues.js";

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

  it("may add a comment", () => {
    expect(() => addComment(db, service, "AIPI-1", "poller note")).not.toThrow();
  });

  it("reads are open to it (issue lookup)", () => {
    expect(getIssue(db, "AIPI-1").ref).toBe("AIPI-1");
  });
});

describe("service actor — DENIED (every human-only capability)", () => {
  it("cannot stamp an issue done", () => {
    expect(() => updateIssue(db, service, "AIPI-1", { status: "done" })).toThrowError(
      /only humans/i,
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
      /triage/i,
    );
  });

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
