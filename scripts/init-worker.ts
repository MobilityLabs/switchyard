// Setup + health-check flow for the local agent worker (SYD-44).
//
//   npm run init-worker                                # doctor: check everything, change nothing
//   npm run init-worker -- --install-launchd           # doctor, then install the worker's KeepAlive LaunchAgent
//   npm run init-worker -- --install-launchd-deliver   # doctor, then install deliver.ts's KeepAlive LaunchAgent
//   npm run init-worker -- --self-test                 # doctor, then one dry-run worker tick
//   npm run init-worker -- --protect-main [KEY]        # doctor, then apply branch protection to main
//                                                       # (all configured projects, or just KEY)
//
// Decision of record (SYD-44): the runner stays basic — `claude -p` headless
// sessions authenticated by CLAUDE_CODE_OAUTH_TOKEN, no Agent SDK. This script
// exists so bringing a new machine (or a rebooted one) online is one command
// instead of tribal knowledge.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerConfig } from "./worker-select.js";
import { isLocked } from "./pidfile.js";
import {
  buildProtectMainArgs,
  formatChecks,
  parseDotEnv,
  parseGithubRemote,
  renderDeliverPlist,
  renderWorkerPlist,
  validateWorkerConfig,
  DELIVER_LAUNCHD_LABEL,
  WORKER_LAUNCHD_LABEL,
  type CheckResult,
} from "./init-worker-lib.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "switchyard-worker.json");
const envPath = path.join(repoRoot, ".env");

function commandExists(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function loadEnv(): Record<string, string> {
  const fromFile = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  // Real environment wins over .env, matching how the worker itself runs.
  return { ...fromFile, ...(process.env as Record<string, string>) };
}

async function doctor(): Promise<{ results: CheckResult[]; config: WorkerConfig | null }> {
  const results: CheckResult[] = [];
  const env = loadEnv();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push({
    name: "node >= 20",
    ok: nodeMajor >= 20,
    note: `running ${process.versions.node}`,
  });

  // Config file
  let config: WorkerConfig | null = null;
  if (!existsSync(configPath)) {
    results.push({
      name: "switchyard-worker.json",
      ok: false,
      note: "missing — copy switchyard-worker.example.json and edit it",
    });
  } else {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      const problems = validateWorkerConfig(raw);
      if (problems.length > 0) {
        results.push({ name: "switchyard-worker.json", ok: false, note: problems.join("; ") });
      } else {
        config = raw as WorkerConfig;
        results.push({ name: "switchyard-worker.json", ok: true });
      }
    } catch (err) {
      results.push({ name: "switchyard-worker.json", ok: false, note: `invalid JSON: ${(err as Error).message}` });
    }
  }

  // Project repos
  if (config) {
    for (const [key, project] of Object.entries(config.projects)) {
      const isRepo = existsSync(path.join(project.repo, ".git"));
      results.push({
        name: `projects.${key} repo`,
        ok: isRepo,
        note: isRepo ? project.repo : `${project.repo} is not a git repo`,
      });
    }
  }

  // Runner prerequisites
  if (config && (config.runner ?? "cli") === "sdk") {
    const sdkInstalled = existsSync(
      path.join(repoRoot, "worker-sdk", "node_modules", "@anthropic-ai", "claude-agent-sdk")
    );
    results.push({
      name: "worker-sdk installed",
      ok: sdkInstalled,
      note: sdkInstalled ? undefined : "run: npm install --prefix worker-sdk",
    });
    const hasClaudeAuth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
    results.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)",
      ok: true,
      warn: !hasClaudeAuth,
      note: hasClaudeAuth
        ? "in .env / environment"
        : "not set — SDK sessions fall back to the local claude login",
    });
  } else if (config?.containerized) {
    const hasDocker = commandExists("docker");
    results.push({ name: "docker CLI", ok: hasDocker });
    if (hasDocker) {
      const image = config.image ?? "switchyard-worker";
      const inspect = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
      results.push({
        name: `worker image "${image}"`,
        ok: inspect.status === 0,
        note: inspect.status === 0 ? undefined : "not built — run: npm run build:worker-image",
      });
    }
    const hasClaudeAuth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
    results.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)",
      ok: hasClaudeAuth,
      note: hasClaudeAuth ? "in .env / environment" : "required for containerized sessions — `claude setup-token`",
    });
  } else {
    results.push({
      name: "claude CLI",
      ok: commandExists("claude"),
      note: commandExists("claude") ? undefined : "bare-host mode shells out to `claude -p`",
    });
  }

  // Tokens + server
  if (!existsSync(envPath)) {
    results.push({ name: ".env", ok: false, note: `missing ${envPath} — the worker reads it at start` });
  } else {
    const mode = statSync(envPath).mode & 0o777;
    const tight = (mode & 0o077) === 0;
    results.push({
      name: ".env permissions",
      ok: tight,
      note: tight ? "0600" : `mode ${mode.toString(8)} is group/world-readable — run: chmod 600 .env`,
    });
  }
  const token = env.SWITCHYARD_TOKEN;
  results.push({ name: "SWITCHYARD_TOKEN", ok: Boolean(token) });

  if (config) {
    const base = config.url.replace(/\/$/, "");
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      results.push({ name: `server ${base}`, ok: health.ok, note: health.ok ? undefined : `health returned ${health.status}` });
    } catch (err) {
      results.push({ name: `server ${base}`, ok: false, note: `unreachable: ${(err as Error).message}` });
    }

    if (token) {
      try {
        const me = await fetch(`${base}/api/me`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!me.ok) {
          results.push({ name: "token valid", ok: false, note: `/api/me returned ${me.status}` });
        } else {
          const actor = (await me.json()) as { name: string; type: string };
          // A human token here would let dispatched sessions bypass every
          // agent-side guard (triage exit, done). Hard fail, not a warning.
          results.push({
            name: "token is an agent actor",
            ok: actor.type === "agent",
            note: `${actor.name} (${actor.type})`,
          });
        }
      } catch (err) {
        results.push({ name: "token valid", ok: false, note: (err as Error).message });
      }
    }
  }

  results.push({
    name: "Slack notifier",
    ok: true,
    warn: !env.SLACK_WEBHOOK_URL,
    note: env.SLACK_WEBHOOK_URL ? "SLACK_WEBHOOK_URL set" : "SLACK_WEBHOOK_URL not set — notifier skipped",
  });

  // Delivery gate (SYD-49) prerequisites — deliver.ts shells out to `gh` for
  // every project, so these only matter (and are only checked) once a
  // `delivery` block is configured. `switchyard-worker.json` validity above
  // already covers the block's own shape; this covers what it can't see from
  // the config alone: whether `gh` is actually installed and authenticated,
  // and whether each project repo actually has a GitHub `origin` to open PRs
  // and merge against.
  if (config?.delivery) {
    const hasGh = commandExists("gh");
    results.push({
      name: "gh CLI",
      ok: hasGh,
      note: hasGh ? undefined : "required for the delivery gate — https://cli.github.com",
    });
    if (hasGh) {
      const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
      results.push({
        name: "gh authenticated",
        ok: auth.status === 0,
        note: auth.status === 0 ? undefined : "run: gh auth login",
      });
    }
    for (const [key, project] of Object.entries(config.projects)) {
      const remote = spawnSync("git", ["-C", project.repo, "remote", "get-url", "origin"], { encoding: "utf8" });
      if (remote.status !== 0) {
        results.push({ name: `projects.${key} GitHub origin`, ok: false, note: "no `origin` remote configured" });
        continue;
      }
      const parsed = parseGithubRemote(remote.stdout.trim());
      results.push({
        name: `projects.${key} GitHub origin`,
        ok: parsed !== null,
        note: parsed ? `${parsed.owner}/${parsed.repo}` : `origin is not a GitHub remote: ${remote.stdout.trim()}`,
      });
    }
  }

  return { results, config };
}

function workerAlreadyRunning(): boolean {
  const out = spawnSync("pgrep", ["-f", "tsx scripts/agent-worker.ts"], { encoding: "utf8" });
  return out.status === 0 && out.stdout.trim() !== "";
}

function deliverAlreadyRunning(): boolean {
  return isLocked(path.join(repoRoot, ".superpowers", "deliver.pid"));
}

/** Shared write-plist / launchctl-load flow for the worker and deliver LaunchAgents. */
function installPlist(opts: { label: string; plist: string; alreadyRunning: () => boolean; noun: string }): void {
  const dest = path.join(os.homedir(), "Library", "LaunchAgents", `${opts.label}.plist`);
  mkdirSync(path.dirname(dest), { recursive: true });
  mkdirSync(path.join(repoRoot, ".superpowers", "worker-logs"), { recursive: true });
  writeFileSync(dest, opts.plist);
  console.log(`wrote ${dest}`);

  if (opts.alreadyRunning()) {
    console.log(
      `\nA ${opts.noun} process is already running — NOT loading the LaunchAgent now\n` +
      `(two would double-run). If it's a previous LaunchAgent install:\n` +
      `  launchctl unload ${dest} && launchctl load ${dest}\n` +
      "If it's a hand-started loop, kill it, then:\n" +
      `  launchctl load ${dest}`
    );
    return;
  }

  // Reload if a previous version was loaded; `unload` on a never-loaded
  // label just errors harmlessly.
  spawnSync("launchctl", ["unload", dest], { stdio: "ignore" });
  const load = spawnSync("launchctl", ["load", dest], { encoding: "utf8" });
  if (load.status !== 0) {
    console.error(
      `launchctl load failed: ${(load.stderr || load.stdout || "").trim()}\n` +
      "If you're over SSH, run this from a GUI session — or try:\n" +
      `  launchctl bootstrap gui/$(id -u) ${dest}`
    );
    process.exit(1);
  }
  console.log(`loaded ${opts.label} — ${opts.noun} starts now, restarts on crash, survives reboot`);
  console.log(`stop it with: launchctl unload ${dest}`);
}

function installLaunchd(config: WorkerConfig | null): void {
  // Bare-host mode shells out to `claude`, which launchd won't find on its
  // minimal PATH (often ~/.local/bin) — resolve it now and pin it in.
  const extraPathDirs: string[] = [];
  if (config && !config.containerized) {
    const which = spawnSync("which", ["claude"], { encoding: "utf8" });
    if (which.status === 0) extraPathDirs.push(path.dirname(which.stdout.trim()));
  }

  const plist = renderWorkerPlist({
    repoRoot,
    nodeBinDir: path.dirname(process.execPath),
    home: os.homedir(),
    extraPathDirs,
  });
  installPlist({ label: WORKER_LAUNCHD_LABEL, plist, alreadyRunning: workerAlreadyRunning, noun: "worker" });
  console.log(`logs: ${path.join(repoRoot, ".superpowers", "worker-logs", "launchd.out.log")}`);
}

/** Sibling of installLaunchd for the delivery gate loop (SYD-53) — otherwise deliver.ts has to be started by hand and dies with the terminal. */
function installLaunchdDeliver(config: WorkerConfig | null): void {
  if (!config?.delivery) {
    console.error(
      "switchyard-worker.json has no `delivery` block — nothing to install. " +
      "Add one (see docs/onboarding-a-project.md) before running --install-launchd-deliver."
    );
    process.exit(1);
  }

  const plist = renderDeliverPlist({
    repoRoot,
    nodeBinDir: path.dirname(process.execPath),
    home: os.homedir(),
  });
  installPlist({
    label: DELIVER_LAUNCHD_LABEL,
    plist,
    alreadyRunning: deliverAlreadyRunning,
    noun: "delivery worker",
  });
  console.log(`logs: ${path.join(repoRoot, ".superpowers", "worker-logs", "deliver.out.log")}`);
}

/**
 * Applies the standard force-push/deletion branch protection (see
 * docs/onboarding-a-project.md step 4) to `main` on each configured
 * project's repo, or just `onlyKey` if given. Resolves owner/repo from each
 * project's `origin` remote rather than trusting hand-entered values.
 */
function protectMain(config: WorkerConfig | null, onlyKey: string | undefined): void {
  if (!config) {
    console.error("switchyard-worker.json is missing or invalid — fix it before running --protect-main.");
    process.exit(1);
  }
  const keys = onlyKey ? [onlyKey] : Object.keys(config.projects);
  let failures = 0;
  for (const key of keys) {
    const project = config.projects[key];
    if (!project) {
      console.error(`✗ ${key}: not in switchyard-worker.json projects`);
      failures++;
      continue;
    }
    const remote = spawnSync("git", ["-C", project.repo, "remote", "get-url", "origin"], { encoding: "utf8" });
    if (remote.status !== 0) {
      console.error(`✗ ${key}: no \`origin\` remote in ${project.repo}`);
      failures++;
      continue;
    }
    const parsed = parseGithubRemote(remote.stdout.trim());
    if (!parsed) {
      console.error(`✗ ${key}: origin is not a GitHub remote (${remote.stdout.trim()})`);
      failures++;
      continue;
    }
    const { args, input } = buildProtectMainArgs(parsed.owner, parsed.repo);
    const res = spawnSync("gh", args, { input, encoding: "utf8" });
    if (res.status !== 0) {
      console.error(`✗ ${key}: gh api failed — ${(res.stderr || res.stdout || "").trim()}`);
      failures++;
      continue;
    }
    console.log(`✓ ${key}: main branch protected on ${parsed.owner}/${parsed.repo} (force-push + deletion blocked)`);
  }
  if (failures > 0) process.exit(1);
}

function selfTest(): void {
  console.log("\nself-test: one dry-run worker tick (nothing is dispatched)\n");
  const env = loadEnv();
  const run = spawnSync("npx", ["tsx", "scripts/agent-worker.ts", "--once", "--dry-run"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    console.error("self-test failed");
    process.exit(1);
  }
  console.log("\nself-test passed");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { results, config } = await doctor();
  console.log(formatChecks(results));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed — fix them and re-run \`npm run init-worker\`.`);
    process.exit(1);
  }
  console.log("\nall checks passed");

  if (args.includes("--self-test")) selfTest();
  if (args.includes("--install-launchd")) installLaunchd(config);
  if (args.includes("--install-launchd-deliver")) installLaunchdDeliver(config);

  const protectIdx = args.indexOf("--protect-main");
  if (protectIdx !== -1) {
    const next = args[protectIdx + 1];
    const key = next && !next.startsWith("-") ? next : undefined;
    protectMain(config, key);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
