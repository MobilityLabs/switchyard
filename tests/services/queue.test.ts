// The manual working order (SYD-294, parent SYD-293).
//
// Two things under test, and the second is the reason this exists at all:
//   1. setQueuePosition maintains a coherent order across insert/move/remove.
//   2. nextTask actually HANDS OUT that order — an order the recommender
//      ignores is a document, which is exactly the state SYD-294 was filed to
//      fix (docs/2026-07-28-board-working-order.md).
//
// Every ordering assertion drives `nextTask` rather than inspecting queue_rank,
// because the rank is an implementation detail and the observable contract is
// "what do I get handed next".
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, updateIssue } from "../../src/services/issues.js";
import { addDependency, nextTask } from "../../src/services/dependencies.js";
import { listQueue, setQueuePosition } from "../../src/services/queue.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, claude: Actor, codex: Actor;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  // The engine is the actor-name prefix — these are the real production actor
  // names (claude/dev, codex/dev, gemini/dev), which is what makes affinity
  // derivable from the caller's token alone.
  claude = createActor(db, { name: "claude/dev", type: "agent" }).actor;
  codex = createActor(db, { name: "codex/dev", type: "agent" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
});

/** A `todo` issue, since only `todo` is workable. */
function todo(title: string, patch: Record<string, unknown> = {}) {
  const issue = createIssue(db, human, { projectKey: "SYD", title, ...patch });
  updateIssue(db, human, issue.ref, { status: "todo" });
  return issue.ref;
}

const next = (actor: Actor) => nextTask(db, actor, "SYD")?.ref ?? null;

describe("setQueuePosition", () => {
  it("places, reorders, and reports the queue front-first", () => {
    const a = todo("A"),
      b = todo("B"),
      c = todo("C");
    setQueuePosition(db, human, a, { position: 1 });
    setQueuePosition(db, human, b, { position: 2 });
    expect(listQueue(db).map((i) => i.ref)).toEqual([a, b]);

    // Position 1 means "worked next", so this jumps the whole queue.
    setQueuePosition(db, human, c, { position: 1 });
    expect(listQueue(db).map((i) => i.ref)).toEqual([c, a, b]);
  });

  it("moving an already-queued issue does not duplicate it", () => {
    const a = todo("A"),
      b = todo("B"),
      c = todo("C");
    for (const [i, ref] of [a, b, c].entries())
      setQueuePosition(db, human, ref, { position: i + 1 });
    setQueuePosition(db, human, c, { position: 1 });
    expect(listQueue(db).map((i) => i.ref)).toEqual([c, a, b]);
  });

  it("a position past the end appends rather than erroring", () => {
    const a = todo("A"),
      b = todo("B");
    setQueuePosition(db, human, a, { position: 1 });
    setQueuePosition(db, human, b, { position: 99 });
    expect(listQueue(db).map((i) => i.ref)).toEqual([a, b]);
  });

  it("null removes from the queue, leaving the rest contiguous", () => {
    const a = todo("A"),
      b = todo("B"),
      c = todo("C");
    for (const [i, ref] of [a, b, c].entries())
      setQueuePosition(db, human, ref, { position: i + 1 });
    setQueuePosition(db, human, b, { position: null });
    expect(listQueue(db).map((i) => i.ref)).toEqual([a, c]);
    // And the removed issue is genuinely unranked, not parked at the end.
    expect(listQueue(db).map((i) => i.ref)).not.toContain(b);
  });

  it("refuses a position that is not a whole number from 1", () => {
    const a = todo("A");
    expect(() => setQueuePosition(db, human, a, { position: 0 })).toThrow(/queue position/i);
    expect(() => setQueuePosition(db, human, a, { position: 1.5 })).toThrow(/queue position/i);
  });

  it("records the move as positions, not raw ranks", () => {
    const a = todo("A"),
      b = todo("B");
    setQueuePosition(db, human, a, { position: 1 });
    setQueuePosition(db, human, b, { position: 1 });
    const moves = listIssueEvents(db, 1).filter((e) => e.type === "queue_position_changed");
    expect(moves).toHaveLength(1);
    // A went in at 1 and was pushed to 2 by B — but only A's own call is its
    // event, so it reads {from: null, to: 1}.
    expect(moves[0].payload).toEqual({ from: null, to: 1 });
  });

  it("an agent may order the board — this refines priority, which was never human-gated", () => {
    const a = todo("A");
    expect(() => setQueuePosition(db, claude, a, { position: 1 })).not.toThrow();
    expect(listQueue(db).map((i) => i.ref)).toEqual([a]);
  });
});

describe("nextTask honours the queue", () => {
  it("a queued issue outranks a HIGHER-priority unranked one", () => {
    const low = todo("low", { priority: "low" });
    todo("urgent", { priority: "urgent" });
    setQueuePosition(db, human, low, { position: 1 });
    expect(next(claude)).toBe(low);
  });

  it("walks the queue in order as issues are taken", () => {
    const a = todo("A"),
      b = todo("B");
    setQueuePosition(db, human, a, { position: 1 });
    setQueuePosition(db, human, b, { position: 2 });
    expect(next(claude)).toBe(a);
    updateIssue(db, human, a, { status: "done" });
    expect(next(claude)).toBe(b);
  });

  it("falls through to priority once the queue is exhausted", () => {
    const queued = todo("queued", { priority: "low" });
    const urgent = todo("urgent", { priority: "urgent" });
    setQueuePosition(db, human, queued, { position: 1 });
    expect(next(claude)).toBe(queued);
    updateIssue(db, human, queued, { status: "done" });
    expect(next(claude)).toBe(urgent);
  });

  it("an unranked board behaves exactly as before — priority, then age", () => {
    todo("older-high", { priority: "high" });
    const urgent = todo("urgent", { priority: "urgent" });
    todo("newer-high", { priority: "high" });
    expect(next(claude)).toBe(urgent);
  });
});

describe("nextTask skips what the caller cannot take (SYD-294)", () => {
  it("skips a queued epic and hands out the next one instead", () => {
    const epic = todo("epic"),
      real = todo("real work");
    // A child still open makes the parent a container, not a task.
    const child = createIssue(db, human, { projectKey: "SYD", title: "story", parentRef: epic });
    updateIssue(db, human, child.ref, { status: "todo" });
    setQueuePosition(db, human, epic, { position: 1 });
    setQueuePosition(db, human, real, { position: 2 });
    expect(next(claude)).toBe(real);
  });

  it("offers the parent again once every child is closed — what is left is stamping it", () => {
    const epic = todo("epic");
    const child = createIssue(db, human, { projectKey: "SYD", title: "story", parentRef: epic });
    updateIssue(db, human, child.ref, { status: "todo" });
    expect(next(claude)).not.toBe(epic);
    updateIssue(db, human, child.ref, { status: "canceled" });
    expect(next(claude)).toBe(epic);
  });

  it("never hands an `interactive` issue to an agent, but does to a human", () => {
    const hands_on = todo("needs a person", { workerPreference: "interactive" });
    setQueuePosition(db, human, hands_on, { position: 1 });
    expect(next(claude)).toBeNull();
    expect(next(human)).toBe(hands_on);
  });

  // The hard skip above keyed on actor.type, which conflated two different
  // questions: "is this a person" and "is a person watching this session".
  // An interactive Claude session is an agent by type but is human-attended,
  // and it is exactly the caller `interactive` work is meant for -- yet it was
  // routed away from it, so the top of the curated queue was invisible to the
  // only non-human caller that could do it.
  it("hands an `interactive` issue to an ATTENDED agent, not just a human", () => {
    const session = createActor(db, {
      name: "claude/interactive",
      type: "agent",
      attended: true,
    }).actor;
    const hands_on = todo("needs a person", { workerPreference: "interactive" });
    setQueuePosition(db, human, hands_on, { position: 1 });
    expect(next(claude)).toBeNull(); // unattended dispatch worker: still skipped
    expect(next(session)).toBe(hands_on);
    expect(next(human)).toBe(hands_on);
  });

  it("defaults an agent to unattended — the safe direction, since it only withholds work", () => {
    const plain = createActor(db, { name: "claude/other", type: "agent" }).actor;
    expect(plain.attended).toBe(false);
    const hands_on = todo("needs a person", { workerPreference: "interactive" });
    setQueuePosition(db, human, hands_on, { position: 1 });
    expect(next(plain)).toBeNull();
  });

  it("treats a human as attended without anyone setting a flag", () => {
    expect(human.attended).toBe(true);
  });

  it("skips a queued interactive issue rather than stalling on it", () => {
    const hands_on = todo("needs a person", { workerPreference: "interactive" });
    const headless = todo("headless-ok");
    setQueuePosition(db, human, hands_on, { position: 1 });
    setQueuePosition(db, human, headless, { position: 2 });
    // The whole point of skip-don't-stall: position 1 being unusable must not
    // hide position 2.
    expect(next(claude)).toBe(headless);
    expect(next(human)).toBe(hands_on);
  });

  it("skips a queued issue that is blocked", () => {
    const blocked = todo("blocked"),
      open = todo("open");
    const blocker = todo("blocker");
    addDependency(db, human, blocker, blocked);
    setQueuePosition(db, human, blocked, { position: 1 });
    setQueuePosition(db, human, open, { position: 2 });
    expect(next(claude)).toBe(open);
  });
});

describe("engine affinity (soft, SYD-201)", () => {
  it("prefers an issue matching the caller's engine over a neutral one", () => {
    todo("neutral");
    const forCodex = todo("codex work", { workerPreference: "codex" });
    expect(next(codex)).toBe(forCodex);
  });

  it("sorts another engine's preference last, but still offers it — preference never restricts", () => {
    const forCodex = todo("codex work", { workerPreference: "codex" });
    const neutral = todo("neutral");
    expect(next(claude)).toBe(neutral);
    updateIssue(db, human, neutral, { status: "done" });
    // Nothing else left: claude still gets it rather than being told there is
    // no work. This is the SYD-201 rule the hard `interactive` skip departs from.
    expect(next(claude)).toBe(forCodex);
  });

  it("an explicit queue position outranks affinity — the human's order wins", () => {
    const forCodex = todo("codex work", { workerPreference: "codex" });
    const neutral = todo("neutral");
    setQueuePosition(db, human, neutral, { position: 1 });
    setQueuePosition(db, human, forCodex, { position: 2 });
    expect(next(codex)).toBe(neutral);
  });
});
