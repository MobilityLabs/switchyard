import { describe, it, expect } from "vitest";
import { projectKeyFromRef } from "./refs";

// SYD-132: projectKeyFromRef was implemented twice (router.ts + IssueDetail.tsx)
// before being consolidated here — every caller (router, IssueDetail, Triage,
// Review, Search) now shares this one implementation.
describe("projectKeyFromRef", () => {
  it("extracts the project key from a well-formed ref", () => {
    expect(projectKeyFromRef("SYD-132")).toBe("SYD");
  });

  it("extracts the key from a multi-letter project", () => {
    expect(projectKeyFromRef("ACME-1")).toBe("ACME");
  });

  it("returns the whole string when there is no hyphen", () => {
    expect(projectKeyFromRef("nohyphen")).toBe("nohyphen");
  });

  it("returns an empty string for an empty ref", () => {
    expect(projectKeyFromRef("")).toBe("");
  });
});
