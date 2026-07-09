import { describe, expect, it } from "vitest";
import { countNewArrivals, firstRef, pickAdjacentRef } from "./reviewQueue";

const queue = [{ ref: "SYD-1" }, { ref: "SYD-2" }, { ref: "SYD-3" }];

describe("firstRef", () => {
  it("returns the first item's ref", () => {
    expect(firstRef(queue)).toBe("SYD-1");
  });

  it("returns null for an empty queue", () => {
    expect(firstRef([])).toBeNull();
  });
});

describe("pickAdjacentRef", () => {
  it("returns null for an empty queue", () => {
    expect(pickAdjacentRef([], "SYD-1", 1)).toBeNull();
  });

  it("returns the first item when there is no current ref", () => {
    expect(pickAdjacentRef(queue, null, 1)).toBe("SYD-1");
  });

  it("returns the first item when the current ref isn't in the queue", () => {
    expect(pickAdjacentRef(queue, "SYD-99", 1)).toBe("SYD-1");
  });

  it("steps forward from the current item", () => {
    expect(pickAdjacentRef(queue, "SYD-1", 1)).toBe("SYD-2");
    expect(pickAdjacentRef(queue, "SYD-2", 1)).toBe("SYD-3");
  });

  it("steps backward from the current item", () => {
    expect(pickAdjacentRef(queue, "SYD-3", -1)).toBe("SYD-2");
    expect(pickAdjacentRef(queue, "SYD-2", -1)).toBe("SYD-1");
  });

  it("does not wrap past either end", () => {
    expect(pickAdjacentRef(queue, "SYD-3", 1)).toBeNull();
    expect(pickAdjacentRef(queue, "SYD-1", -1)).toBeNull();
  });
});

describe("countNewArrivals", () => {
  it("is zero when every item in the list is already queued", () => {
    expect(countNewArrivals(queue, queue)).toBe(0);
  });

  it("counts list items that aren't in the queue yet", () => {
    const list = [...queue, { ref: "SYD-4" }, { ref: "SYD-5" }];
    expect(countNewArrivals(list, queue)).toBe(2);
  });

  it("ignores queued items that have since left the list", () => {
    const list = [{ ref: "SYD-1" }];
    expect(countNewArrivals(list, queue)).toBe(0);
  });
});
