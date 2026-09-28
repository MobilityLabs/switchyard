import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { githubRepos } from "../../src/db/schema.js";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, claimIssue, updateIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";
import { declarePrLink, listLiveLinkViews, revokePrLink } from "../../src/services/pr-links.js";
import { getMergedPr, getOpenPr } from "../../src/services/pr-status.js";
import { findPrState } from "../../src/services/pr-state.js";
import { buildGithubWebhookRoutes } from "../../src/rest/github-routes.js";
import { buildApiRoutes } from "../../src/rest/api-routes.js";

const repo = "acme/widgets";
const head = "a".repeat(40);
function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "reviewer", type: "human" }).actor;
  const agent = createActor(db, { name: "worker", type: "agent" }).actor;
  const service = createActor(db, { name: "host", type: "service" });
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  const issue = createIssue(db, human, { projectKey: "SYD", title: "Real work" });
  updateIssue(db, human, issue.ref, { status: "todo" });
  addGithubRepo(db, human, { fullName: repo, projectKey: "SYD" });
  return { db, human, agent, service, issue };
}
function payload(action = "opened", timestamp = "2030-01-01T00:00:00Z") {
  return {
    action,
    repository: { full_name: repo },
    pull_request: {
      number: 7,
      title: "Unrelated change",
      head: { ref: "agent/SYD-1", sha: head, repo: { full_name: "attacker/fork" } },
      updated_at: timestamp,
      merged: action === "closed",
      merge_commit_sha: action === "closed" ? "b".repeat(40) : null,
      html_url: `https://github.com/${repo}/pull/7`,
    },
  };
}
const published = {
  type: "pr_opened" as const,
  repo,
  prNumber: 7,
  headSha: head,
  ghUpdatedAt: "2030-01-01T00:00:00Z",
  url: `https://github.com/${repo}/pull/7`,
};

describe("GitHub observations cannot assert delivery attribution", () => {
  it.each(["webhook", "poller"])(
    "observes a fork through %s without trusting its branch",
    async (channel) => {
      const { db, issue, agent, service } = setup();
      for (const action of ["opened", "closed"]) {
        const body = payload(action);
        let response: Response;
        if (channel === "webhook") {
          const raw = JSON.stringify(body);
          response = await buildGithubWebhookRoutes(db, "test-secret").request("/webhooks/github", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-hub-signature-256":
                "sha256=" + createHmac("sha256", "test-secret").update(raw).digest("hex"),
            },
            body: raw,
          });
        } else {
          // The current poller does not include head.repo at all. Its credential
          // authenticates the observation, not the PR author's issue declaration.
          const pollerHead = { ref: body.pull_request.head.ref, sha: body.pull_request.head.sha };
          response = await buildApiRoutes(db).request("/github-events", {
            method: "POST",
            headers: {
              authorization: `Bearer ${service.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              event: "pull_request",
              repo,
              payload: { ...body, pull_request: { ...body.pull_request, head: pollerHead } },
            }),
          });
        }
        expect(response.status).toBe(200);
        expect(findPrState(db, repo, 7)?.status).toBe(action === "opened" ? "open" : "merged");
        expect(findPrState(db, repo, 7)?.issueRef).toBeNull();
        expect(getOpenPr(db, issue.id)).toBeNull();
        expect(getMergedPr(db, issue.id)).toBeNull();
        expect(
          listLiveLinkViews(db, issue.id).every(
            (link) => link.role === "references" && !link.provesLanded,
          ),
        ).toBe(true);
      }
      expect(claimIssue(db, agent, issue.ref).issue.assigneeId).toBe(agent.id);
    },
  );

  it.each([true, false])(
    "publishes against a legacy mixed-case repository binding (explicit repo: %s)",
    (explicit) => {
      const { db, service, issue } = setup();
      // Legacy rows predate normalized writes; both binding and observation
      // identity must still converge without requiring an operator migration.
      db.update(githubRepos).set({ fullName: "Acme/Widgets" }).run();
      recordDeliveryEvent(db, service.actor, issue.ref, {
        ...published,
        repo: explicit ? repo : undefined,
      });
      expect(getOpenPr(db, issue.id)?.repo).toBe(repo);
      expect(listLiveLinkViews(db, issue.id)[0].role).toBe("delivers");
    },
  );

  it("preserves authenticated host publication, including a webhook that arrived first", () => {
    const { db, issue, agent, service } = setup();
    handleGithubWebhook(db, "pull_request", payload());
    recordDeliveryEvent(db, service.actor, issue.ref, published);
    expect(getOpenPr(db, issue.id)?.prNumber).toBe(7);
    expect(() => claimIssue(db, agent, issue.ref)).toThrow(/open PR/);
    handleGithubWebhook(db, "pull_request", payload("closed", "2030-01-01T00:01:00Z"));
    expect(getMergedPr(db, issue.id)?.prNumber).toBe(7);
    expect(listLiveLinkViews(db, issue.id)[0].provesLanded).toBe(true);
  });
});

describe("revocation survives observations and host publication retries", () => {
  it.each(["delivers", "references"] as const)(
    "preserves a revoked %s link until an explicit re-declaration",
    (role) => {
      const { db, human, issue, service } = setup();
      if (role === "delivers") recordDeliveryEvent(db, service.actor, issue.ref, published);
      else handleGithubWebhook(db, "pull_request", payload());
      revokePrLink(db, human, issue.ref, { repo, prNumber: 7, reason: "Unrelated work" });
      for (const observation of [
        payload(),
        payload("synchronize", "2030-01-01T00:01:00Z"),
        payload("closed", "2030-01-01T00:02:00Z"),
      ]) {
        handleGithubWebhook(db, "pull_request", observation);
        expect(listLiveLinkViews(db, issue.id)).toEqual([]);
        expect(getOpenPr(db, issue.id)).toBeNull();
        expect(getMergedPr(db, issue.id)).toBeNull();
      }
      recordDeliveryEvent(db, service.actor, issue.ref, published);
      recordDeliveryEvent(db, service.actor, issue.ref, {
        type: "delivered",
        repo,
        prNumber: 7,
        mergeSha: "b".repeat(40),
        deploy: { ran: false },
      });
      expect(listLiveLinkViews(db, issue.id)).toEqual([]);
      declarePrLink(db, human, issue.ref, { repo, prNumber: 7 });
      expect(getMergedPr(db, issue.id)?.prNumber).toBe(7);
      expect(listLiveLinkViews(db, issue.id)[0].provesLanded).toBe(true);
    },
  );
});
