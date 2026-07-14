#!/usr/bin/env -S npx tsx
// Executable wrapper for the worker-parity preflight (SYD-166): `npm run
// verify` before done-stamping an issue, so environment-sensitive failures
// (wrong node major, local-TZ-dependent tests) surface inside the session
// instead of as a post-delivery bounce. Decision logic and the step list
// live in verify-worker-parity-lib.ts (unit-tested there) — this file only
// wires it to a real package.json read and real process spawning.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ciMirrorSteps,
  nodeVersionMismatchMessage,
  readEnginesNode,
  runVerifySteps,
  WORKER_TZ,
} from "./verify-worker-parity-lib.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const pkgJsonRaw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const mismatch = nodeVersionMismatchMessage(readEnginesNode(pkgJsonRaw), process.version);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }

  const outcome = runVerifySteps(
    ciMirrorSteps(),
    (cmd, args, opts) => {
      console.log(`\n> ${cmd} ${args.join(" ")}`);
      return spawnSync(cmd, args, { ...opts, stdio: "inherit" });
    },
    { cwd: repoRoot, env: process.env },
  );

  if (!outcome.ok) {
    console.error(
      `\nFAILED: ${outcome.failedStep} — this is what CI would report too ` +
        `(worker-parity verify, node ${process.version}, TZ=${WORKER_TZ})`,
    );
    process.exit(outcome.exitCode);
  }

  console.log(`\nworker-parity verify passed (node ${process.version}, TZ=${WORKER_TZ})`);
}

main();
