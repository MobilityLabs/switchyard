#!/usr/bin/env node
// SYD-268: one resident node process per host service, without a tsx loader.
// #272: never compile into a directory a running service can import from.
// Each content-addressed generation is built privately, then published with
// one directory rename. Concurrent builders may do redundant work, but only
// a complete generation wins. There is no lock to strand after a crash.
//
// A launcher imports its exact generation, not a mutable "current" symlink.
// Retain old generations for running services' lazy imports; remove dist/server
// only when all host services are stopped. Legacy dist/server/scripts output
// is left untouched, but new launchers never use it.
//
// Usage:
//   node scripts/run-compiled.mjs <entry> [...args passed to the entry]
//   node scripts/run-compiled.mjs --build-only

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist", "server");
const require = createRequire(import.meta.url);
const entries = ["agent-worker", "deliver", "github-poll"];

function collectFiles(dir, extension, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, extension, out);
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
  }
}

/** Include both declared dependencies and the compiler actually installed. */
function computeSourceHash() {
  const files = [];
  for (const dir of ["scripts", "src"]) {
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      collectFiles(path.join(repoRoot, dir), extension, files);
    }
  }
  collectFiles(path.join(repoRoot, "scripts"), ".mjs", files);
  for (const extra of [
    "tsconfig.build.json",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
  ]) {
    files.push(path.join(repoRoot, extra));
  }
  // npm's installed-tree lock catches an install that differs from the root
  // lock. The compiler package and JS bytes also catch a compiler replaced in
  // place, even when neither lockfile was changed.
  const installedLock = path.join(repoRoot, "node_modules", ".package-lock.json");
  if (existsSync(installedLock)) files.push(installedLock);
  const compilerPackage = require.resolve("typescript/package.json");
  files.push(compilerPackage, require.resolve("typescript/bin/tsc"));
  collectFiles(path.join(path.dirname(compilerPackage), "lib"), ".js", files);

  const hash = createHash("sha256").update(`generation-v1\0${process.version}\0`);
  for (const file of files.sort()) {
    hash.update(path.relative(repoRoot, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** TypeScript does not emit the hand-written runtime sidecars it imports. */
function copyScriptAssets(staging) {
  const assets = [];
  collectFiles(path.join(repoRoot, "scripts"), ".mjs", assets);
  for (const source of assets) {
    const destination = path.join(staging, path.relative(repoRoot, source));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function readBuildInfo(dir, sourceHash) {
  try {
    const info = JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8"));
    return info.sourceHash === sourceHash &&
      entries.every((entry) => existsSync(path.join(dir, "scripts", `${entry}.js`)))
      ? info
      : null;
  } catch {
    return null;
  }
}

function gitHeadOf() {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Atomic informational pointer; imports always use the immutable generation. */
function publishBuildInfo(info) {
  const temporary = path.join(distDir, `.build-info-${randomUUID()}.json`);
  try {
    writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path.join(distDir, "build-info.json"));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensureBuilt() {
  const sourceHash = computeSourceHash();
  const generation = path.join(distDir, sourceHash);
  const existing = readBuildInfo(generation, sourceHash);
  if (existing) {
    publishBuildInfo(existing);
    return generation;
  }
  // An existing but incomplete generation is never overwritten: a running
  // process could already hold imports from it. Fail closed for operator repair.
  if (existsSync(generation)) {
    // A competing builder may have published between our first read and the
    // existence check. Re-read before treating this as a broken generation.
    const winner = readBuildInfo(generation, sourceHash);
    if (winner) {
      publishBuildInfo(winner);
      return generation;
    }
    throw new Error(`[run-compiled] invalid build generation: ${generation}`);
  }

  console.log("[run-compiled] compile inputs changed or missing — building a new generation...");
  mkdirSync(distDir, { recursive: true });
  const staging = mkdtempSync(path.join(distDir, ".building-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        path.join(repoRoot, "tsconfig.build.json"),
        "--outDir",
        staging,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(
        `[run-compiled] tsc failed (exit ${result.status ?? 1}); previous builds are untouched.`,
        { cause: result.error },
      );
    }
    copyScriptAssets(staging);
    if (computeSourceHash() !== sourceHash) {
      throw new Error("[run-compiled] compile inputs changed during the build; retry startup.");
    }
    const info = { sourceHash, builtAt: new Date().toISOString(), gitHead: gitHeadOf() };
    writeFileSync(path.join(staging, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
    if (!readBuildInfo(staging, sourceHash)) {
      throw new Error("[run-compiled] compiler did not produce every required host entry.");
    }
    try {
      renameSync(staging, generation);
    } catch (error) {
      // Another launcher can win the rename while we compile. A nonempty,
      // complete generation is immutable, so safely reuse that winner.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      if (!readBuildInfo(generation, sourceHash)) throw error;
    }
    publishBuildInfo(readBuildInfo(generation, sourceHash));
    console.log(`[run-compiled] built generation ${sourceHash.slice(0, 12)}...`);
    return generation;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const [, , first, ...rest] = process.argv;
  if (first === "--build-only") {
    ensureBuilt();
    return;
  }
  if (!entries.includes(first)) {
    throw new Error(
      "usage: node scripts/run-compiled.mjs <entry> [...args]\n" +
        "       node scripts/run-compiled.mjs --build-only\n" +
        `<entry> is one of: ${entries.join(", ")}`,
    );
  }
  const entryPath = path.join(ensureBuilt(), "scripts", `${first}.js`);
  // Preserve each entry's direct-invocation guard and argument parsing.
  process.argv = [process.argv[0], entryPath, ...rest];
  await import(pathToFileURL(entryPath).href);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
