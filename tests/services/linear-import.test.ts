import { describe, it, expect } from "vitest";
import { SwitchyardError } from "../../src/services/errors.js";
import { mapStateToStatus, mapPriority } from "../../src/services/linear-import.js";

describe("mapStateToStatus", () => {
  it("maps each Linear state type to the matching Switchyard status", () => {
    expect(mapStateToStatus({ name: "Triage", type: "triage" })).toBe("triage");
    expect(mapStateToStatus({ name: "Backlog", type: "backlog" })).toBe("backlog");
    expect(mapStateToStatus({ name: "Todo", type: "unstarted" })).toBe("todo");
    expect(mapStateToStatus({ name: "In Progress", type: "started" })).toBe("in_progress");
    expect(mapStateToStatus({ name: "Done", type: "completed" })).toBe("done");
    expect(mapStateToStatus({ name: "Canceled", type: "canceled" })).toBe("canceled");
  });

  it("maps duplicate-type states to canceled", () => {
    expect(mapStateToStatus({ name: "Duplicate", type: "duplicate" })).toBe("canceled");
  });

  it("maps started states named like review to in_review", () => {
    expect(mapStateToStatus({ name: "In Review", type: "started" })).toBe("in_review");
    expect(mapStateToStatus({ name: "Code Review", type: "started" })).toBe("in_review");
    expect(mapStateToStatus({ name: "Reviewing", type: "started" })).toBe("in_review");
  });

  it("does not apply the review override outside started states", () => {
    expect(mapStateToStatus({ name: "Review Backlog", type: "backlog" })).toBe("backlog");
  });

  it("rejects unknown state types legibly", () => {
    expect(() => mapStateToStatus({ name: "Weird", type: "someday" })).toThrowError(
      SwitchyardError,
    );
    expect(() => mapStateToStatus({ name: "Weird", type: "someday" })).toThrowError(/someday/);
  });
});

describe("mapPriority", () => {
  it("maps Linear priority numbers to Switchyard priorities", () => {
    expect(mapPriority(0)).toBe("none");
    expect(mapPriority(1)).toBe("urgent");
    expect(mapPriority(2)).toBe("high");
    expect(mapPriority(3)).toBe("medium");
    expect(mapPriority(4)).toBe("low");
  });

  it("falls back to none for out-of-range values", () => {
    expect(mapPriority(5)).toBe("none");
    expect(mapPriority(-1)).toBe("none");
  });
});
