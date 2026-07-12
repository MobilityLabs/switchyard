import { describe, it, expect } from "vitest";
import { attentionChip } from "./attention";

describe("attentionChip", () => {
  it("returns null when there is no attention", () => {
    expect(attentionChip(null)).toBeNull();
  });

  it("renders delivery_failed as a danger chip", () => {
    const chip = attentionChip({ reason: "delivery_failed", message: "boom" });
    expect(chip).toEqual({ label: "⛔ delivery failed", className: "badge danger" });
  });

  it("renders each deviation as a warn chip", () => {
    expect(attentionChip({ reason: "open_pr_not_in_review", message: "x" })).toEqual({
      label: "⚠ PR open — move to review",
      className: "badge warn",
    });
    expect(attentionChip({ reason: "merged_pr_not_done", message: "x" })).toEqual({
      label: "⚠ merged — stamp done",
      className: "badge warn",
    });
    expect(attentionChip({ reason: "stale_claim", message: "x" })).toEqual({
      label: "⚠ claim going stale",
      className: "badge warn",
    });
  });
});
