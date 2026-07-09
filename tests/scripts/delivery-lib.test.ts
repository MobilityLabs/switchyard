import { describe, it, expect } from "vitest";
import {
  agentBranch,
  findDeliverableRefs,
  feedGap,
  buildPushArgs,
  buildPrListArgs,
  buildPrCreateArgs,
  buildPrMergeArgs,
  buildPrTitle,
  buildPrBody,
  deliveryComment,
  deliveryFailureComment,
  parseCursorText,
  tailOf,
  type DeliveryFeedEvent,
} from "../../scripts/delivery-lib.js";

const ev = (o: Partial<DeliveryFeedEvent>): DeliveryFeedEvent => ({
  id: 1,
  type: "status_changed",
  issue: "SYD-9",
  payload: { from: "in_review", to: "done" },
  ...o,
});

describe("findDeliverableRefs", () => {
  const keys = ["SYD"];

  it("null cursor initializes to newest id without firing on history", () => {
    const feed = [ev({ id: 7 }), ev({ id: 3 })];
    expect(findDeliverableRefs(feed, keys, null)).toEqual({ refs: [], lastEventId: 7 });
  });

  it("empty feed leaves the cursor untouched", () => {
    expect(findDeliverableRefs([], keys, null)).toEqual({ refs: [], lastEventId: null });
    expect(findDeliverableRefs([], keys, 5)).toEqual({ refs: [], lastEventId: 5 });
  });

  it("fires on status_changed→done newer than the cursor", () => {
    const feed = [ev({ id: 10 })];
    expect(findDeliverableRefs(feed, keys, 5)).toEqual({ refs: ["SYD-9"], lastEventId: 10 });
  });

  it("ignores events at or below the cursor", () => {
    expect(findDeliverableRefs([ev({ id: 5 })], keys, 5).refs).toEqual([]);
  });

  it("ignores non-done transitions and other event types", () => {
    const feed = [
      ev({ id: 11, payload: { from: "todo", to: "in_progress" } }),
      ev({ id: 12, type: "commented", payload: {} }),
    ];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual([]);
  });

  it("ignores unconfigured projects and dedupes refs", () => {
    const feed = [ev({ id: 11, issue: "OTHER-1" }), ev({ id: 12 }), ev({ id: 13 })];
    expect(findDeliverableRefs(feed, keys, 5).refs).toEqual(["SYD-9"]);
  });

  it("never moves the cursor backwards", () => {
    expect(findDeliverableRefs([ev({ id: 3 })], keys, 9).lastEventId).toBe(9);
  });
});

describe("feedGap", () => {
  it("null cursor ⇒ null", () => {
    expect(feedGap([ev({ id: 9 })], null)).toBeNull();
  });

  it("empty feed ⇒ null", () => {
    expect(feedGap([], 5)).toBeNull();
  });

  it("contiguous window (oldest === cursor + 1) ⇒ null", () => {
    expect(feedGap([ev({ id: 6 }), ev({ id: 10 })], 5)).toBeNull();
  });

  it("overlapping window (oldest <= cursor) ⇒ null", () => {
    expect(feedGap([ev({ id: 3 }), ev({ id: 10 })], 5)).toBeNull();
  });

  it("gap between cursor and window's oldest id", () => {
    expect(feedGap([ev({ id: 9 }), ev({ id: 15 })], 5)).toEqual({ from: 6, to: 8 });
  });
});

describe("argv builders", () => {
  it("agentBranch", () => {
    expect(agentBranch("SYD-9")).toBe("agent/SYD-9");
  });

  it("buildPushArgs", () => {
    expect(buildPushArgs("SYD-9")).toEqual(["push", "origin", "agent/SYD-9"]);
  });

  it("buildPrListArgs", () => {
    expect(buildPrListArgs("SYD-9")).toEqual([
      "pr", "list", "--head", "agent/SYD-9", "--state", "open", "--json", "number",
    ]);
  });

  it("buildPrCreateArgs embeds title and body as discrete argv entries", () => {
    const args = buildPrCreateArgs("SYD-9", "Fix the; thing `rm -rf`", "http://host:3300/");
    expect(args.slice(0, 5)).toEqual(["pr", "create", "--base", "main", "--head"]);
    expect(args).toContain("agent/SYD-9");
    expect(args).toContain("SYD-9: Fix the; thing `rm -rf`");
    expect(args.join(" ")).toContain("http://host:3300/issue/SYD-9");
  });

  it("buildPrMergeArgs", () => {
    expect(buildPrMergeArgs(41)).toEqual(["pr", "merge", "41", "--merge", "--delete-branch"]);
  });

  it("buildPrTitle / buildPrBody", () => {
    expect(buildPrTitle("SYD-9", "A title")).toBe("SYD-9: A title");
    expect(buildPrBody("SYD-9", "http://host:3300")).toContain("http://host:3300/issue/SYD-9");
  });
});

describe("comment bodies", () => {
  it("success with deploy", () => {
    const body = deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: true, ok: true, tail: "done" } });
    expect(body).toContain("PR #41");
    expect(body).toContain("abc123");
    expect(body).toContain("Deploy: succeeded");
  });

  it("deploy failure includes the output tail", () => {
    const body = deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: true, ok: false, tail: "boom" } });
    expect(body).toContain("Deploy: FAILED");
    expect(body).toContain("boom");
  });

  it("deploy skipped", () => {
    expect(deliveryComment({ prNumber: 41, mergeSha: "abc123", deploy: { ran: false } }))
      .toContain("Deploy: skipped");
  });

  it("failure comment names the ref and reason", () => {
    const body = deliveryFailureComment("SYD-9", "merge conflict");
    expect(body).toContain("SYD-9");
    expect(body).toContain("merge conflict");
  });
});

describe("parseCursorText", () => {
  it("parses a plain integer", () => {
    expect(parseCursorText("42\n")).toBe(42);
  });
  it("rejects junk", () => {
    expect(parseCursorText("")).toBeNull();
    expect(parseCursorText("abc")).toBeNull();
    expect(parseCursorText("-3")).toBeNull();
    expect(parseCursorText("1.5")).toBeNull();
  });
});

describe("tailOf", () => {
  it("keeps the last N lines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const tail = tailOf(text, 20);
    expect(tail.startsWith("line10")).toBe(true);
    expect(tail.endsWith("line29")).toBe(true);
  });
  it("caps total characters", () => {
    expect(tailOf("x".repeat(5000), 20, 2000).length).toBe(2000);
  });
});
