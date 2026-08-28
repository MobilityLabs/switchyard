import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHuman } from "../helpers/human.js";
import type { HumanActor } from "../../src/services/principal.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type IssueView } from "../../src/services/issues.js";
import { addDependency, listDependencies } from "../../src/services/dependencies.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { listLiveLinkViews } from "../../src/services/pr-links.js";
import { setSetting } from "../../src/services/settings.js";
import {
  openSupervisedSession,
  resolveSupervisedPrincipal,
} from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import type { Principal } from "../../src/services/principal.js";
import { buildMcpServer } from "../../src/mcp/server.js";

let db: Db, human: HumanActor, agent: Actor, dir: string, prin: Principal, issue: IssueView;

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

function latestEvent(issueId: number, type: string) {
  const [row] = db.all<{
    actor_id: number;
    via_agent_id: number | null;
    session_id: number | null;
  }>(
    sql`SELECT actor_id, via_agent_id, session_id FROM events WHERE issue_id = ${issueId} AND type = ${type} ORDER BY id DESC LIMIT 1`,
  );
  return row;
}

/** Connects a client to the MCP server as the supervised principal — exactly
 * how /mcp bakes a resolved supervised session into the tool closure. */
async function connectSupervised(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // SYD-281: no viaAgent argument — the acting agent is derived from the
  // attribution's viaAgentId by effectiveActor, so there is one source of truth.
  await buildMcpServer(db, prin.actor, dir, undefined, attributionOf(prin)).connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "syd-supervised-"));
  human = createHuman(db, "sean");
  // SYD-281: the session's agent is minted namespaced by openSupervisedSession,
  // so take it from the resolved principal rather than pre-creating one.
  createProject(db, human, { key: "SUP", name: "supervised" });
  const { sessionToken } = openSupervisedSession(db, human, "claude-code");
  prin = resolveSupervisedPrincipal(db, sessionToken)!;
  agent = prin.viaAgent!;
  issue = createIssue(db, human, { projectKey: "SUP", title: "Wire the surface" });
  updateIssue(db, human, issue.ref, { status: "todo" });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MCP write tools in a supervised session", () => {
  it("(a) update_issue -> in_review writes a dual-attributed status_changed event", async () => {
    const client = await connectSupervised();
    // SYD-281: a supervised session is now on the agent path, so it obeys
    // AGENT_STATUS_TRANSITIONS like any other agent — todo -> in_review is not a
    // legal jump, and in_review is assigneeOnly. Before this change a supervised
    // principal was typed human and skipped the allow-list entirely, which is
    // one of the bypasses this story closes. Claim, then move.
    const claimed = await client.callTool({
      name: "claim_issue",
      arguments: { ref: issue.ref },
    });
    expect(claimed.isError).toBeFalsy();
    const r = await client.callTool({
      name: "update_issue",
      arguments: {
        ref: issue.ref,
        status: "in_review",
        lease_token: JSON.parse(text(claimed)).lease_token,
      },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).status).toBe("in_review");

    const ev = latestEvent(issue.id, "status_changed");
    // The human is accountable; the agent is recorded as the editor.
    expect(ev.actor_id).toBe(human.id);
    expect(ev.via_agent_id).toBe(agent.id);
    expect(ev.session_id).toBe(prin.sessionId);
  });

  it("(b) update_issue -> done is diverted to a pending action, over the real MCP transport", async () => {
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done" },
    });

    // Task 4: parked is a SUCCESS, not an error — guard() translates the
    // PendingAffirmation signal into an ok() result carrying the canonical doc.
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).pendingActionId).toBeGreaterThan(0);

    const rows = db.all<{ id: number; session_id: number; issue_id: number; action_type: string }>(
      sql`SELECT id, session_id, issue_id, action_type FROM pending_actions WHERE status = 'pending'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(prin.sessionId);
    expect(rows[0].issue_id).toBe(issue.id);
    expect(rows[0].action_type).toBe("done");

    // Nothing was changed — the whole point of parking it.
    const [row] = db.all<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue.id}`);
    expect(row.status).toBe("todo");
  });

  it("(c) progress_note succeeds (acting as the via-agent) and carries the session id", async () => {
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "progress_note",
      arguments: { ref: issue.ref, note: "wiring the MCP surface" },
    });
    expect(r.isError).toBeFalsy();

    const ev = latestEvent(issue.id, "progress_note");
    // recordProgressNote requires an agent actor, so the supervised session acts
    // as its via-agent here rather than as the human root.
    expect(ev.actor_id).toBe(agent.id);
    expect(ev.session_id).toBe(prin.sessionId);
  });

  it("does not expose a supervised-session minting tool (the token must stay out of the transcript)", async () => {
    const client = await connectSupervised();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("open_supervised_session");
  });

  it("never accepts client-supplied attribution — session_id/via_agent are server-derived", async () => {
    const client = await connectSupervised();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema?.properties ?? {});
      expect(props).not.toContain("session_id");
      expect(props).not.toContain("via_agent");
      expect(props).not.toContain("via_agent_id");
    }
  });

  it("remove_dependency via plain agent is refused; supervised parks when gated, and is REFUSED when not", async () => {
    // 1. Setup blocker issue and dependency
    const blocker = createIssue(db, human, { projectKey: "SUP", title: "The blocker" });
    addDependency(db, human, blocker.ref, issue.ref);

    // 2. Plain agent via MCP is refused directly
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(db, agent, dir).connect(st);
    const plainAgentClient = new Client({ name: "test", version: "0.0.0" });
    await plainAgentClient.connect(ct);

    const rPlain = await plainAgentClient.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rPlain.isError).toBe(true);
    expect(text(rPlain)).toMatch(/only a human acting in person removes dependencies/i);

    // 3. Supervised session with hard-gate action configured parks a pending action
    setSetting(db, human, "supervised.hard_gate_actions", ["dependency.remove"]);
    const client = await connectSupervised();
    const rGated = await client.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rGated.isError).toBeUndefined();
    const parsedGated = JSON.parse(text(rGated));
    expect(parsedGated.pendingActionId).toBeGreaterThan(0);

    const rows = db.all<{ id: number; session_id: number; issue_id: number; action_type: string }>(
      sql`SELECT id, session_id, issue_id, action_type FROM pending_actions WHERE status = 'pending'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe(`dependency.remove:${blocker.ref}`);

    // Edge still exists (nothing was changed)
    expect(listDependencies(db, issue.ref).blockedBy.map((d) => d.ref)).toEqual([blocker.ref]);

    // 4. SYD-281: with full absorption the removal is now REFUSED, not executed.
    // "Dependency removal is human-only" (CLAUDE.md) used to be satisfied by a
    // supervised principal because it is typed human. This is the fails-closed
    // property: without the operator settings write the capability is lost, not
    // the guard.
    setSetting(db, human, "supervised.hard_gate_actions", []);
    const rAbsorb = await client.callTool({
      name: "remove_dependency",
      arguments: { blocker_ref: blocker.ref, blocked_ref: issue.ref },
    });
    expect(rAbsorb.isError).toBe(true);
    expect(text(rAbsorb)).toMatch(/human/i);

    // Edge survives.
    expect(listDependencies(db, issue.ref).blockedBy.map((d) => d.ref)).toEqual([blocker.ref]);
  });
});

// SYD-281's headline finding. `declarePrLink` wrote
// `confirmedBy: isAgent ? null : actor.id`, and a supervised principal resolves
// to the bound HUMAN — so an agent's declaration was auto-confirmed and stamped
// with the human's actor id. It did not evade the attestation; it manufactured
// one, and `provesLanded` accepted it.
//
// Driven through the MCP tool with a real sup_ token rather than by calling
// declarePrLink directly: SYD-280 shipped inert because its tests called
// upsertPrState directly while production never did.
describe("declare_pr_link in a supervised session (SYD-281)", () => {
  const REPO = "acme/widgets";

  beforeEach(() => {
    addGithubRepo(db, human, { fullName: REPO, projectKey: "SUP" });
  });

  /** Claims the issue for the supervised session and returns its lease token. */
  async function claimIt(client: Client): Promise<string> {
    const r = await client.callTool({ name: "claim_issue", arguments: { ref: issue.ref } });
    if (r.isError) throw new Error("claim_issue failed: " + text(r));
    return JSON.parse(text(r)).lease_token as string;
  }

  it("declares UNCONFIRMED — a supervised agent proposes, it does not vouch", async () => {
    const client = await connectSupervised();
    const lease = await claimIt(client);
    const r = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: issue.ref, repo: REPO, pr_number: 7, lease_token: lease },
    });
    expect(r.isError).toBeFalsy();

    const [link] = listLiveLinkViews(db, issue.id);
    expect(link.confirmedByName).toBeNull();
    expect(link.confirmedByHuman).toBe(false);
    expect(link.provesLanded).toBe(false);
  });

  it("records the AGENT as declarer, so revoke's ownership test is the agent's", async () => {
    const client = await connectSupervised();
    const lease = await claimIt(client);
    await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: issue.ref, repo: REPO, pr_number: 7, lease_token: lease },
    });
    const [link] = listLiveLinkViews(db, issue.id);
    expect(link.declaredByName).toBe(agent.name);
  });

  it("emits pr_link_declared with confirmed:false — the event agrees with the row", async () => {
    const client = await connectSupervised();
    const lease = await claimIt(client);
    await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: issue.ref, repo: REPO, pr_number: 7, lease_token: lease },
    });
    const [row] = db.all<{ payload: string }>(
      sql`SELECT payload FROM events WHERE issue_id = ${issue.id} AND type = 'pr_link_declared' ORDER BY id DESC LIMIT 1`,
    );
    expect(JSON.parse(row.payload).confirmed).toBe(false);
  });

  it("refuses a declaration on an issue the session has not claimed", async () => {
    const other = createIssue(db, human, { projectKey: "SUP", title: "Not ours" });
    const client = await connectSupervised();
    const r = await client.callTool({
      name: "declare_pr_link",
      arguments: { ref: other.ref, repo: REPO, pr_number: 9 },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not yours to declare/i);
  });

  it("forces role to delivers — a supervised agent cannot mint a references suggestion", async () => {
    const client = await connectSupervised();
    const lease = await claimIt(client);
    await client.callTool({
      name: "declare_pr_link",
      arguments: {
        ref: issue.ref,
        repo: REPO,
        pr_number: 7,
        role: "references",
        lease_token: lease,
      },
    });
    const [link] = listLiveLinkViews(db, issue.id);
    expect(link.role).toBe("delivers");
  });

  // SYD-281: after the identity rule the session's assignments, declaredBy and
  // creatorId are the AGENT's, so a whoami that reported only the accountable
  // human would send search_issues(assignee: whoami().name) looking for work
  // under a name that holds none of it.
  it("whoami reports the accountable human AND the agent actually holding the work", async () => {
    const client = await connectSupervised();
    const me = JSON.parse(text(await client.callTool({ name: "whoami", arguments: {} })));
    expect(me.name).toBe(human.name);
    expect(me.type).toBe("human");
    expect(me.actingAs).toMatchObject({ id: agent.id, name: agent.name, type: "agent" });
  });
});
