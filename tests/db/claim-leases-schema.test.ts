import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";
import { claimLeases, actors, projects, issues } from "../../src/db/schema.js";

describe("claim_leases schema", () => {
  it("stores a lease row keyed by a unique token hash", () => {
    const db = openDb(":memory:");
    const actor = db
      .insert(actors)
      .values({ name: "claude/worker", type: "agent" })
      .returning()
      .get();
    const project = db.insert(projects).values({ key: "AIPI", name: "aipi" }).returning().get();
    const issue = db
      .insert(issues)
      .values({
        projectId: project.id,
        number: 1,
        title: "t",
        status: "in_progress",
        creatorId: actor.id,
      })
      .returning()
      .get();

    const now = Math.floor(Date.now() / 1000);
    const lease = db
      .insert(claimLeases)
      .values({
        issueId: issue.id,
        actorId: actor.id,
        tokenHash: "abc",
        expiresAt: now + 3600,
        lastBeatAt: now,
      })
      .returning()
      .get();

    expect(lease.invalidatedAt).toBeNull();
    expect(db.select().from(claimLeases).where(eq(claimLeases.id, lease.id)).get()?.tokenHash).toBe(
      "abc",
    );
    // token_hash is unique
    expect(() =>
      db
        .insert(claimLeases)
        .values({
          issueId: issue.id,
          actorId: actor.id,
          tokenHash: "abc",
          expiresAt: now,
          lastBeatAt: now,
        })
        .run(),
    ).toThrow();
  });
});
