#!/usr/bin/env node
// Wraps `npm ci` for containerized dispatch (SYD-81, following up on SYD-80
// action item 4: a piano-game container dispatch hit an `npm ci` "usage
// error" and there was no way to diagnose it after the fact -- the log just
// showed the WARNING, with no clue which of npm's several EUSAGE cases fired
// or what node/npm version produced it).
//
// The most likely cause: `git clone /origin /work` (container-entry.sh) only
// carries committed files. If a target repo doesn't commit its
// package-lock.json, the clone silently loses it, and `npm ci` fails with
// "npm error code EUSAGE ... can only install with an existing
// package-lock.json" -- reproduced locally (no Docker needed) with just a
// package.json and no lockfile. This script checks for that case up front
// instead of letting it surface as an opaque usage error, and for any other
// npm ci failure, logs the node/npm version so a future occurrence is
// diagnosable from the log alone.
//
// Kept as a standalone script (rather than inlined in container-entry.sh) so
// it's unit-testable without a container -- same pattern as
// prime-workspace-trust.mjs (SYD-80).
//
// Usage: node npm-ci-guard.mjs <workspace-path>
// Always exits 0: a failed/skipped install is non-fatal here, matching the
// prior `npm ci || echo WARNING ...` behavior in container-entry.sh -- a
// worker session missing its deps will fail its own task anyway, with a
// clearer signal now than before.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: npm-ci-guard.mjs <workspace-path>");
  process.exit(1);
}

const hasLockfile =
  existsSync(`${workspace}/package-lock.json`) || existsSync(`${workspace}/npm-shrinkwrap.json`);

if (!hasLockfile) {
  console.error(
    "WARNING: npm ci skipped -- no package-lock.json or npm-shrinkwrap.json in this clone " +
      "(git clone only carries committed files, so an untracked lockfile in the target repo " +
      "disappears here) -- continuing without installed dependencies",
  );
  process.exit(0);
}

try {
  execFileSync("npm", ["ci"], { cwd: workspace, stdio: "inherit" });
} catch {
  let npmVersion = "unknown";
  try {
    npmVersion = execFileSync("npm", ["--version"], { cwd: workspace }).toString().trim();
  } catch {
    // npm --version failing too is itself informative -- leave "unknown".
  }
  console.error(
    `WARNING: npm ci failed (node ${process.version}, npm ${npmVersion}) -- continuing without ` +
      "installed dependencies. Compare the target repo's package.json engines/packageManager " +
      "field against this image's node/npm version (see Dockerfile.worker).",
  );
}
