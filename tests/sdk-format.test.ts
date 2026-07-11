import { describe, expect, it } from "vitest";
import { formatSdkEvent } from "../worker-sdk/sdk-format.js";

describe("formatSdkEvent", () => {
  it("logs session start", () => {
    expect(formatSdkEvent({ type: "system", subtype: "init" })).toBe("[sdk] session started");
    expect(formatSdkEvent({ type: "system", subtype: "compact" })).toBeNull();
  });

  it("logs tool calls by name, preferring tools over text", () => {
    const line = formatSdkEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me claim it." },
          { type: "tool_use", name: "mcp__switchyard__claim_issue" },
          { type: "tool_use", name: "Bash" },
        ],
      },
    });
    expect(line).toBe("[sdk] tool: mcp__switchyard__claim_issue, Bash");
  });

  it("truncates long assistant text and skips empty messages", () => {
    const long = "x".repeat(300);
    expect(
      formatSdkEvent({ type: "assistant", message: { content: [{ type: "text", text: long }] } }),
    ).toBe(`[sdk] ${"x".repeat(200)}…`);
    expect(formatSdkEvent({ type: "assistant", message: { content: [] } })).toBeNull();
  });

  it("logs the result with turns and cost, and ignores user events", () => {
    expect(
      formatSdkEvent({ type: "result", subtype: "success", num_turns: 12, total_cost_usd: 0.5432 }),
    ).toBe("[sdk] result: success turns=12 cost=$0.5432");
    expect(formatSdkEvent({ type: "user" })).toBeNull();
  });
});
