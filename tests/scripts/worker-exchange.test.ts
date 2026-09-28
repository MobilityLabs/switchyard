import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  truncateSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareWorkerExchange,
  importWorkerExchange,
  clearWorkerExchange,
} from "../../scripts/worker-exchange.js";
import type { WorkerConfig } from "../../scripts/worker-select.js";

let root: string;
let repo: string;
let config: WorkerConfig;
const ref = "SYD-265";
const publish = vi.fn();
vi.mock("../../scripts/delivery-exec.js", () => ({
  publishAgentBranch: (...args: unknown[]) => publish(...args),
  prFreshness: vi.fn(),
  originOwnerRepo: vi.fn(),
}));
const { recoverPublications } = await import("../../scripts/agent-worker.js");
const { savePublication, readPublications } = await import("../../scripts/worker-publications.js");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}
function commit(cwd: string, name: string, value = name): string {
  writeFileSync(path.join(cwd, name), value);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}
function worker(exchange: string): string {
  const clone = path.join(root, `clone-${Math.random()}`);
  git(root, "clone", "--no-local", exchange, clone);
  git(
    clone,
    "checkout",
    "-B",
    `agent/${ref}`,
    git(clone, "branch", "-r").includes(`origin/agent/${ref}`)
      ? `origin/agent/${ref}`
      : "origin/main",
  );
  return clone;
}
beforeEach(() => {
  publish.mockClear();
  root = mkdtempSync(path.join(os.tmpdir(), "worker-exchange-"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
  repo = path.join(root, "host");
  mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  commit(repo, "source.ts");
  config = {
    url: "http://tracker",
    label: "worker",
    intervalSeconds: 5,
    maxConcurrent: 1,
    containerized: true,
    projects: { SYD: { repo } },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("container Git exchange boundary", () => {
  it("exports only selected committed history and imports only the expected branch without host changes", () => {
    writeFileSync(path.join(repo, ".env"), "DUMMY_SECRET=test-only");
    mkdirSync(path.join(repo, ".superpowers"));
    writeFileSync(path.join(repo, ".superpowers", "lease"), "dummy");
    writeFileSync(path.join(repo, "source.ts"), "uncommitted host work");
    git(repo, "branch", "private");
    const base = git(repo, "rev-parse", "main");
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    expect(exchange.startsWith(repo)).toBe(false);
    expect(git(exchange, "config", "--get-regexp", "core")).not.toContain(repo);
    expect(git(exchange, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    const clone = worker(exchange);
    expect(existsSync(path.join(clone, ".env"))).toBe(false);
    expect(existsSync(path.join(clone, ".superpowers"))).toBe(false);
    expect(readFileSync(path.join(clone, "source.ts"), "utf8")).toBe("source.ts");
    const output = commit(clone, "fix.ts");
    git(clone, "push", "origin", `agent/${ref}`);
    git(clone, "push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/evil");
    expect(importWorkerExchange({ repo }, config, ref)).toBe(output);
    expect(git(repo, "rev-parse", `agent/${ref}`)).toBe(output);
    expect(git(repo, "rev-parse", "main")).toBe(base);
    expect(git(repo, "branch", "--list", "evil")).toBe("");
    expect(readFileSync(path.join(repo, "source.ts"), "utf8")).toBe("uncommitted host work");
    expect(importWorkerExchange({ repo }, config, ref)).toBe(output);
    clearWorkerExchange(repo, config, ref);
    expect(existsSync(exchange)).toBe(false);
  });

  it("never executes exchange config/hooks, follows alternates, or honors inherited Git overrides", () => {
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    const clone = worker(exchange);
    const head = commit(clone, "fix.ts");
    git(clone, "push", "origin", `agent/${ref}`);
    const marker = path.join(root, "host-code-executed");
    writeFileSync(
      path.join(exchange, "config"),
      `[core]\n bare = true\n hooksPath = ${root}\n fsmonitor = touch ${marker}\n[include]\n path = ${path.join(repo, ".env")}\n`,
    );
    writeFileSync(
      path.join(exchange, "objects", "info", "alternates"),
      path.join(repo, ".git", "objects"),
    );
    mkdirSync(path.join(exchange, "hooks"));
    writeFileSync(
      path.join(exchange, "hooks", "reference-transaction"),
      `#!/bin/sh\ntouch ${marker}\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", root);
    expect(importWorkerExchange({ repo }, config, ref)).toBe(head);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["ref", "refs directory", "objects directory", "pack file"])(
    "rejects a worker-planted symlink in %s without importing",
    (kind) => {
      const exchange = prepareWorkerExchange({ repo }, config, ref);
      const clone = worker(exchange);
      commit(clone, "fix.ts");
      git(clone, "push", "origin", `agent/${ref}`);
      const victim = path.join(root, "dummy-host-file");
      writeFileSync(victim, "test-only");
      const target =
        kind === "ref"
          ? path.join(exchange, "refs", "heads", "agent", ref)
          : kind === "refs directory"
            ? path.join(exchange, "refs")
            : kind === "objects directory"
              ? path.join(exchange, "objects")
              : path.join(exchange, "objects", "pack", `pack-${"a".repeat(40)}.pack`);
      rmSync(target, { recursive: true, force: true });
      symlinkSync(kind.endsWith("directory") ? repo : victim, target);
      expect(() => importWorkerExchange({ repo }, config, ref)).toThrow(/unsafe/);
      expect(git(repo, "branch", "--list", `agent/${ref}`)).toBe("");
      expect(readFileSync(victim, "utf8")).toBe("test-only");
    },
  );

  it("resumes existing agent work, rejects divergent output and concurrent host changes", () => {
    git(repo, "checkout", "-b", `agent/${ref}`);
    const previous = commit(repo, "prior.ts");
    git(repo, "checkout", "main");
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    const clone = worker(exchange);
    expect(git(clone, "rev-parse", "HEAD")).toBe(previous);
    git(clone, "reset", "--hard", "origin/main");
    commit(clone, "divergent.ts");
    git(clone, "push", "--force", "origin", `agent/${ref}`);
    expect(() => importWorkerExchange({ repo }, config, ref)).toThrow();
    git(clone, "reset", "--hard", previous);
    commit(clone, "fix.ts");
    git(clone, "push", "--force", "origin", `agent/${ref}`);
    git(repo, "update-ref", `refs/heads/agent/${ref}`, git(repo, "rev-parse", "main"));
    expect(() => importWorkerExchange({ repo }, config, ref)).toThrow(/changed during/);
  });

  it("blocks root operational secrets in history but permits fixtures and examples", () => {
    commit(repo, ".env.example", "DUMMY=test");
    mkdirSync(path.join(repo, "fixtures"));
    commit(repo, "fixtures/.env", "DUMMY=test");
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    expect(existsSync(exchange)).toBe(true);
    clearWorkerExchange(repo, config, ref);
    commit(repo, ".env", "DUMMY=test");
    git(repo, "rm", ".env");
    git(repo, "commit", "-m", "remove dummy secret");
    expect(() => prepareWorkerExchange({ repo }, config, ref)).toThrow(/tracked host-only path/);
  });
  it("rejects merge-introduced root .env even when ordinary history hides its diff", () => {
    git(repo, "checkout", "-b", "topic");
    commit(repo, "topic.ts");
    git(repo, "checkout", "main");
    commit(repo, "main.ts");
    git(repo, "merge", "--no-commit", "topic");
    writeFileSync(path.join(repo, ".env"), "DUMMY=test-only");
    git(repo, "add", ".env");
    git(repo, "commit", "-m", "merge with dummy env");
    expect(() => prepareWorkerExchange({ repo }, config, ref)).toThrow(/tracked host-only/);
  });

  it("bounds worker-controlled sparse pack sizes before reading them", () => {
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    const clone = worker(exchange);
    commit(clone, "fix.ts");
    git(clone, "push", "origin", `agent/${ref}`);
    const pack = path.join(exchange, "objects", "pack", `pack-${"a".repeat(40)}.pack`);
    writeFileSync(pack, "");
    truncateSync(pack, 2 * 1024 * 1024 * 1024 + 1);
    expect(() => importWorkerExchange({ repo }, config, ref)).toThrow(/size limit/);
    expect(git(repo, "branch", "--list", `agent/${ref}`)).toBe("");
  });

  it.each([undefined, { openPrs: false }])(
    "recovers real committed output with PR publication disabled: %j",
    async (delivery) => {
      config.delivery = delivery;
      const exchange = prepareWorkerExchange({ repo }, config, ref);
      const clone = worker(exchange);
      const head = commit(clone, "fix.ts");
      git(clone, "push", "origin", `agent/${ref}`);
      savePublication(repo, config, {
        ref,
        issueTitle: "Fix",
        sessionId: null,
        exitCode: null,
        exchange: true,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}")),
      );
      await recoverPublications(config, "dummy", new Set([`syd-${ref}`]));
      expect(readPublications(repo, config)).toHaveLength(1);
      expect(git(repo, "branch", "--list", `agent/${ref}`)).toBe("");
      await recoverPublications(config, "dummy", new Set());
      expect(git(repo, "rev-parse", `agent/${ref}`)).toBe(head);
      expect(readPublications(repo, config)).toEqual([]);
      expect(existsSync(exchange)).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("cleans interrupted preparation without publishing an older host agent branch", async () => {
    git(repo, "branch", `agent/${ref}`);
    config.delivery = { openPrs: true };
    const exchange = prepareWorkerExchange({ repo }, config, ref);
    savePublication(repo, config, {
      ref,
      issueTitle: "Fix",
      sessionId: null,
      exitCode: null,
      exchange: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    // Death before spawning: only the pre-existing agent branch was seeded.
    await recoverPublications(config, "dummy", new Set());
    expect(publish).not.toHaveBeenCalled();
    expect(readPublications(repo, config)).toEqual([]);
    // Death mid-preparation: state.json was not atomically installed yet.
    savePublication(repo, config, {
      ref,
      issueTitle: "Fix",
      sessionId: null,
      exitCode: null,
      exchange: true,
    });
    mkdirSync(exchange, { recursive: true });
    await recoverPublications(config, "dummy", new Set());
    expect(publish).not.toHaveBeenCalled();
    expect(readPublications(repo, config)).toEqual([]);
    expect(existsSync(exchange)).toBe(false);
  });
});
