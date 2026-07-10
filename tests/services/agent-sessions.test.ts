import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import {
  startAgentSession, endAgentSession, listAgentSessions, recordProgressNote,
  AGENT_SESSION_STALE_SECONDS,
} from "../../src/services/agent-sessions.js";

let db: Db, human: Actor, agent: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, { key: "SYD", name: "Switchyard" });
  createIssue(db, agent, {
    projectKey: "SYD", title: "Ship v1", description: "x",
    provenance: { sourceType: "session" },
  });
});

describe("startAgentSession", () => {
  it("creates a running session joined with the issue ref and title", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli", pid: 4242 });
    expect(s).toMatchObject({
      ref: "SYD-1", issueTitle: "Ship v1", mode: "cli", pid: 4242,
      status: "running", exitCode: null, endedAt: null, lastNote: null,
    });
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it("rejects human actors — only workers report sessions", () => {
    expect(() => startAgentSession(db, human, { ref: "SYD-1", mode: "cli" }))
      .toThrow(/agent actors/i);
  });

  it("rejects an unknown ref", () => {
    expect(() => startAgentSession(db, agent, { ref: "SYD-999", mode: "cli" })).toThrow();
  });
});

describe("endAgentSession", () => {
  it("marks the session exited with its exit code and end time", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "sdk" });
    const ended = endAgentSession(db, agent, s.id, 0);
    expect(ended.status).toBe("exited");
    expect(ended.exitCode).toBe(0);
    expect(ended.endedAt).toBeGreaterThan(0);
  });

  it("accepts a null exit code (spawn error, unknown outcome)", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    expect(endAgentSession(db, agent, s.id, null).exitCode).toBeNull();
  });

  it("rejects an unknown session id", () => {
    expect(() => endAgentSession(db, agent, 999, 0)).toThrow(/does not exist/);
  });
});

describe("listAgentSessions", () => {
  it("active filter returns only running sessions", () => {
    const a = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    const b = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    endAgentSession(db, agent, b.id, 1);
    const active = listAgentSessions(db, { active: true });
    expect(active.map((s) => s.id)).toEqual([a.id]);
    expect(listAgentSessions(db).length).toBe(2);
  });

  it("active filter drops zombie sessions the worker never closed out", () => {
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    const farFuture = Math.floor(Date.now() / 1000) + AGENT_SESSION_STALE_SECONDS + 60;
    expect(listAgentSessions(db, { active: true }, farFuture)).toEqual([]);
  });

  it("filters by ref", () => {
    createIssue(db, agent, {
      projectKey: "SYD", title: "Other", description: "y",
      provenance: { sourceType: "session" },
    });
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    startAgentSession(db, agent, { ref: "SYD-2", mode: "cli" });
    const only = listAgentSessions(db, { ref: "SYD-2" });
    expect(only.length).toBe(1);
    expect(only[0].ref).toBe("SYD-2");
  });
});

describe("recordProgressNote", () => {
  it("records a progress_note event onto the activity feed", () => {
    recordProgressNote(db, agent, "SYD-1", "tests written, implementing the service");
    const ev = getActivity(db, "SYD-1").find((a) => a.type === "progress_note");
    expect(ev?.payload).toEqual({ note: "tests written, implementing the service" });
  });

  it("rejects an empty note", () => {
    expect(() => recordProgressNote(db, agent, "SYD-1", "   ")).toThrow(/empty/i);
  });

  it("surfaces the latest note on the session view", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    recordProgressNote(db, agent, "SYD-1", "first");
    recordProgressNote(db, agent, "SYD-1", "second");
    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.id).toBe(s.id);
    expect(view.lastNote?.note).toBe("second");
  });

  it("does not attribute a later session's note to an earlier exited session", () => {
    const first = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    endAgentSession(db, agent, first.id, 0);
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    recordProgressNote(db, agent, "SYD-1", "second session note");
    const firstView = listAgentSessions(db, { ref: "SYD-1" }).find((s) => s.id === first.id);
    expect(firstView?.lastNote).toBeNull();
  });

  it("rejects human actors — progress notes are agent session status", () => {
    expect(() => recordProgressNote(db, human, "SYD-1", "hi")).toThrow(/agent actors/i);
  });
});
