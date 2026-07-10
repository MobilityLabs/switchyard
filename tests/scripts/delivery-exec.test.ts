import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDeps } from "../../scripts/delivery-exec.js";

// SYD-101: the persistent deliver clone kept native modules (e.g.
// better-sqlite3) compiled for a node version the gate no longer runs,
// because `npm install` (the prior behavior) leaves already-installed
// packages alone and `git clean -fd` doesn't touch the gitignored
// node_modules dir. `npm ci` fixes this by deleting node_modules wholesale
// before installing -- this reproduces that exact scenario.
describe("installDeps", () => {
  it("wipes a stale node_modules before installing", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "delivery-exec-test-"));
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp-x", version: "1.0.0" }));
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "tmp-x", version: "1.0.0" } },
      })
    );
    const staleModule = path.join(workspace, "node_modules", "stale-native-module");
    mkdirSync(staleModule, { recursive: true });
    writeFileSync(path.join(staleModule, "binding.node"), "stale binary compiled for the wrong node ABI");

    await installDeps(workspace);

    expect(existsSync(staleModule)).toBe(false);
  });
});
