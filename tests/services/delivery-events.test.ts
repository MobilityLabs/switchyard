import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { findPrState } from "../../src/services/pr-state.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

function setup(boundRepos: string[] = []) {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const worker = createActor(db, { name: "delivery-worker", type: "human" }).actor;
  createProject(db, worker, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });
  for (const fullName of boundRepos) addGithubRepo(db, human, { fullName, projectKey: "SYD" });
  return { db, worker };
}

describe("recordDeliveryEvent", () => {
  it("appends pr_opened, delivered, and delivery_failed events to the activity feed", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    // The delivery infra authenticates with a human-typed token (SYD-107/108).
    const worker = createActor(db, { name: "delivery-worker", type: "human" }).actor;
    createProject(db, worker, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
    });
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivered",
      prNumber: 12,
      mergeSha: "abc123",
      deploy: { ran: true, ok: true, tail: "done" },
    });

    const activity = getActivity(db, "SYD-1");
    expect(activity.map((a) => a.type)).toEqual(["created", "pr_opened", "delivered"]);
    expect(activity[1].payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      repo: null,
      headSha: null,
      ghUpdatedAt: null,
    });
    expect(activity[1].actorName).toBe("delivery-worker");
    expect(activity[2].payload).toEqual({
      prNumber: 12,
      mergeSha: "abc123",
      deploy: { ran: true, ok: true, tail: "done" },
      repo: null,
    });
  });

  it("records delivery_failed with just a message", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const worker = createActor(db, { name: "delivery-worker", type: "human" }).actor;
    createProject(db, worker, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivery_failed",
      message: "merge conflict",
    });

    const activity = getActivity(db, "SYD-1");
    expect(activity[1]).toMatchObject({
      type: "delivery_failed",
      payload: { message: "merge conflict" },
    });
  });

  it("rejects agent actors so delivery status can't be forged (SYD-108)", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    expect(() =>
      recordDeliveryEvent(db, agent, "SYD-1", {
        type: "delivered",
        prNumber: 12,
        mergeSha: "abc123",
        deploy: { ran: false },
      }),
    ).toThrowError(/delivery infrastructure/);
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("throws for an unknown issue ref", () => {
    const db = openDb(":memory:");
    const worker = createActor(db, { name: "delivery-worker", type: "human" }).actor;
    createProject(db, worker, { key: "SYD", name: "Switchyard" });
    expect(() =>
      recordDeliveryEvent(db, worker, "SYD-9", { type: "delivery_failed", message: "boom" }),
    ).toThrowError(/does not exist/);
  });
});

describe("recordDeliveryEvent / ingestion groundwork (SYD-205)", () => {
  it("records repo, headSha, and ghUpdatedAt when the worker provides them", () => {
    const { db, worker } = setup();
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      repo: "acme/widgets",
      headSha: "b".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
    expect(getActivity(db, "SYD-1")[1].payload).toEqual({
      prNumber: 12,
      url: "https://github.com/acme/widgets/pull/12",
      repo: "acme/widgets",
      headSha: "b".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
  });

  it("infers repo from the issue's project's sole bound repo when absent", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivered",
      prNumber: 12,
      mergeSha: "abc123",
      deploy: { ran: false },
    });
    expect(getActivity(db, "SYD-1")[1].payload).toMatchObject({ repo: "acme/bound" });
  });

  it("prefers an explicitly named repo over inference", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivery_failed",
      message: "boom",
      repo: "acme/explicit",
    });
    expect(getActivity(db, "SYD-1")[1].payload).toMatchObject({ repo: "acme/explicit" });
  });

  it("rejects instead of guessing when several repos are bound and none is named", () => {
    const { db, worker } = setup(["acme/one", "acme/two"]);
    expect(() =>
      recordDeliveryEvent(db, worker, "SYD-1", {
        type: "pr_opened",
        prNumber: 12,
        url: "https://x/12",
      }),
    ).toThrowError(/ambiguous/);
    expect(getActivity(db, "SYD-1").map((a) => a.type)).toEqual(["created"]);
  });

  it("pr_opened writes an attributed pr_state row at publish time (the claim gate's publish-time close, SYD-206)", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/bound/pull/12",
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
    const row = findPrState(db, "acme/bound", 12)!;
    expect(row).toMatchObject({
      status: "open",
      issueRef: "SYD-1",
      branch: "agent/SYD-1",
      headSha: "a".repeat(40),
    });
  });

  it("delivered transitions the pr_state row to merged", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/bound/pull/12",
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "delivered",
      prNumber: 12,
      mergeSha: "m".repeat(40),
      deploy: { ran: false },
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T11:00:00Z",
    });
    expect(findPrState(db, "acme/bound", 12)!.status).toBe("merged");
  });

  it("normalizes an explicitly named repo to lowercase so it converges with the bound repo's casing (SYD-212)", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/bound/pull/12",
      repo: "Acme/Bound",
    });
    expect(getActivity(db, "SYD-1")[1].payload).toMatchObject({ repo: "acme/bound" });
    expect(findPrState(db, "acme/bound", 12)!.issueRef).toBe("SYD-1");
  });

  it("never writes pr_state when the event's repo is not bound to the issue's project", () => {
    const { db, worker } = setup(["acme/bound"]);
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://github.com/acme/unrelated/pull/12",
      repo: "acme/unrelated",
    });
    expect(findPrState(db, "acme/unrelated", 12)).toBeUndefined();
  });

  it("skips pr_state entirely when no repo is known (nothing to key the row on)", () => {
    const { db, worker } = setup();
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://x/12",
    });
    expect(getActivity(db, "SYD-1").filter((a) => a.type === "pr_opened")).toHaveLength(1);
  });

  it("parses a malformed ghUpdatedAt fail-closed to null instead of rejecting the event", () => {
    const { db, worker } = setup();
    recordDeliveryEvent(db, worker, "SYD-1", {
      type: "pr_opened",
      prNumber: 12,
      url: "https://x/12",
      ghUpdatedAt: "not-a-timestamp",
    });
    expect(getActivity(db, "SYD-1")[1].payload).toMatchObject({ ghUpdatedAt: null });
  });
});
