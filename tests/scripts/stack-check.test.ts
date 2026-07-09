import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// scripts/stack-check.mjs is a session-start guard (SYD-76): it runs inside a
// containerized dispatch before `claude -p` starts, given STACK_CHECKS (JSON
// array of {name, check, install} built by stackChecksEnv). Exercised as a
// real subprocess here since its whole job is running shell commands and
// reporting their exit codes.
const scriptPath = path.resolve(__dirname, "../../scripts/stack-check.mjs");

function run(env: Record<string, string>) {
  return spawnSync("node", [scriptPath], { encoding: "utf8", env: { ...process.env, ...env } });
}

describe("stack-check.mjs", () => {
  it("exits 0 with no output when STACK_CHECKS is unset", () => {
    const res = run({ STACK_CHECKS: "" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("exits 0 when every declared check passes", () => {
    const res = run({ STACK_CHECKS: JSON.stringify([{ name: "true", check: "true" }]) });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("stack check passed (1 tool(s) verified)");
  });

  it("exits 1 and names the failing tool + its repair hint when a check fails", () => {
    const res = run({
      STACK_CHECKS: JSON.stringify([
        { name: "true", check: "true" },
        { name: "codex", check: "false", install: "npm install -g codex-cli" },
      ]),
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("FATAL: this session's stack is missing required tools");
    expect(res.stderr).toContain("codex");
    expect(res.stderr).toContain("npm install -g codex-cli");
    expect(res.stderr).not.toContain("- true:");
  });

  it("reports a missing tool without an install hint plainly", () => {
    const res = run({ STACK_CHECKS: JSON.stringify([{ name: "codex", check: "false" }]) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("codex: `false` failed");
    expect(res.stderr).not.toContain("repair:");
  });

  it("exits 1 with a clear message when STACK_CHECKS is not valid JSON", () => {
    const res = run({ STACK_CHECKS: "not json" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("FATAL: STACK_CHECKS is not valid JSON");
  });
});
