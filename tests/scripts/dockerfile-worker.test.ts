import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SYD-117: the dispatch image must drop root before the entrypoint runs, so
// a compromised session (and any host-side writes through the /origin bind
// mount) never run as root.
describe("Dockerfile.worker non-root user (SYD-117)", () => {
  const lines = readFileSync(path.join(__dirname, "../../Dockerfile.worker"), "utf8")
    .split("\n")
    .map((l) => l.trim());

  it("switches to a non-root user before ENTRYPOINT", () => {
    const userIndex = lines.findIndex((l) => l.startsWith("USER "));
    const entrypointIndex = lines.findIndex((l) => l.startsWith("ENTRYPOINT "));
    expect(userIndex).toBeGreaterThan(-1);
    expect(entrypointIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeLessThan(entrypointIndex);
    expect(lines[userIndex]).not.toBe("USER root");
  });

  it("does not switch back to root after the USER directive", () => {
    const userIndex = lines.findIndex((l) => l.startsWith("USER "));
    expect(lines.slice(userIndex + 1).some((l) => l === "USER root")).toBe(false);
  });
});
