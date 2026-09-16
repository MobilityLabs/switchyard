#!/usr/bin/env node
// SYD-268: launcher for the compiled host scripts (dist/server/scripts/*.js).
//
// Plain JS on purpose — this file is never itself compiled, so it needs no
// build step to run. It exists so launchd runs one plain `node` process per
// service (node -> run-compiled.mjs -> dist/server/scripts/<entry>.js)
// instead of the old node -> tsx shim -> node+esbuild loader chain, without
// ever risking a worker that silently runs month-old compiled code:
//
//   1. compute a content hash over the compile inputs (every .ts under
//      scripts/ and src/, plus tsconfig.build.json, tsconfig.json,
//      package.json),
//   2. compare it to dist/server/build-info.json's `sourceHash`,
//   3. if missing or different, run `tsc -p tsconfig.build.json`
//      synchronously (a transient child that exits before the service
//      starts) and write a fresh build-info.json,
//   4. `await import()` dist/server/scripts/<entry>.js in this same
//      process — one resident node process, never stale.
//
// `npm run build:server` (and CI) share this exact logic via `--build-only`,
// so a manual/CI build and a launchd-triggered build produce byte-identical
// build-info.json semantics.
//
// Usage:
//   node scripts/run-compiled.mjs <entry> [...args passed to the entry]
//   node scripts/run-compiled.mjs --build-only

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This file lives directly in scripts/ and is never compiled/moved, so one
// level up is always the real repo root — unlike the repoRoot() helpers in
// the compiled entries themselves, which have to handle two possible layouts.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist", "server");
const buildInfoPath = path.join(distDir, "build-info.json");

const require = createRequire(import.meta.url);

/** Recursively collects every `.ts` file under `dir`, skipping `node_modules` and dotdirs. */
function collectTsFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist (e.g. a fresh checkout with no src/ yet) — nothing to hash
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
}

/**
 * Content hash over the compile inputs (SYD-268): every `.ts` under
 * `scripts/` and `src/`, plus the three config files whose contents change
 * what tsc emits. `worker-sdk/` is deliberately excluded — it's never
 * compiled (see scripts/agent-worker.ts's dispatchSdk), so a change there
 * doesn't need to trigger a dist/server rebuild.
 */
function computeSourceHash() {
  const files = [];
  collectTsFiles(path.join(repoRoot, "scripts"), files);
  collectTsFiles(path.join(repoRoot, "src"), files);
  for (const extra of ["tsconfig.build.json", "tsconfig.json", "package.json"]) {
    files.push(path.join(repoRoot, extra));
  }

  const relPaths = files.map((f) => path.relative(repoRoot, f).split(path.sep).join("/")).sort();

  const hash = createHash("sha256");
  for (const rel of relPaths) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(repoRoot, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readBuildInfo() {
  if (!existsSync(buildInfoPath)) return null;
  try {
    return JSON.parse(readFileSync(buildInfoPath, "utf8"));
  } catch {
    return null; // corrupt/partial build-info.json — treat like "no build yet"
  }
}

function gitHeadOf() {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Runs `tsc -p tsconfig.build.json` synchronously. Returns its exit code. */
function runTsc() {
  const tscBin = require.resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [tscBin, "-p", path.join(repoRoot, "tsconfig.build.json")],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  return result.status ?? 1;
}

/**
 * Builds dist/server if its build-info.json is missing or stale (SYD-268's
 * staleness guard). Exits the process with a clear message if the compile
 * fails — a worker must never silently start against a half-built or
 * month-old dist/server.
 */
function ensureBuilt() {
  const sourceHash = computeSourceHash();
  const existing = readBuildInfo();
  if (existing && existing.sourceHash === sourceHash) {
    return { rebuilt: false, sourceHash };
  }

  console.log(
    existing
      ? "[run-compiled] source changed since the last compiled build — rebuilding dist/server..."
      : "[run-compiled] no compiled build found — building dist/server...",
  );
  const code = runTsc();
  if (code !== 0) {
    console.error(
      `\n[run-compiled] FATAL: \`tsc -p tsconfig.build.json\` failed (exit ${code}). ` +
        "Fix the compile error above — a stale or half-built dist/server must never run.\n",
    );
    process.exit(code || 1);
  }

  mkdirSync(distDir, { recursive: true });
  const buildInfo = { sourceHash, builtAt: new Date().toISOString(), gitHead: gitHeadOf() };
  writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  console.log(`[run-compiled] built dist/server (sourceHash ${sourceHash.slice(0, 12)}...)`);
  return { rebuilt: true, sourceHash };
}

async function main() {
  const [, , first, ...rest] = process.argv;

  if (first === "--build-only") {
    ensureBuilt();
    return;
  }

  if (!first || first.startsWith("-")) {
    console.error(
      "usage: node scripts/run-compiled.mjs <entry> [...args]\n" +
        "       node scripts/run-compiled.mjs --build-only\n" +
        "<entry> is one of: agent-worker, deliver, github-poll",
    );
    process.exit(1);
  }

  ensureBuilt();

  const entryPath = path.join(distDir, "scripts", `${first}.js`);
  if (!existsSync(entryPath)) {
    console.error(
      `[run-compiled] compiled entry not found: ${entryPath}\n` +
        `(expected "${first}" to be one of agent-worker, deliver, github-poll)`,
    );
    process.exit(1);
  }

  // The entry module's own `if (import.meta.url === \`file://${process.argv[1]}\`)`
  // guard (its equivalent of "am I the thing node was invoked on") — and its
  // own `process.argv.slice(2)` argv parsing — both assume node was invoked
  // directly on it. Since we're dynamically importing it instead, rewrite
  // argv so both keep working unmodified: argv[1] becomes the compiled
  // entry's own path, and everything after the entry name on our own argv
  // becomes what the entry sees after its own path.
  process.argv = [process.argv[0], entryPath, ...rest];

  await import(pathToFileURL(entryPath).href);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
