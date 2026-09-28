// The only writable host mount exposed to a container is a disposable bare
// repository. Its parent contains host-owned recovery metadata and is NEVER
// mounted. Git must never execute against the worker-writable repository on
// the host: even its config, refs and object directories are untrusted input.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  readSync,
  writeSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { WorkerConfig, WorkerProject } from "./worker-select.js";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_OBJECT_FILES = 100_000;

const refSchema = z.string().regex(/^[A-Z]{2,10}-\d+$/);
const oidSchema = z.string().regex(/^[0-9a-f]{40}$/);
const stateSchema = z.object({
  ref: refSchema,
  base: oidSchema,
  previous: oidSchema.nullable(),
});

function directory(repo: string, config: WorkerConfig, ref: string): string {
  refSchema.parse(ref);
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        path.resolve(repo),
        config.url,
        config.label,
        config.token ?? "SWITCHYARD_TOKEN",
      ]),
    )
    .digest("hex");
  return path.join(os.homedir(), ".switchyard", "worker-exchanges", scope, ref);
}

export function hasWorkerExchange(repo: string, config: WorkerConfig, ref: string): boolean {
  return existsSync(directory(repo, config, ref));
}

export function workerExchangeRepo(repo: string, config: WorkerConfig, ref: string): string {
  return path.join(directory(repo, config, ref), "origin.git");
}

// Do not inherit alternate object databases, injected -c options, replace
// refs or user/system config. Host repository configuration stays host-owned.
function git(repo: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-C",
      repo,
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function optionalHead(repo: string, ref: string): string | null {
  const value = git(repo, ["for-each-ref", "--format=%(objectname)", ref]);
  return value ? oidSchema.parse(value) : null;
}

function checkTrackedSecrets(repo: string, refs: string[]): void {
  // Exported Git history is source data, not a secret store. Fail closed for
  // known host-only paths, including historical versions. Example env files
  // remain usable. This is deliberately not a general credential scanner.
  const forbidden = git(repo, [
    "log",
    "--format=",
    "--full-history",
    "-m",
    "--name-only",
    "-z",
    ...refs,
    "--",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.development",
    ".env.development.local",
    ".env.staging",
    ".env.staging.local",
    ".superpowers",
    "switchyard-worker.json",
  ])
    .split("\0")
    .map((name) => name.trim())
    .find(Boolean);
  if (forbidden)
    throw new Error(
      `worker exchange refuses tracked host-only path: ${forbidden}; remove it from exported history before dispatch`,
    );
}

export function prepareWorkerExchange(
  project: WorkerProject,
  config: WorkerConfig,
  ref: string,
): string {
  const dir = directory(project.repo, config, ref);
  const relative = path.relative(realpathSync(project.repo), path.resolve(dir));
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    throw new Error("worker exchange must live outside the host checkout");
  if (existsSync(dir))
    throw new Error(
      `unfinished worker exchange for ${ref}; recover its publication before redispatch`,
    );
  const branch = `refs/heads/agent/${ref}`;
  const baseRef = `refs/heads/${project.baseBranch ?? "main"}`;
  git(project.repo, ["check-ref-format", baseRef]);
  const base = oidSchema.parse(git(project.repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]));
  const previous = optionalHead(project.repo, branch);
  const refs = [baseRef, ...(previous ? [branch] : [])];
  checkTrackedSecrets(project.repo, refs);
  mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const exchange = workerExchangeRepo(project.repo, config, ref);
  try {
    const bundle = path.join(dir, "seed.bundle");
    git(project.repo, ["bundle", "create", bundle, ...refs]);
    mkdirSync(exchange);
    git(exchange, ["init", "--bare", "--template="]);
    git(exchange, ["fetch", "--no-tags", bundle, ...refs.map((r) => `${r}:${r}`)]);
    git(exchange, ["symbolic-ref", "HEAD", baseRef]);
    rmSync(bundle);
    // Linux bind mounts preserve UIDs. Only the mounted exchange is writable
    // by the image's non-root UID; its parent and recovery state remain 0700.
    function writable(root: string): void {
      for (const item of readdirSync(root, { withFileTypes: true })) {
        const name = path.join(root, item.name);
        if (item.isDirectory()) writable(name);
        else chmodSync(name, 0o666);
      }
      chmodSync(root, 0o777);
    }
    writable(exchange);
    writeFileSync(
      path.join(dir, "state.json.tmp"),
      JSON.stringify({ ref, base, previous }) + "\n",
      {
        mode: 0o600,
        flush: true,
      },
    );
    renameSync(path.join(dir, "state.json.tmp"), path.join(dir, "state.json"));
    return exchange;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// The container has exited before these reads. Reject symlinks on EVERY path
// component; O_NOFOLLOW also protects the leaf. Do not open FIFOs/devices.
function openRegularFile(root: string, relative: string): number | null {
  let current = root;
  if (!lstatSync(current).isDirectory()) throw new Error("worker exchange root is not a directory");
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error(`unsafe worker exchange directory: ${relative}`);
    } else if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`unsafe worker exchange file: ${relative}`);
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`unsafe worker exchange file: ${relative}`);
  }
  return fd;
}

function regularFile(root: string, relative: string): Buffer | null {
  const fd = openRegularFile(root, relative);
  if (fd === null) return null;
  try {
    if (fstatSync(fd).size > MAX_METADATA_BYTES)
      throw new Error("worker exchange metadata exceeds size limit");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function outputHead(exchange: string, ref: string): string | null {
  const name = `refs/heads/agent/${ref}`;
  const loose = regularFile(exchange, name);
  if (loose) return oidSchema.parse(loose.toString("utf8").trim());
  const packed = regularFile(exchange, "packed-refs");
  const line = packed
    ?.toString("utf8")
    .split("\n")
    .find((line) => line.endsWith(` ${name}`));
  return line ? oidSchema.parse(line.split(" ")[0]) : null;
}

function copyObjects(exchange: string, quarantine: string): void {
  let bytesLeft = MAX_IMPORT_BYTES;
  let filesLeft = MAX_OBJECT_FILES;
  const buffer = Buffer.alloc(1024 * 1024);
  const objectDir = path.join(exchange, "objects");
  if (!lstatSync(objectDir).isDirectory())
    throw new Error("unsafe worker exchange objects directory");
  for (const dir of readdirSync(objectDir)) {
    if (dir === "info") continue; // Never copy alternates, commit-graphs or paths.
    if (dir !== "pack" && !/^[0-9a-f]{2}$/.test(dir))
      throw new Error("unexpected worker object directory");
    const source = path.join(objectDir, dir);
    if (!lstatSync(source).isDirectory()) throw new Error("unsafe worker object directory");
    const dest = path.join(quarantine, "objects", dir);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(source)) {
      if (dir === "pack" && !/^pack-[0-9a-f]{40}\.(pack|idx)$/.test(name)) continue;
      if (dir !== "pack" && !/^[0-9a-f]{38}$/.test(name))
        throw new Error("unexpected loose Git object");
      if (--filesLeft < 0) throw new Error("worker exchange exceeds object count limit");
      const fd = openRegularFile(exchange, `objects/${dir}/${name}`);
      if (fd === null) throw new Error("worker object disappeared during import");
      let output: number | undefined;
      try {
        const size = fstatSync(fd).size;
        if (size > bytesLeft) throw new Error("worker exchange exceeds 2 GiB import size limit");
        bytesLeft -= size;
        output = openSync(path.join(dest, name), "wx", 0o600);
        let copied = 0;
        for (;;) {
          const count = readSync(fd, buffer);
          if (!count) break;
          copied += count;
          if (copied > size) throw new Error("worker object changed during import");
          let written = 0;
          while (written < count) written += writeSync(output, buffer, written, count - written);
        }
        if (copied !== size) throw new Error("worker object changed during import");
      } finally {
        closeSync(fd);
        if (output !== undefined) closeSync(output);
      }
    }
  }
}

/** Import only after the daemon confirms the container no longer exists.
 * Returns null for pre-upgrade sessions (no exchange) or no pushed branch.
 * Safe to repeat after a crash between import and publication. */
export function importWorkerExchange(
  project: WorkerProject,
  config: WorkerConfig,
  ref: string,
): string | null {
  const dir = directory(project.repo, config, ref);
  const statePath = path.join(dir, "state.json");
  if (!existsSync(statePath)) return null;
  const state = stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
  if (state.ref !== ref) throw new Error("worker exchange ref mismatch");
  const exchange = workerExchangeRepo(project.repo, config, ref);
  const head = outputHead(exchange, ref);
  if (!head || head === state.previous) return null;
  const quarantine = mkdtempSync(path.join(dir, "import-"));
  try {
    git(quarantine, ["init", "--bare", "--template="]);
    copyObjects(exchange, quarantine);
    git(quarantine, ["update-ref", "refs/heads/output", head]);
    git(quarantine, ["fsck", "--full", "--strict", "--no-reflogs"]);
    oidSchema.parse(git(quarantine, ["rev-parse", "--verify", `${head}^{commit}`]));
    git(quarantine, ["merge-base", "--is-ancestor", state.previous ?? state.base, head]);
    checkTrackedSecrets(quarantine, [head]);
    const branch = `refs/heads/agent/${ref}`;
    const current = optionalHead(project.repo, branch);
    if (current === head) return head; // An earlier attempt already imported.
    if (current !== state.previous)
      throw new Error(`host branch ${branch} changed during worker session; refusing to overwrite`);
    const checkedOut = git(project.repo, ["worktree", "list", "--porcelain"]);
    if (checkedOut.split("\n").includes(`branch ${branch}`))
      throw new Error(`host branch ${branch} is checked out; refusing to change its HEAD`);
    // Fetch from the trusted reconstructed repository, never from the mount.
    // No refspec destination means this only transfers objects/FETCH_HEAD.
    git(project.repo, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      quarantine,
      "refs/heads/output",
    ]);
    git(project.repo, ["update-ref", branch, head, current ?? "0".repeat(40)]);
    return head;
  } finally {
    rmSync(quarantine, { recursive: true, force: true });
  }
}

export function clearWorkerExchange(repo: string, config: WorkerConfig, ref: string): void {
  const dir = directory(repo, config, ref);
  if (!existsSync(dir)) return;
  // Rename first: a partial recursive deletion is never mistaken for a
  // recoverable session. Node's rm removes symlinks rather than following them.
  const retired = `${dir}.retired-${process.pid}`;
  renameSync(dir, retired);
  rmSync(retired, { recursive: true, force: true });
}
