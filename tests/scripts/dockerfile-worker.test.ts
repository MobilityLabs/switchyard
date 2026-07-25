import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SYD-224: better-sqlite3's prebuild-install fetch can't reach github.com
// inside the worker egress allowlist, so it must fall back to `node-gyp
// rebuild --release` -- which needs a C/C++ toolchain baked into the image.
describe.each([
  ["Dockerfile.worker", "../../Dockerfile.worker"],
  ["Dockerfile.worker.codex", "../../Dockerfile.worker.codex"],
  ["Dockerfile.worker.gemini", "../../Dockerfile.worker.gemini"],
])("%s native module toolchain (SYD-224)", (_name, relPath) => {
  const raw = readFileSync(path.join(__dirname, relPath), "utf8");
  const aptInstallLine = raw.split("\n").find((l) => l.includes("apt-get install"));

  it("installs python3, make, and g++ alongside git/ca-certificates", () => {
    expect(aptInstallLine).toBeDefined();
    expect(aptInstallLine).toContain("python3");
    expect(aptInstallLine).toContain("make");
    expect(aptInstallLine).toContain("g++");
  });
});

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

describe("Dockerfile.worker attachment uploader (SYD-182)", () => {
  const raw = readFileSync(path.join(__dirname, "../../Dockerfile.worker"), "utf8");
  const lines = raw.split("\n").map((l) => l.trim());
  const userIndex = lines.findIndex((l) => l.startsWith("USER "));

  it("copies attach.mjs into the image before dropping root", () => {
    const copyIndex = lines.findIndex(
      (l) => l.startsWith("COPY ") && l.includes("scripts/attach.mjs"),
    );
    expect(copyIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeLessThan(userIndex);
  });

  it("installs a switchyard-attach launcher on PATH", () => {
    expect(raw).toContain("/usr/local/bin/switchyard-attach");
  });
});

// SYD-198: an unpinned `npm install -g @anthropic-ai/claude-code` lets a
// rebuild silently pick up a different CLI version with no repo diff.
describe("Dockerfile.worker pinned CLI version (SYD-198)", () => {
  const raw = readFileSync(path.join(__dirname, "../../Dockerfile.worker"), "utf8");

  it("declares a CLAUDE_CODE_VERSION build arg with a pinned default", () => {
    const match = raw.match(/^ARG CLAUDE_CODE_VERSION=(\S+)$/m);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("installs the CLI at the pinned version, not unpinned latest", () => {
    expect(raw).toContain("npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}");
    expect(raw).not.toMatch(/npm install -g @anthropic-ai\/claude-code\s*(&&|$)/m);
  });

  it("records the installed version in build output", () => {
    expect(raw).toContain("claude --version");
  });
});
