import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ESLint } from "eslint";

// SYD-140: adds eslint.config.js + .prettierrc.json and the lint/format
// scripts. These tests both document the config's intent (the two rules the
// issue called out by name) and guard against the whole-repo baseline
// drifting until CI wires `npm run lint` / `format:check` in for real
// (SYD-113).

const REPO_DIR = path.resolve(__dirname, "..");

describe("eslint config", () => {
  it("flags `any` as a warning", async () => {
    const eslint = new ESLint({ cwd: REPO_DIR });
    const [result] = await eslint.lintText("export const x: any = 1;\n", {
      filePath: "fixture.ts",
    });
    const msg = result.messages.find((m) => m.ruleId === "@typescript-eslint/no-explicit-any");
    expect(msg?.severity).toBe(1); // warn
  });

  it("flags non-null assertions as a warning", async () => {
    const eslint = new ESLint({ cwd: REPO_DIR });
    const [result] = await eslint.lintText(
      "export function f(x: string | null) { return x!.length; }\n",
      { filePath: "fixture.ts" },
    );
    const msg = result.messages.find(
      (m) => m.ruleId === "@typescript-eslint/no-non-null-assertion",
    );
    expect(msg?.severity).toBe(1); // warn
  });

  it("still catches real errors (e.g. a stray debugger statement)", async () => {
    const eslint = new ESLint({ cwd: REPO_DIR });
    const [result] = await eslint.lintText("export function f() {\n  debugger;\n}\n", {
      filePath: "fixture.ts",
    });
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("the repo lints clean (0 errors)", async () => {
    const eslint = new ESLint({ cwd: REPO_DIR });
    const results = await eslint.lintFiles(["."]);
    const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2));
    const summary = errors.map((m) => `${m.ruleId}: ${m.message}`).join("\n");
    expect(errors, summary).toHaveLength(0);
  }, 30000);
});

describe("prettier", () => {
  it("the repo is fully formatted", () => {
    expect(() =>
      execFileSync("npx", ["prettier", "--check", "."], { cwd: REPO_DIR, stdio: "pipe" }),
    ).not.toThrow();
  }, 30000);
});
