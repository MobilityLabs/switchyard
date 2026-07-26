#!/usr/bin/env node
// Wraps the target repo's frozen dependency install for containerized
// dispatch (SYD-81, generalized beyond npm by SYD-255/SYD-253). Originally
// npm-only: a piano-game container dispatch hit an `npm ci` "usage error" and
// there was no way to diagnose it after the fact -- the log just showed the
// WARNING, with no clue which of npm's several EUSAGE cases fired or what
// node/npm version produced it.
//
// The most likely cause of a *missing* lockfile at this point: `git clone
// /origin /work` (container-entry.sh) only carries committed files. If a
// target repo doesn't commit its lockfile, the clone silently loses it --
// reproduced locally (no Docker needed) with just a package.json and no
// lockfile.
//
// SYD-253: dispatching into a yarn repo (hexdi/HEX) started the session with
// no node_modules. SYD-255 taught this script to detect yarn/pnpm lockfiles,
// which fixed that report -- the base image bundles yarn classic. Two ways to
// land in the same silent no-dependencies state remained, though: pnpm repos
// had no pnpm binary to dispatch *to* (now installed in the Dockerfiles), and
// this script picks yarn's frozen-install flag by major version, because
// classic and berry disagree about its name, and getting it wrong breaks in
// both directions (both verified by running the real binaries):
//   - berry 4.5.0 exits 1 on --frozen-lockfile: "YN0050: The
//     --frozen-lockfile option is deprecated; use --immutable and/or
//     --immutable-cache instead" -- so a berry repo installs nothing.
//   - classic 1.22.22 *ignores* the unknown --immutable and rewrites the
//     lockfile anyway ("success Saved lockfile", exit 0) -- so the install
//     silently stops being frozen, which is the failure this guard exists to
//     prevent.
//
// Kept as a standalone script (rather than inlined in container-entry.sh) so
// it's unit-testable without a container -- same pattern as
// prime-workspace-trust.mjs (SYD-80).
//
// Usage: node install-guard.mjs <workspace-path>
// Always exits 0: a failed/skipped install is non-fatal here, matching the
// prior `npm ci || echo WARNING ...` behavior in container-entry.sh -- a
// worker session missing its deps will fail its own task anyway, with a
// clearer signal now than before.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Yarn's frozen-install flag, chosen by major version. Berry (>=2) replaced
 * --frozen-lockfile with --immutable. The repo's `packageManager` field is
 * Corepack's own source of truth so it wins; otherwise fall back to the
 * presence of .yarnrc.yml, which only berry reads.
 */
export function yarnInstallArgs(dir) {
  let pinnedMajor = null;
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    if (typeof pkg.packageManager === "string") {
      pinnedMajor = pkg.packageManager.match(/^yarn@(\d+)/)?.[1] ?? null;
    }
  } catch {
    // Unreadable/invalid package.json -- fall through to the .yarnrc.yml
    // heuristic. (The install itself will surface the real problem.)
  }
  const isBerry = pinnedMajor ? Number(pinnedMajor) >= 2 : existsSync(`${dir}/.yarnrc.yml`);
  return isBerry ? ["install", "--immutable"] : ["install", "--frozen-lockfile"];
}

const INSTALLERS = [
  { command: "npm", lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], args: () => ["ci"] },
  { command: "yarn", lockfiles: ["yarn.lock"], args: yarnInstallArgs },
  { command: "pnpm", lockfiles: ["pnpm-lock.yaml"], args: () => ["install", "--frozen-lockfile"] },
];

/** The installer matching whichever lockfile the clone carries, npm first. */
export function detectInstaller(dir) {
  return INSTALLERS.find((installer) =>
    installer.lockfiles.some((lockfile) => existsSync(`${dir}/${lockfile}`)),
  );
}

function main(workspace) {
  if (!workspace) {
    console.error("usage: install-guard.mjs <workspace-path>");
    process.exit(1);
  }

  const installer = detectInstaller(workspace);
  if (!installer) {
    console.error(
      "WARNING: dependency installation skipped -- no package-lock.json, npm-shrinkwrap.json, " +
        "yarn.lock, or pnpm-lock.yaml in this clone (git clone only carries committed files, so " +
        "an untracked lockfile in the target repo disappears here) -- continuing without " +
        "installed dependencies",
    );
    process.exit(0);
  }

  // SYD-110: a frozen install runs third-party lifecycle scripts before the
  // session starts — with the worker's secrets still in env, one compromised
  // transitive dep exfiltrates them with zero agent involvement. Strip the
  // secrets for the install; native-module builds (the reason we don't use
  // --ignore-scripts) don't need them. Applies to all three installers --
  // yarn's and pnpm's lifecycle scripts have the same exposure as npm's.
  const SECRET_VARS = ["SWITCHYARD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  const sanitizedEnv = { ...process.env };
  for (const key of SECRET_VARS) delete sanitizedEnv[key];

  const args = installer.args(workspace);

  try {
    execFileSync(installer.command, args, {
      cwd: workspace,
      stdio: "inherit",
      env: sanitizedEnv,
    });
  } catch {
    let version = "unknown";
    try {
      version = execFileSync(installer.command, ["--version"], { cwd: workspace })
        .toString()
        .trim();
    } catch {
      // The version probe failing too is itself informative (tool absent, or
      // a corepack shim tripping over the workspace) -- leave "unknown".
    }
    console.error(
      `WARNING: ${installer.command} ${args.join(" ")} failed (node ${process.version}, ` +
        `${installer.command} ${version}) -- continuing without installed dependencies. Compare ` +
        "the target repo's package.json engines/packageManager field against this image's node/" +
        `${installer.command} version (see Dockerfile.worker).`,
    );
  }
}

// Run only when invoked as a script, so the helpers above stay importable
// from tests without triggering an install.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
