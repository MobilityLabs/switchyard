// Declared issue<->PR attribution (SYD-280, spec: docs/superpowers/specs/
// 2026-07-27-declared-pr-attribution-design.md).
//
// The two properties every test here is defending, because the previous
// attempt at this design died on both:
//   1. Declaring is authenticated. A party with no Switchyard credential can
//      never create a link, so a fork PR can't block claims on an issue it
//      names (the unremediable-DoS finding).
//   2. Declaring is not confirming. An agent can over-block (safe, revocable)
//      but can never make its own link prove that its work landed.
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, claimIssue, updateIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { listIssueEvents } from "../../src/services/events.js";
import {
  declarePrLink,
  confirmPrLink,
  revokePrLink,
  listLiveLinks,
} from "../../src/services/pr-links.js";

const REPO = "acme/widgets";
const OTHER_REPO = "acme/unrelated";

function setup() {
  const db = openDb(":memory:");
  const human = createActor(db, { name: "sean", type: "human" }).actor;
  const agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  const other = createActor(db, { name: "claude/other", type: "agent" }).actor;
  const infra = createActor(db, { name: "deliver", type: "service" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Ship it" });
  // A human-created issue lands in `backlog`, and the only status an agent may
  // claim from is `todo` (AGENT_STATUS_TRANSITIONS) — so accept it first, the
  // same way triage does.
  updateIssue(db, human, "SYD-1", { status: "todo" });
  addGithubRepo(db, human, { fullName: REPO, projectKey: "SYD" });
  return { db, human, agent, other, infra };
}

/** Claims SYD-1 for `actor` and returns the minted lease token. */
function claim(db: ReturnType<typeof openDb>, actor: { id: number; name: string; type: string }) {
  const result = claimIssue(db, actor as never, "SYD-1");
  return result.leaseToken as string;
}

describe("declarePrLink — who may declare", () => {
  it("lets an agent holding the claim declare, presenting its lease", () => {
    const { db, agent } = setup();
    const lease = claim(db, agent);
    const link = declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    expect(link.role).toBe("delivers");
    expect(link.prNumber).toBe(7);
  });

  it("refuses an agent that presents no lease", () => {
    const { db, agent } = setup();
    claim(db, agent);
    expect(() => declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(/lease/i);
  });

  it("refuses an agent that does not hold the claim", () => {
    const { db, agent, other } = setup();
    const lease = claim(db, agent);
    // The other agent presents someone else's lease token — the shared-token
    // case SYD-210 exists for.
    expect(() => declarePrLink(db, other, "SYD-1", { repo: REPO, prNumber: 7 }, lease)).toThrow();
  });

  it("lets a human declare without any lease", () => {
    const { db, human } = setup();
    const link = declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(link.prNumber).toBe(7);
  });

  it("lets trusted infra (service) declare — the auto path", () => {
    const { db, infra } = setup();
    const link = declarePrLink(db, infra, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(link.prNumber).toBe(7);
  });

  it("refuses a repo not bound to the issue's project", () => {
    const { db, human } = setup();
    expect(() => declarePrLink(db, human, "SYD-1", { repo: OTHER_REPO, prNumber: 7 })).toThrow(
      /bound/i,
    );
  });

  it("normalizes repo casing so uniqueness cannot be defeated by case", () => {
    const { db, human } = setup();
    declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(() => declarePrLink(db, human, "SYD-1", { repo: "ACME/Widgets", prNumber: 7 })).toThrow(
      /already/i,
    );
  });
});

describe("declarePrLink — confirmation at declaration", () => {
  it("auto-confirms a human declaration", () => {
    const { db, human } = setup();
    const link = declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(link.confirmedBy).toBe(human.id);
  });

  it("auto-confirms a service declaration", () => {
    const { db, infra } = setup();
    const link = declarePrLink(db, infra, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(link.confirmedBy).toBe(infra.id);
  });

  it("leaves an agent declaration UNCONFIRMED — it can never prove its own work landed", () => {
    const { db, agent } = setup();
    const lease = claim(db, agent);
    const link = declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    expect(link.confirmedBy).toBeNull();
  });

  it("forces an agent's role to delivers — agents cannot mint references links", () => {
    const { db, agent } = setup();
    const lease = claim(db, agent);
    const link = declarePrLink(
      db,
      agent,
      "SYD-1",
      { repo: REPO, prNumber: 7, role: "references" },
      lease,
    );
    expect(link.role).toBe("delivers");
  });
});

describe("confirmPrLink", () => {
  it("lets a human confirm an agent's link", () => {
    const { db, human, agent } = setup();
    const lease = claim(db, agent);
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    const link = confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(link.confirmedBy).toBe(human.id);
  });

  it("refuses an agent confirming anything, including its own link", () => {
    const { db, agent } = setup();
    const lease = claim(db, agent);
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    expect(() => confirmPrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(
      /confirm/i,
    );
  });

  it("refuses to confirm a link that does not exist", () => {
    const { db, human } = setup();
    expect(() => confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(
      /no live/i,
    );
  });
});

describe("revokePrLink", () => {
  it("lets the declarer revoke their own unconfirmed link", () => {
    const { db, agent } = setup();
    const lease = claim(db, agent);
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    revokePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7, reason: "wrong PR" }, lease);
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  it("refuses an agent revoking a CONFIRMED link", () => {
    const { db, human, agent } = setup();
    const lease = claim(db, agent);
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(() =>
      revokePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7, reason: "nope" }, lease),
    ).toThrow(/human/i);
  });

  it("lets a human revoke any link, confirmed or not", () => {
    const { db, human, agent } = setup();
    const lease = claim(db, agent);
    declarePrLink(db, agent, "SYD-1", { repo: REPO, prNumber: 7 }, lease);
    confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    revokePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7, reason: "mis-linked" });
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  it("requires a reason", () => {
    const { db, human } = setup();
    declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(() =>
      revokePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7, reason: "  " }),
    ).toThrow(/reason/i);
  });

  it("is soft — the same PR can be re-declared after a revoke, and history survives", () => {
    const { db, human } = setup();
    declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    revokePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7, reason: "mis-linked" });
    const again = declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(again.revokedAt).toBeNull();
    expect(listLiveLinks(db, 1)).toHaveLength(1);
    // Both declarations are on the record.
    const kinds = listIssueEvents(db, 1).map((e) => e.type);
    expect(kinds.filter((k) => k === "pr_link_declared")).toHaveLength(2);
    expect(kinds.filter((k) => k === "pr_link_revoked")).toHaveLength(1);
  });
});

describe("the DoS the previous design died on", () => {
  // The previous design's declaration channel was a PR-body trailer on a
  // public repo, so anyone could open a fork PR that permanently blocked
  // claims on any issue it named. The property that kills that class here is
  // "no Switchyard credential, no link" — and the half of it that is testable
  // at this layer is that holding a token is not enough: an agent must also
  // hold the issue.
  it("an agent with a valid token but no claim on the issue cannot block it", () => {
    const { db, other } = setup();
    expect(() => declarePrLink(db, other, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(
      /not yours/i,
    );
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  // The other half — that an unauthenticated PR body cannot reach this module
  // at all — is a property of the ingestion path, not of this service. It is
  // asserted where it is actually enforceable, once free-text ingestion is
  // demoted to `references` links (design §8).
  it.todo("a fork PR body naming an issue creates no delivers link (webhook ingestion)");
});
