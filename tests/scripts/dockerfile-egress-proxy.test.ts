import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dockerfile = readFileSync(path.resolve(__dirname, "../../Dockerfile.egress-proxy"), "utf8");

describe("Dockerfile.egress-proxy (SYD-186)", () => {
  const lines = dockerfile.split("\n").map((l) => l.trim());

  it("runs as a non-root user at runtime (same posture as the worker image)", () => {
    // The image may switch to root to place files, so assert the *effective*
    // runtime user — the last USER before ENTRYPOINT — is non-root.
    const entryIndex = lines.findIndex((l) => l.startsWith("ENTRYPOINT"));
    expect(entryIndex).toBeGreaterThan(-1);
    const userLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => l.startsWith("USER ") && i < entryIndex);
    expect(userLines.length).toBeGreaterThan(0);
    const runtimeUser = userLines[userLines.length - 1].l;
    expect(runtimeUser).not.toBe("USER root");
  });

  it("uses the tested entry script as its entrypoint", () => {
    expect(dockerfile).toContain("scripts/egress-proxy-entry.sh");
    expect(lines.some((l) => l.startsWith("ENTRYPOINT") && l.includes("/entry.sh"))).toBe(true);
  });

  it("is built on mitmproxy and ships the injection addon", () => {
    expect(lines.some((l) => l.startsWith("FROM mitmproxy/mitmproxy"))).toBe(true);
    expect(dockerfile).toContain("scripts/egress-inject-addon.py");
  });

  it("persists the CA directory as a volume so it survives sidecar recreation", () => {
    expect(dockerfile).toContain("/home/mitmproxy/.mitmproxy");
    expect(lines.some((l) => l.startsWith("VOLUME"))).toBe(true);
  });
});
