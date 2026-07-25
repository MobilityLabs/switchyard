import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { enforceNodeEngines } from "./scripts/init-worker-lib.js";

// SYD-97: Node 25's built-in WebStorage globals shadow vitest's jsdom
// environment (`TypeError: localStorage.clear is not a function`), producing
// spurious red runs on an otherwise-green commit. Node 25 is unsupported.
// SYD-200: a warning alone let the run continue into that noisy failure log
// instead of stopping cold on the actual root cause — exit non-zero here,
// before Vitest starts collecting anything.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
enforceNodeEngines(pkg.engines?.node, process.version, {
  error: console.error,
  exit: process.exit,
});

export default defineConfig({
  test: { include: ["tests/**/*.test.{ts,mjs}", "ui/src/**/*.test.{ts,tsx}"] },
});
