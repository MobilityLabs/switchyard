// Task 4: parking a hard-gated `done` is a SUCCESS, not an error. This drives
// the REAL /mcp endpoint (serve + StreamableHTTPClientTransport, mirroring
// supervised-mcp-endpoint.test.ts) because guard()'s translation is what turns
// the PendingAffirmation signal into a non-isError result carrying the canonical
// document — a buildMcpServer-level test would still exercise guard(), but the
// endpoint test also proves /mcp resolves the supervised principal that makes
// the divert fire at all.
//
// This is the SOLE behavioral test for the signal: the REST onError arm is
// unreachable by construction (a sup_ token resolves only at /mcp), so there is
// no honest way to drive it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type IssueView } from "../../src/services/issues.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { setSetting } from "../../src/services/settings.js";
import { createApp } from "../../src/server.js";

let db: Db, human: Actor, agent: Actor, issue: IssueView;
let supToken: string, sessionId: number;
let server: ReturnType<typeof serve>, baseUrl: string;

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude-code", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  const session = openSupervisedSession(db, human, agent.name);
  supToken = session.sessionToken;
  sessionId = session.sessionId;
  issue = createIssue(db, human, { projectKey: "SYD", title: "Relay the affirmation" });
  updateIssue(db, human, issue.ref, { status: "todo" });

  server = serve({ fetch: createApp(db).fetch, port: 0 });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a parked hard-gated done over the real /mcp endpoint", () => {
  it("returns a SUCCESS result (not isError) carrying the canonical doc", async () => {
    const client = await connect(supToken);
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done" },
    });

    // The whole point: parked is not a failure. isError must be absent, not just
    // falsy — guard()'s ok() path never sets the key.
    expect(r.isError).toBeUndefined();

    const body = JSON.parse(text(r)) as {
      pendingActionId: number;
      canonical: string;
      action: Record<string, unknown>;
      instructions: string;
    };
    expect(body.pendingActionId).toBeGreaterThan(0);
    expect(JSON.parse(body.canonical)).toMatchObject({
      v: 1,
      issueRef: issue.ref,
      actionType: "done",
      pendingActionId: body.pendingActionId,
      sessionId,
    });
    // The parsed twin renders without the client re-parsing the signed bytes.
    expect(body.action).toMatchObject({ v: 1, issueRef: issue.ref, actionType: "done" });
    expect(body.instructions).toContain("syd affirm");

    // Nothing was changed — parking it is the whole point.
    expect(
      db.all<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue.id}`)[0].status,
    ).toBe("todo");
    await client.close();
  });

  it("stamps expiresAt from supervised.affirm_ttl_seconds, on the row and in the signed bytes", async () => {
    setSetting(db, human, "supervised.affirm_ttl_seconds", 900);
    const before = Math.floor(Date.now() / 1000);
    const client = await connect(supToken);
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done" },
    });
    const body = JSON.parse(text(r)) as { pendingActionId: number; canonical: string };

    const row = db.all<{ expires_at: number }>(
      sql`SELECT expires_at FROM pending_actions WHERE id = ${body.pendingActionId}`,
    )[0];
    // The configured TTL, not Task 2's hardcoded 300.
    expect(row.expires_at).toBeGreaterThanOrEqual(before + 900);
    expect(row.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    // The row and the bytes the human signs must agree, or a signature verifies
    // against an expiry the server does not enforce.
    expect((JSON.parse(body.canonical) as { expiresAt: number }).expiresAt).toBe(row.expires_at);
    await client.close();
  });

  it("re-proposing dedups to one row and restarts its expiry window", async () => {
    setSetting(db, human, "supervised.affirm_ttl_seconds", 60);
    const client = await connect(supToken);
    const first = JSON.parse(
      text(
        await client.callTool({ name: "update_issue", arguments: { ref: issue.ref, status: "done" } }),
      ),
    ) as { pendingActionId: number };

    // Age the row past its TTL, then re-propose: the upsert's `set` must refresh
    // expiresAt, or an earlier attempt strands the row past its window forever.
    db.run(sql`UPDATE pending_actions SET expires_at = 1 WHERE id = ${first.pendingActionId}`);
    const second = JSON.parse(
      text(
        await client.callTool({ name: "update_issue", arguments: { ref: issue.ref, status: "done" } }),
      ),
    ) as { pendingActionId: number };

    expect(second.pendingActionId).toBe(first.pendingActionId);
    expect(
      db.all<{ c: number }>(sql`SELECT COUNT(*) c FROM pending_actions WHERE status = 'pending'`)[0]
        .c,
    ).toBe(1);
    expect(
      db.all<{ expires_at: number }>(
        sql`SELECT expires_at FROM pending_actions WHERE id = ${first.pendingActionId}`,
      )[0].expires_at,
    ).toBeGreaterThan(1);
    await client.close();
  });

  it("parks the CANONICAL ref, not the caller's raw spelling, so canonicalFor's re-derivation matches", async () => {
    // issue.ref is the canonical "SYD-1" form. A zero-padded but equivalent
    // spelling ("SYD-01") must still resolve to the same issue (parseRef's
    // regex accepts leading zeros: Number("01") === 1) — but the divert must
    // NOT echo that raw spelling into the canonical doc it parks, because
    // src/rest/pending-actions.ts's canonicalFor() re-derives issueRef from the
    // row via issueRefById(), which always yields the canonical form. A padded
    // ref recorded verbatim here would make the two byte-identical documents
    // diverge on issueRef alone.
    const paddedRef = issue.ref.replace(/-(\d+)$/, (_m, n) => `-0${n}`);
    expect(paddedRef).not.toBe(issue.ref);

    const client = await connect(supToken);
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: paddedRef, status: "done" },
    });
    expect(r.isError).toBeUndefined();

    const body = JSON.parse(text(r)) as { canonical: string; action: Record<string, unknown> };
    expect(JSON.parse(body.canonical)).toMatchObject({ issueRef: issue.ref });
    expect(body.action).toMatchObject({ issueRef: issue.ref });
    await client.close();
  });

  it("still reports a real rejection as isError (the signal did not swallow failures)", async () => {
    const client = await connect(supToken);
    // A mixed patch is rejected by the divert's own guard with a SwitchyardError
    // — it must stay an error result, proving the new arm narrowed correctly.
    const r = await client.callTool({
      name: "update_issue",
      arguments: { ref: issue.ref, status: "done", priority: "high" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/must be its own call/i);
    await client.close();
  });
});
