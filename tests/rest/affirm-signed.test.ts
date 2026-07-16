import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue, type IssueView } from "../../src/services/issues.js";
import { createLoginLink, redeemLoginLink } from "../../src/services/auth.js";
import { openSupervisedSession } from "../../src/services/supervised-sessions.js";
import { attributionOf } from "../../src/services/attribution.js";
import { setSetting } from "../../src/services/settings.js";
import { PendingAffirmation } from "../../src/services/errors.js";
import { affirmationKeys } from "../../src/db/schema.js";
import { AFFIRM_NAMESPACE, canonicalizeAction, type CanonicalAction } from "../../src/services/canonical-action.js";
import { createApp } from "../../src/server.js";

// CI has no FIDO hardware, so this generates a SOFTWARE ed25519 key and
// inserts an affirmation_keys row DIRECTLY (bypassing enrollAffirmationKey's
// hardware sk-* check, which tests/services/affirmation-keys.test.ts already
// covers). allowed_signers carries no verify-required (it isn't a real
// option — spec §3), so a software key verifies through the exact production
// path. No vi.mock anywhere in this file — see the brief's 2026-07-16 banner.
const keyDir = mkdtempSync(join(tmpdir(), "syd-affirm-signed-"));
const keyPath = join(keyDir, "id_ed25519");
execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "test"]);
const pubKeyLine = readFileSync(`${keyPath}.pub`, "utf8").trim();

afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

function signRaw(message: string, namespace = AFFIRM_NAMESPACE): string {
  return execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, "-"], {
    input: message,
    encoding: "utf8",
  });
}

function loginCookie(db: Db, name: string): string {
  const { token } = createLoginLink(db, name);
  const { sessionToken } = redeemLoginLink(db, token);
  return `switchyard_session=${sessionToken}`;
}

/**
 * Builds one supervised-session pending action plus a browser cookie and a
 * bearer token for its owning human, a bystander human, a keyless human, and
 * an agent — plus signature helpers over the REAL canonical doc the server
 * will rebuild for this row (captured off the thrown PendingAffirmation
 * rather than hand-built, so the test can't drift from what canonicalFor in
 * the route actually produces).
 */
function supervisedRest() {
  const db: Db = openDb(":memory:");
  const app = createApp(db);

  const { actor: human, token: humanToken } = createActor(db, { name: "sean", type: "human" });
  const { actor: otherHuman, token: otherHumanToken } = createActor(db, {
    name: "morgan",
    type: "human",
  });
  const { actor: keylessHuman, token: keylessHumanToken } = createActor(db, {
    name: "kelly",
    type: "human",
  });
  const { actor: agent, token: agentToken } = createActor(db, { name: "claude-code", type: "agent" });

  createProject(db, human, { key: "SYD", name: "switchyard" });
  const issue: IssueView = createIssue(db, human, { projectKey: "SYD", title: "Ship the gate" });
  updateIssue(db, human, issue.ref, { status: "todo" });

  const session = openSupervisedSession(db, human, agent.name);

  let caught: PendingAffirmation | undefined;
  try {
    updateIssue(
      db,
      human,
      issue.ref,
      { status: "done" },
      {},
      attributionOf({ actor: human, viaAgent: agent, sessionId: session.sessionId }),
    );
  } catch (err) {
    if (err instanceof PendingAffirmation) caught = err;
    else throw err;
  }
  if (!caught) throw new Error("expected the divert to throw PendingAffirmation");
  const pendingId = caught.pending.pendingActionId;
  const action = caught.pending.action as CanonicalAction;
  const canonical = caught.pending.canonical;

  db.insert(affirmationKeys).values({ actorId: human.id, publicKey: pubKeyLine }).run();

  return {
    db,
    app,
    human,
    otherHuman,
    cookie: loginCookie(db, human.name),
    humanToken,
    otherHumanToken,
    keylessHumanToken,
    agentToken,
    pendingId,
    signCanonical: () => signRaw(canonical),
    signOther: () =>
      signRaw(canonicalizeAction({ ...action, issueRef: `${action.issueRef}-OTHER` } as CanonicalAction)),
  };
}

describe("GET /api/pending-actions (SYD-243/244)", () => {
  it("is refused to an agent bearer", async () => {
    const { app, agentToken } = supervisedRest();
    const res = await app.request("/api/pending-actions", {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("returns only the requesting human's own sessions, with ref, current status, and canonical", async () => {
    const { app, humanToken, otherHumanToken } = supervisedRest();
    const mineRes = await app.request("/api/pending-actions", {
      headers: { authorization: `Bearer ${humanToken}` },
    });
    expect(mineRes.status).toBe(200);
    const mine = (await mineRes.json()) as Array<{ issueRef: string; issueStatus: string; canonical: string }>;
    expect(mine).toHaveLength(1);
    expect(mine[0].issueRef).toBe("SYD-1");
    // The issue was moved to "todo" before the divert-to-done attempt in
    // supervisedRest() — this pins the CURRENT status (pre-affirmation), the
    // field the review finding required so `syd affirm` can render
    // "current -> target" instead of only the destination.
    expect(mine[0].issueStatus).toBe("todo");
    expect(JSON.parse(mine[0].canonical)).toMatchObject({ v: 1, issueRef: "SYD-1" });
    // issueStatus must NEVER leak into the signed canonical doc — it's volatile
    // display data, not part of the fixed signed field set.
    expect(JSON.parse(mine[0].canonical)).not.toHaveProperty("issueStatus");

    const theirsRes = await app.request("/api/pending-actions", {
      headers: { authorization: `Bearer ${otherHumanToken}` },
    });
    expect(theirsRes.status).toBe(200);
    const theirs = (await theirsRes.json()) as unknown[];
    expect(theirs).toHaveLength(0);
  });
});

describe("POST /api/pending-actions/:id/affirm — cookie gating (SYD-242 phase 2)", () => {
  it("403s when supervised.affirm_requires_signature is on", async () => {
    const { app, db, human, cookie, pendingId } = supervisedRest();
    setSetting(db, human, "supervised.affirm_requires_signature", true);
    const res = await app.request(`/api/pending-actions/${pendingId}/affirm`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/signed affirmation is required/i);
  });

  it("still works when the setting is off — Phase 1 unregressed", async () => {
    const { app, cookie, pendingId } = supervisedRest();
    const res = await app.request(`/api/pending-actions/${pendingId}/affirm`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("done");
  });
});

describe("POST /api/pending-actions/:id/affirm-signed", () => {
  it("rejects a signature over a different action", async () => {
    const { app, humanToken, pendingId, signOther } = supervisedRest();
    const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({ signature: signOther() }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not match/i);
  });

  it("accepts a signature over the canonical doc and stamps done", async () => {
    const { app, humanToken, pendingId, signCanonical } = supervisedRest();
    const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
      method: "POST",
      headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json" },
      body: JSON.stringify({ signature: signCanonical() }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("done");
  });

  it("refuses a human with no enrolled keys", async () => {
    const { app, keylessHumanToken, pendingId } = supervisedRest();
    const res = await app.request(`/api/pending-actions/${pendingId}/affirm-signed`, {
      method: "POST",
      headers: { authorization: `Bearer ${keylessHumanToken}`, "content-type": "application/json" },
      body: JSON.stringify({ signature: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no affirmation keys/i);
  });
});
