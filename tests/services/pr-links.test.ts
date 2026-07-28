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
import { prState } from "../../src/db/schema.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, claimIssue, updateIssue, getIssue } from "../../src/services/issues.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { listIssueEvents } from "../../src/services/events.js";
import { handleGithubWebhook } from "../../src/services/github-webhook.js";
import { getMergedPr, getOpenPr } from "../../src/services/pr-status.js";
import {
  declarePrLink,
  confirmPrLink,
  revokePrLink,
  listLiveLinks,
  recordIngestedPrLink,
  backfillPrLinksFromPrState,
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

  // Found live: Sean confirmed the ingested #194 link on SYD-243 to clear its
  // done_without_merged_pr flag. The call succeeded, recorded a
  // pr_link_confirmed event -- and changed nothing, because every reader of
  // proof joins on role='delivers'. A confirmed `references` row satisfies no
  // one. Silent success on a no-op is worse than a refusal.
  //
  // Refusing rather than promoting is deliberate. `references` links are
  // minted from PR prose -- since SYD-274, on EVERY ref a PR names -- so
  // letting one confirm click turn a passing mention into delivery-grade
  // evidence would reopen SYD-280's hole from the other side. declare is the
  // assertion of what a PR carries; confirm vouches for an assertion someone
  // already made. There is no assertion here to vouch for.
  it("refuses to confirm a references suggestion, and says what to do instead", () => {
    const { db, human, agent } = setup();
    recordIngestedPrLink(db, {
      issueId: getIssue(db, "SYD-1").id,
      repo: REPO,
      prNumber: 7,
      role: "references",
      actorId: agent.id,
    });
    expect(() => confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(
      /references/i,
    );
    expect(() => confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow(
      /declare/i,
    );
  });

  it("leaves the suggestion untouched when it refuses — no half-applied confirm", () => {
    const { db, human, agent } = setup();
    recordIngestedPrLink(db, {
      issueId: getIssue(db, "SYD-1").id,
      repo: REPO,
      prNumber: 7,
      role: "references",
      actorId: agent.id,
    });
    expect(() => confirmPrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 })).toThrow();
    const [link] = listLiveLinks(db, getIssue(db, "SYD-1").id);
    expect(link.role).toBe("references");
    expect(link.confirmedBy).toBeNull();
  });

  // The one-step path the refusal points at: declaring supersedes the
  // suggestion AND confirms, so a human never needs both verbs.
  it("declaring delivers over the suggestion promotes and confirms in one step", () => {
    const { db, human, agent } = setup();
    recordIngestedPrLink(db, {
      issueId: getIssue(db, "SYD-1").id,
      repo: REPO,
      prNumber: 7,
      role: "references",
      actorId: agent.id,
    });
    const promoted = declarePrLink(db, human, "SYD-1", { repo: REPO, prNumber: 7 });
    expect(promoted.role).toBe("delivers");
    expect(promoted.confirmedBy).toBe(human.id);
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

describe("backfillPrLinksFromPrState — the cutover", () => {
  /** A pre-migration pr_state row: attributed, but with no link, which is what
   * every existing row looks like the moment before the backfill runs. */
  function legacyAttributedRow(db: ReturnType<typeof openDb>, prNumber: number, updatedAt: number) {
    db.insert(prState)
      .values({
        repo: REPO,
        prNumber,
        branch: "agent/SYD-1",
        issueRef: "SYD-1",
        status: "merged",
        headSha: "a".repeat(40),
        ghUpdatedAt: 1_700_000_000,
        url: `https://github.com/${REPO}/pull/${prNumber}`,
        updatedAt,
      })
      .run();
  }

  it("creates one confirmed delivers link per attributed row", () => {
    const { db, human } = setup();
    legacyAttributedRow(db, 7, 1_700_000_500);
    expect(backfillPrLinksFromPrState(db, human)).toEqual({
      created: 1,
      alreadyLinked: 0,
      skipped: 0,
    });
    const [link] = listLiveLinks(db, 1);
    expect(link.role).toBe("delivers");
    // Confirmed by the HUMAN operator, not the github actor — otherwise §5a
    // recency would retroactively fail historical merges.
    expect(link.confirmedBy).toBe(human.id);
    // declared_at from the row's own updated_at, never wall-clock.
    expect(link.declaredAt).toBe(1_700_000_500);
  });

  it("keeps historical merges proof-bearing (the regression the migration must not cause)", () => {
    const { db, human } = setup();
    // gh_updated_at (1_700_000_000) is BEFORE declared_at (1_700_000_500), so
    // this row only stays proof-bearing because a human confirmed it.
    legacyAttributedRow(db, 7, 1_700_000_500);
    backfillPrLinksFromPrState(db, human);
    expect(getMergedPr(db, 1)).not.toBeNull();
  });

  it("is idempotent — a second run creates nothing", () => {
    const { db, human } = setup();
    legacyAttributedRow(db, 7, 1_700_000_500);
    backfillPrLinksFromPrState(db, human);
    expect(backfillPrLinksFromPrState(db, human)).toEqual({
      created: 0,
      alreadyLinked: 1,
      skipped: 0,
    });
  });

  it("--dry-run counts without writing", () => {
    const { db, human } = setup();
    legacyAttributedRow(db, 7, 1_700_000_500);
    expect(backfillPrLinksFromPrState(db, human, { dryRun: true }).created).toBe(1);
    expect(listLiveLinks(db, 1)).toHaveLength(0);
  });

  // Correcting an overstatement in the design doc (§10) and in the SYD-280
  // notes: the backfill was described as making interactive issues visible to
  // getOpenPr, so an open feat/ PR would start refusing new claims. It does
  // not. A display-only PR never touches pr_state at all
  // (github-webhook.ts:221), so the backfill — which reads pr_state — creates
  // nothing for it, and free-text ingestion yields a references link, which
  // LIVE_DELIVERS excludes. Interactive work starts gating only when someone
  // DECLARES, which is opt-in per PR. Pinned here so the claim is checkable
  // rather than asserted.
  it("does not make an undeclared interactive feat/ PR gate claims", () => {
    const { db, human } = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: REPO },
      pull_request: {
        number: 99,
        html_url: `https://github.com/${REPO}/pull/99`,
        head: { ref: "feat/some-topic", sha: "a".repeat(40) },
        title: "SYD-1: interactive work",
        updated_at: "2026-07-12T11:00:00Z",
      },
    });
    expect(backfillPrLinksFromPrState(db, human).created).toBe(0);
    expect(listLiveLinks(db, 1).map((l) => l.role)).toEqual(["references"]);
    expect(getOpenPr(db, 1)).toBeNull();
  });

  it("refuses to run as anything but a human — it asserts trust over existing data", () => {
    const { db, infra } = setup();
    legacyAttributedRow(db, 7, 1_700_000_500);
    expect(() => backfillPrLinksFromPrState(db, infra)).toThrow(/human/i);
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

  // The other half: a PR body is writable by anyone on a public repo, so the
  // free-text ingestion path must never mint a link that gates or proves.
  it("a PR body naming an issue creates only a references link, never delivers", () => {
    const { db } = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: REPO },
      pull_request: {
        number: 3,
        html_url: `https://github.com/${REPO}/pull/3`,
        // Not agent/<ref> — so this is the free-text path, the one a fork PR
        // author controls entirely.
        head: { ref: "attacker/whatever" },
        title: "SYD-1: I hereby claim this issue",
        body: null,
      },
    });
    const links = listLiveLinks(db, 1);
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("references");
    expect(links[0].confirmedBy).toBeNull();
  });

  it("the agent/<ref> branch path still declares delivers — parity with today", () => {
    const { db } = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: REPO },
      pull_request: {
        number: 12,
        html_url: `https://github.com/${REPO}/pull/12`,
        head: { ref: "agent/SYD-1", sha: "a".repeat(40) },
        title: "whatever",
        body: null,
        updated_at: "2026-07-12T11:00:00Z",
      },
    });
    const links = listLiveLinks(db, 1);
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe("delivers");
    // Confirmed, matching the authority pr_state.issue_ref carries today — but
    // by a non-human, so §5a recency binding still applies at the read sites.
    expect(links[0].confirmedBy).not.toBeNull();
  });

  it("ingestion records no timeline event — the link row is the audit", () => {
    const { db } = setup();
    handleGithubWebhook(db, "pull_request", {
      action: "opened",
      repository: { full_name: REPO },
      pull_request: {
        number: 12,
        html_url: `https://github.com/${REPO}/pull/12`,
        head: { ref: "agent/SYD-1", sha: "a".repeat(40) },
        updated_at: "2026-07-12T11:00:00Z",
      },
    });
    const kinds = listIssueEvents(db, 1).map((e) => e.type);
    expect(kinds).not.toContain("pr_link_declared");
    expect(kinds).toContain("gh_pr_opened");
  });
});
