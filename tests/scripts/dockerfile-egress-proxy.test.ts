import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dockerfile = readFileSync(
  path.resolve(__dirname, "../../Dockerfile.egress-proxy"),
  "utf8",
);

describe("Dockerfile.egress-proxy (SYD-110)", () => {
  const lines = dockerfile.split("\n").map((l) => l.trim());

  it("switches to a non-root user before ENTRYPOINT (same posture as the worker image)", () => {
    const userIndex = lines.findIndex((l) => l.startsWith("USER "));
    const entryIndex = lines.findIndex((l) => l.startsWith("ENTRYPOINT"));
    expect(userIndex).toBeGreaterThan(-1);
    expect(entryIndex).toBeGreaterThan(userIndex);
    expect(lines[userIndex]).not.toBe("USER root");
  });

  it("uses the tested entry script as its entrypoint", () => {
    expect(dockerfile).toContain("scripts/egress-proxy-entry.sh");
    expect(lines.some((l) => l.startsWith("ENTRYPOINT") && l.includes("/entry.sh"))).toBe(true);
  });
});
