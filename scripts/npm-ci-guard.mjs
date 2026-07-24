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

const hasNpmLock =
  existsSync(`${workspace}/package-lock.json`) || existsSync(`${workspace}/npm-shrinkwrap.json`);
const hasYarnLock = existsSync(`${workspace}/yarn.lock`);
const hasPnpmLock = existsSync(`${workspace}/pnpm-lock.yaml`);

if (!hasNpmLock && !hasYarnLock && !hasPnpmLock) {
  console.error(
    "WARNING: dependency installation skipped -- no package-lock.json, npm-shrinkwrap.json, yarn.lock, or pnpm-lock.yaml in this clone " +
      "(git clone only carries committed files, so an untracked lockfile in the target repo " +
      "disappears here) -- continuing without installed dependencies",
  );
  process.exit(0);
}

// SYD-110: dependency installation runs third-party lifecycle scripts before the session
// starts — with the worker's secrets still in env, one compromised
// transitive dep exfiltrates them with zero agent involvement. Strip the
// secrets for the install; native-module builds (the reason we don't use
// --ignore-scripts) don't need them.
const SECRET_VARS = ["SWITCHYARD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const sanitizedEnv = { ...process.env };
for (const key of SECRET_VARS) delete sanitizedEnv[key];

let packageManager = "npm";
let installArgs = ["ci"];

if (hasNpmLock) {
  packageManager = "npm";
  installArgs = ["ci"];
} else if (hasYarnLock) {
  packageManager = "yarn";
  installArgs = ["install", "--frozen-lockfile"];
} else if (hasPnpmLock) {
  packageManager = "pnpm";
  installArgs = ["install", "--frozen-lockfile"];
}

try {
  execFileSync(packageManager, installArgs, { cwd: workspace, stdio: "inherit", env: sanitizedEnv });
} catch {
  let pmVersion = "unknown";
  try {
    pmVersion = execFileSync(packageManager, ["--version"], { cwd: workspace }).toString().trim();
  } catch {
    // version command failing too is itself informative -- leave "unknown".
  }
  console.error(
    `WARNING: ${packageManager} install failed (node ${process.version}, ${packageManager} ${pmVersion}) -- continuing without ` +
      "installed dependencies. Compare the target repo's package.json engines/packageManager " +
      "field against this image's node/npm/yarn/pnpm version (see Dockerfile.worker).",
  );
}
