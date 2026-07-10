// Agent-session lifecycle (SYD-43): the dispatch worker reports when a session
// starts and exits so the UI can show live "an agent is working this" state.
// Progress notes ride the events table (type "progress_note") like all other
// issue history; sessions get a real table because they are worker-process
// state (pid, exit code), not issue history.
import { and, desc, eq, gt, gte, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentSessions, events, issues, projects } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

export const AGENT_SESSION_MODES = ["cli", "container", "sdk"] as const;
export type AgentSessionMode = (typeof AGENT_SESSION_MODES)[number];

// A "running" session older than this is presumed lost (the worker died
// before reporting the exit) and drops out of active lists rather than
// showing a zombie "live" strip forever.
export const AGENT_SESSION_STALE_SECONDS = 12 * 60 * 60;

// Flat LIMIT, no cursor: the panel only ever shows "active + recent," never
// paged history, so silent truncation past the 50th row is a non-issue today.
// If the panel grows a "load more" / history view, adopt the before_id
// cursor + truncated/nextCursor pattern from listRecentEventsPage (SYD-89)
// rather than raising this number.
const LIST_LIMIT = 50;

export type AgentSessionView = {
  id: number;
  ref: string;
  issueTitle: string;
  mode: AgentSessionMode;
  pid: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  lastNote: { note: string; createdAt: number } | null;
};

function requireAgent(actor: Actor, action: string): void {
  if (actor.type !== "agent") {
    throw new SwitchyardError(`Only agent actors ${action}.`);
  }
}

// Notes are per-issue events; scoping to the session's actor and its
// [startedAt, endedAt) window attributes them to this session. The actorId
// scope matters once two agent actors can be active on the same issue at
// once (e.g. a work session and an answerer session) — without it a note
// from the other actor inside the same window would display as this
// session's status. The upper bound is strict: a note landing in the same
// second the session exits is dropped rather than risk attributing a later
// session's note to this one (unixepoch granularity).
function lastNoteFor(
  db: Db, issueId: number, actorId: number, startedAt: number, endedAt: number | null
): AgentSessionView["lastNote"] {
  const conditions = [
    eq(events.issueId, issueId),
    eq(events.actorId, actorId),
    eq(events.type, "progress_note"),
    gte(events.createdAt, startedAt),
  ];
  if (endedAt !== null) conditions.push(lt(events.createdAt, endedAt));
  const [row] = db
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.id))
    .limit(1)
    .all();
  if (!row) return null;
  return { note: String((row.payload as Record<string, unknown>).note ?? ""), createdAt: row.createdAt };
}

function queryViews(db: Db, conditions: SQL[]): AgentSessionView[] {
  const rows = db
    .select({ s: agentSessions, key: projects.key, number: issues.number, issueTitle: issues.title })
    .from(agentSessions)
    .innerJoin(issues, eq(agentSessions.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentSessions.id))
    .limit(LIST_LIMIT)
    .all();
  return rows.map((r) => ({
    id: r.s.id,
    ref: `${r.key}-${r.number}`,
    issueTitle: r.issueTitle,
    mode: r.s.mode,
    pid: r.s.pid,
    status: r.s.status,
    exitCode: r.s.exitCode,
    startedAt: r.s.startedAt,
    endedAt: r.s.endedAt,
    lastNote: lastNoteFor(db, r.s.issueId, r.s.actorId, r.s.startedAt, r.s.endedAt),
  }));
}

export function startAgentSession(
  db: Db,
  actor: Actor,
  input: { ref: string; mode: AgentSessionMode; pid?: number | null }
): AgentSessionView {
  requireAgent(actor, "report agent sessions");
  const issue = getIssue(db, input.ref);
  const row = db
    .insert(agentSessions)
    .values({ issueId: issue.id, actorId: actor.id, mode: input.mode, pid: input.pid ?? null })
    .returning()
    .get();
  return queryViews(db, [eq(agentSessions.id, row.id)])[0];
}

export function endAgentSession(db: Db, actor: Actor, id: number, exitCode: number | null): AgentSessionView {
  requireAgent(actor, "report agent sessions");
  const existing = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!existing) throw new SwitchyardError(`Agent session ${id} does not exist.`);
  db.update(agentSessions)
    .set({ status: "exited", exitCode, endedAt: sql`(unixepoch())` })
    .where(eq(agentSessions.id, id))
    .run();
  return queryViews(db, [eq(agentSessions.id, id)])[0];
}

export function listAgentSessions(
  db: Db,
  filters: { active?: boolean; ref?: string } = {},
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AgentSessionView[] {
  const conditions: SQL[] = [];
  if (filters.ref) conditions.push(eq(agentSessions.issueId, getIssue(db, filters.ref).id));
  if (filters.active) {
    conditions.push(eq(agentSessions.status, "running"));
    conditions.push(gt(agentSessions.startedAt, nowSeconds - AGENT_SESSION_STALE_SECONDS));
  }
  return queryViews(db, conditions);
}

export function recordProgressNote(db: Db, actor: Actor, ref: string, note: string): void {
  requireAgent(actor, "record progress notes");
  const trimmed = note.trim();
  if (!trimmed) throw new SwitchyardError("A progress note must not be empty.");
  const issue = getIssue(db, ref);
  recordEvent(db, { issueId: issue.id, actorId: actor.id, type: "progress_note", payload: { note: trimmed } });
}
