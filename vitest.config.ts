import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { nodeVersionSatisfiesEngines } from "./scripts/init-worker-lib.js";

// SYD-97: Node 25's built-in WebStorage globals shadow vitest's jsdom
// environment (`TypeError: localStorage.clear is not a function`), producing
// spurious red runs on an otherwise-green commit. Node 25 is unsupported —
// warn loudly instead of leaving a future run to debug that mystery cold.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const enginesNode: string | undefined = pkg.engines?.node;
if (enginesNode && !nodeVersionSatisfiesEngines(enginesNode, process.version)) {
  console.warn(
    `\n⚠ running tests under node ${process.version}, outside the supported engines.node range "${enginesNode}". ` +
      `See .nvmrc and SYD-97 — a failure here may be a node-version artifact, not a real regression.\n`,
  );
}

export default defineConfig({
  test: { include: ["tests/**/*.test.{ts,mjs}", "ui/src/**/*.test.{ts,tsx}"] },
});
