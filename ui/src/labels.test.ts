import { describe, it, expect } from "vitest";
import { parseLabels } from "./labels";

describe("parseLabels", () => {
  it("trims, dedupes, and preserves order", () => {
    expect(parseLabels(" backend, urgent , backend ,frontend")).toEqual(["backend", "urgent", "frontend"]);
  });

  it("drops empty entries", () => {
    expect(parseLabels("backend,, ,frontend")).toEqual(["backend", "frontend"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseLabels("")).toEqual([]);
  });
});
