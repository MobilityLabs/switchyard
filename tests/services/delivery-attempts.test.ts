import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { recordEvent } from "../../src/services/events.js";
import { deliveryAttempts, DELIVERY_OUTCOMES } from "../../src/db/schema.js";

describe("delivery_attempts schema", () => {
  it("stores and reads an attempt row with the full outcome enum available", () => {
    const db = openDb(":memory:");
    const human = createActor(db, { name: "sean", type: "human" }).actor;
    createProject(db, human, { key: "SYD", name: "Switchyard" });
    createIssue(db, human, { projectKey: "SYD", title: "Ship v1" });

    // Create an event to reference as authorizationId
    recordEvent(db, {
      issueId: 1,
      actorId: human.id,
      type: "done",
      payload: { reason: "test authorization" },
    });

    expect(DELIVERY_OUTCOMES).toEqual([
      "merged_deployed",
      "merged_deploy_failed",
      "verify_failed",
      "conflict_bounced",
      "merge_failed",
      "checks_timeout",
      "sha_chain_disarmed",
      "skipped_rollout",
    ]);

    db.insert(deliveryAttempts)
      .values({ issueRef: "SYD-1", prNumber: 7, headSha: "abc", authorizationId: 1 })
      .run();

    const row = db.select().from(deliveryAttempts).all()[0];
    expect(row.outcome).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.startedAt).toBeGreaterThan(0);
  });
});
