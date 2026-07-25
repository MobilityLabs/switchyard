import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import { events, agentSessions } from "../../src/db/schema.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { setSetting } from "../../src/services/settings.js";
import {
  startAgentSession,
  endAgentSession,
  listAgentSessions,
  recordProgressNote,
  sweepOrphanedAgentSessions,
  AGENT_SESSION_STALE_SECONDS,
} from "../../src/services/agent-sessions.js";

function ageSession(db: Db, id: number, secondsAgo: number) {
  const startedAt = Math.floor(Date.now() / 1000) - secondsAgo;
  db.update(agentSessions).set({ startedAt }).where(eq(agentSessions.id, id)).run();
}

let db: Db, human: Actor, agent: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, agent, {
    projectKey: "SYD",
    title: "Ship v1",
    description: "x",
    provenance: { sourceType: "session" },
  });
});

describe("startAgentSession", () => {
  it("creates a running session joined with the issue ref, title, and actor name", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli", pid: 4242 });
    expect(s).toMatchObject({
      ref: "SYD-1",
      issueTitle: "Ship v1",
      mode: "cli",
      pid: 4242,
      status: "running",
      exitCode: null,
      endedAt: null,
      lastNote: null,
      actor: "claude/worker",
    });
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it("includes the correct actor name for each session view when multiple agents are active", () => {
    const codex = createActor(db, { name: "auto-codex", type: "agent" }).actor;
    const s1 = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    const s2 = startAgentSession(db, codex, { ref: "SYD-1", mode: "cli" });

    expect(s1.actor).toBe("claude/worker");
    expect(s2.actor).toBe("auto-codex");

    const views = listAgentSessions(db);
    const view1 = views.find((v) => v.id === s1.id);
    const view2 = views.find((v) => v.id === s2.id);

    expect(view1?.actor).toBe("claude/worker");
    expect(view2?.actor).toBe("auto-codex");
  });

  it("rejects human actors — only workers report sessions", () => {
    expect(() => startAgentSession(db, human, { ref: "SYD-1", mode: "cli" })).toThrow(
      /agent actors/i,
    );
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

  it("rejects ending a session owned by another agent actor (SYD-123)", () => {
    const otherAgent = createActor(db, { name: "claude/other", type: "agent" }).actor;
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    expect(() => endAgentSession(db, otherAgent, s.id, 0)).toThrow(/belongs to another actor/i);
    expect(listAgentSessions(db, { ref: "SYD-1" })[0].status).toBe("running");
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

  it("respects a lowered sessions.stale_seconds setting (knob bite)", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    setSetting(db, human, "sessions.stale_seconds", 30);
    // fresh (well within the lowered 30s window)
    expect(listAgentSessions(db, { active: true }).map((v) => v.id)).toEqual([s.id]);

    // "now" 60s later crosses the lowered window even though it's still well
    // within the 12h default — proves the setting, not the constant, governs.
    const later = Math.floor(Date.now() / 1000) + 60;
    expect(listAgentSessions(db, { active: true }, later)).toEqual([]);
  });

  it("filters by ref", () => {
    createIssue(db, agent, {
      projectKey: "SYD",
      title: "Other",
      description: "y",
      provenance: { sourceType: "session" },
    });
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    startAgentSession(db, agent, { ref: "SYD-2", mode: "cli" });
    const only = listAgentSessions(db, { ref: "SYD-2" });
    expect(only.length).toBe(1);
    expect(only[0].ref).toBe("SYD-2");
  });

  it("scopes to a single actor's sessions when actorId is given (engine-scoped reconcile)", () => {
    const codex = createActor(db, { name: "auto-codex", type: "agent" }).actor;
    createIssue(db, agent, {
      projectKey: "SYD",
      title: "Other",
      description: "y",
      provenance: { sourceType: "session" },
    });
    startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" }); // claude/worker
    startAgentSession(db, codex, { ref: "SYD-2", mode: "cli" }); // codex actor

    expect(listAgentSessions(db, { active: true, actorId: agent.id }).map((s) => s.ref)).toEqual([
      "SYD-1",
    ]);
    expect(listAgentSessions(db, { active: true, actorId: codex.id }).map((s) => s.ref)).toEqual([
      "SYD-2",
    ]);
    // unscoped still returns both — the UI panel is not actor-scoped.
    expect(
      listAgentSessions(db, { active: true })
        .map((s) => s.ref)
        .sort(),
    ).toEqual(["SYD-1", "SYD-2"]);
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

  it("drops a note landing in the same second the session exits (SYD-105: strict upper bound)", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    recordProgressNote(db, agent, "SYD-1", "in the exit second");
    const ended = endAgentSession(db, agent, s.id, 0);
    // Force the note onto the exact second the session exits, regardless of
    // real wall-clock timing, to pin the strict `lt(endedAt)` bound.
    db.update(events)
      .set({ createdAt: ended.endedAt as number })
      .where(eq(events.type, "progress_note"))
      .run();
    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.lastNote).toBeNull();
  });

  it("does not attribute another agent actor's note in the same window to this session (SYD-105)", () => {
    const otherAgent = createActor(db, { name: "claude/other", type: "agent" }).actor;
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "cli" });
    recordProgressNote(db, otherAgent, "SYD-1", "not this session's note");
    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.id).toBe(s.id);
    expect(view.lastNote).toBeNull();
  });
});

describe("sweepOrphanedAgentSessions", () => {
  it("marks a running session older than the stale window as exited with a null exit code", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "container" });
    ageSession(db, s.id, AGENT_SESSION_STALE_SECONDS + 60);

    const swept = sweepOrphanedAgentSessions(db);
    expect(swept).toBe(1);

    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.status).toBe("exited");
    expect(view.exitCode).toBeNull();
    expect(view.endedAt).toBeGreaterThan(0);
  });

  it("leaves a fresh running session untouched", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "container" });

    const swept = sweepOrphanedAgentSessions(db);
    expect(swept).toBe(0);

    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.id).toBe(s.id);
    expect(view.status).toBe("running");
  });

  it("leaves an already-exited session untouched", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "container" });
    endAgentSession(db, agent, s.id, 0);
    ageSession(db, s.id, AGENT_SESSION_STALE_SECONDS + 60);

    const swept = sweepOrphanedAgentSessions(db);
    expect(swept).toBe(0);

    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.exitCode).toBe(0); // untouched by the sweep
  });

  it("respects a custom staleSeconds", () => {
    const s = startAgentSession(db, agent, { ref: "SYD-1", mode: "container" });
    ageSession(db, s.id, 30);

    expect(sweepOrphanedAgentSessions(db, 3600)).toBe(0);
    expect(sweepOrphanedAgentSessions(db, 10)).toBe(1);
    const [view] = listAgentSessions(db, { ref: "SYD-1" });
    expect(view.status).toBe("exited");
  });
});
