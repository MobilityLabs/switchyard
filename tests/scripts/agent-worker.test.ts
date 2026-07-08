import { describe, it, expect } from "vitest";
import { buildPrompt } from "../../scripts/agent-worker.js";

describe("buildPrompt", () => {
  it("builds the standard work prompt", () => {
    const prompt = buildPrompt("SYD-7");
    expect(prompt).toContain("SYD-7");
    expect(prompt).toContain("claim_issue");
    expect(prompt).toContain("in_review");
    expect(prompt).not.toMatch(/escalat/i);
  });

  it("primes a resumed session to read the human's answer in the activity feed", () => {
    const prompt = buildPrompt("SYD-7", { resumed: true });
    expect(prompt).toContain("SYD-7");
    expect(prompt).toMatch(/escalat/i);
    expect(prompt).toMatch(/answer/i);
    expect(prompt).toMatch(/get_issue|activity/i);
  });
});
