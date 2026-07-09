// Setup + health-check flow for the local agent worker (SYD-44).
//
//   npm run init-worker                                # doctor: check everything, change nothing
//   npm run init-worker -- --install-launchd           # doctor, then install the "all"-role KeepAlive LaunchAgent
//   npm run init-worker -- --install-launchd-code      # doctor, then install the code-role-only LaunchAgent (SYD-67)
//   npm run init-worker -- --install-launchd-answer    # doctor, then install the answer-role-only LaunchAgent (SYD-67)
//   npm run init-worker -- --install-launchd-deliver   # doctor, then install deliver.ts's KeepAlive LaunchAgent
//   npm run init-worker -- --self-test                 # doctor, then one dry-run worker tick
//   npm run init-worker -- --protect-main [KEY]        # doctor, then apply branch protection to main
//                                                       # (all configured projects, or just KEY)
//   npm run init-worker -- --repair-stack [KEY]        # install/repair a project's declared stack.cli
//                                                       # (all configured projects, or just KEY)
//
// Per-project toolchain declarations (SYD-76): projects.<KEY>.stack in
// switchyard-worker.json (node version, extra CLIs, ports) — the doctor
// verifies it in whichever environment sessions actually run in (the built
// image for containerized projects, the host otherwise); --repair-stack
// installs what's missing. See switchyard-worker.example.json for the shape.
//
// Role split (SYD-67): --install-launchd-code and --install-launchd-answer
// install independent LaunchAgents so code dispatch and answerer mode can be
// enabled/disabled separately (e.g. `launchctl unload` just the code one).
// --install-launchd keeps installing the combined "all" role — running "all"
// alongside a single-role worker is refused at runtime (see
// checkRoleLockConflict in worker-select.ts), not by this installer.
//   npm run init-worker                       # doctor: check everything, change nothing
//   npm run init-worker -- --install-launchd  # doctor, then install the KeepAlive LaunchAgent
//   npm run init-worker -- --self-test        # doctor, then one dry-run worker tick
//   npm run init-worker -- --add-project KEY /path/to/repo ["Display Name"]
//                                              # onboard a new project (SYD-52): create it on the
//                                              # server if new, add it to switchyard-worker.json,
//                                              # re-run the doctor, print the CLAUDE.md snippet
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
import type { WorkerConfig, WorkerProject, WorkerRole } from "./worker-select.js";
import { workerPidFileName } from "./worker-select.js";
import { isLocked } from "./pidfile.js";
import {
  buildProtectMainArgs,
  formatChecks,
  nodeVersionSatisfies,
  insertProjectIntoConfigText,
  parseDotEnv,
  parseGithubRemote,
  parsePlistPath,
  renderDeliverPlist,
  renderClaudeMdSnippet,
  renderWorkerPlist,
  summarizeRoleStatus,
  validateWorkerConfig,
  workerLaunchdLabel,
  DELIVER_LAUNCHD_LABEL,
  type CheckResult,
  type RoleStatus,
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

/**
 * Runs `cmd` in whichever environment a project's dispatched sessions
 * actually execute in (SYD-76): inside the built worker image for
 * containerized projects, on the host otherwise (bare-host and sdk runners
 * both execute directly on this machine). Checking the wrong environment
 * would pass a doctor run on a host that happens to have the tool while the
 * container that actually runs sessions doesn't.
 */
function runsOk(cmd: string, config: WorkerConfig): boolean {
  if (config.containerized) {
    const image = config.image ?? "switchyard-worker";
    return spawnSync("docker", ["run", "--rm", image, "sh", "-c", cmd], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-c", cmd], { stdio: "ignore" }).status === 0;
}

/** Doctor checks for a project's declared `stack` (SYD-76): Node version, extra CLIs, declared ports. */
function checkProjectStack(key: string, project: WorkerProject, config: WorkerConfig): CheckResult[] {
  const results: CheckResult[] = [];
  const stack = project.stack;
  if (!stack) return results;

  if (stack.node) {
    let actual: string | null;
    if (config.containerized) {
      const image = config.image ?? "switchyard-worker";
      const out = spawnSync("docker", ["run", "--rm", image, "node", "--version"], { encoding: "utf8" });
      actual = out.status === 0 ? out.stdout.trim() : null;
    } else {
      actual = process.version;
    }
    results.push({
      name: `projects.${key} stack: node >= ${stack.node}`,
      ok: actual !== null && nodeVersionSatisfies(stack.node, actual),
      note: actual ? `found ${actual}` : "could not determine the session's node version",
    });
  }

  for (const cli of stack.cli ?? []) {
    const ok = runsOk(cli.check, config);
    results.push({
      name: `projects.${key} stack: ${cli.name}`,
      ok,
      note: ok ? undefined : cli.install ? `missing — run: ${cli.install}` : `missing — \`${cli.check}\` failed`,
    });
  }

  if (stack.ports && stack.ports.length > 0) {
    results.push({
      name: `projects.${key} stack: ports`,
      ok: true,
      note: `declared: ${stack.ports.join(", ")} (informational — not port-mapped automatically yet)`,
    });
  }

  return results;
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

  // Project repos + declared toolchain (stack, SYD-76)
  if (config) {
    for (const [key, project] of Object.entries(config.projects)) {
      const isRepo = existsSync(path.join(project.repo, ".git"));
      results.push({
        name: `projects.${key} repo`,
        ok: isRepo,
        note: isRepo ? project.repo : `${project.repo} is not a git repo`,
      });
      if (project.stack) {
        results.push(...checkProjectStack(key, project, config));
      }
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

  // Role split (SYD-67): report which of all/code/answer are installed
  // (LaunchAgent plist present) and/or running (pidfile lock held) so an
  // operator can see at a glance whether they've e.g. left the answerer
  // running with the code role disabled on purpose, versus forgotten to
  // start anything at all.
  const roles: WorkerRole[] = ["all", "code", "answer"];
  const roleStatuses: RoleStatus[] = roles.map((role) => ({
    role,
    running: isLocked(path.join(repoRoot, ".superpowers", workerPidFileName(role))),
    installed: existsSync(
      path.join(os.homedir(), "Library", "LaunchAgents", `${workerLaunchdLabel(role)}.plist`)
    ),
  }));
  results.push(summarizeRoleStatus(roleStatuses));

  // SYD-74: for every role actually installed via launchd, verify `claude`
  // resolves from the plist's own pinned PATH — not this doctor process's
  // shell PATH, which launchd never sees. Catches a stale or misconfigured
  // plist (e.g. re-installed before this fix, or `claude` moved since) at
  // install/doctor time instead of ENOENT the next time a question comes in.
  for (const status of roleStatuses) {
    if (!status.installed) continue;
    const plistPath = path.join(
      os.homedir(), "Library", "LaunchAgents", `${workerLaunchdLabel(status.role)}.plist`
    );
    const dirs = parsePlistPath(readFileSync(plistPath, "utf8"));
    const found = dirs.some((dir) => existsSync(path.join(dir, "claude")));
    results.push({
      name: `${status.role} LaunchAgent PATH resolves claude`,
      ok: found,
      note: found
        ? undefined
        : `claude not found in plist PATH (${dirs.join(":")}) — re-run --install-launchd${status.role === "all" ? "" : `-${status.role}`}`,
    });
  }

  return { results, config };
}

function workerAlreadyRunning(role: WorkerRole): boolean {
  return isLocked(path.join(repoRoot, ".superpowers", workerPidFileName(role)));
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

/**
 * Installs the LaunchAgent for `role` (SYD-67: "all" by default, or "code" /
 * "answer" via --install-launchd-code / --install-launchd-answer). Each role
 * gets its own label and pidfile, so installing "code" and "answer"
 * separately runs them side by side; installing "all" on top of either is
 * left to the runtime lock (checkRoleLockConflict) to refuse, same as
 * hand-starting the loops would be.
 */
function installLaunchd(role: WorkerRole = "all"): void {
  // Answer sessions (SYD-56) always shell out to bare `claude -p` on the
  // host regardless of `containerized` — and bare-host code dispatch needs
  // it too — so resolve `which claude` unconditionally (SYD-74; this used to
  // be skipped whenever `containerized` was set, leaving the answer role
  // with no `claude` on launchd's minimal PATH).
  const extraPathDirs: string[] = [];
  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status === 0) extraPathDirs.push(path.dirname(which.stdout.trim()));

  const plist = renderWorkerPlist({
    repoRoot,
    nodeBinDir: path.dirname(process.execPath),
    home: os.homedir(),
    extraPathDirs,
    role,
  });
  const logStem = role === "all" ? "launchd" : `launchd-${role}`;
  installPlist({
    label: workerLaunchdLabel(role),
    plist,
    alreadyRunning: () => workerAlreadyRunning(role),
    noun: role === "all" ? "worker" : `worker (${role} role)`,
  });
  console.log(`logs: ${path.join(repoRoot, ".superpowers", "worker-logs", `${logStem}.out.log`)}`);
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

/**
 * Install+repair action for a failing `stack.cli` check (SYD-76 layer 3 — the
 * doctor's "missing — run: ..." note points here). Bare-host/sdk projects run
 * the declared `install` command directly; containerized projects can't be
 * repaired in place (a `--rm` container throws the install away on exit), so
 * this prints the Dockerfile.worker + rebuild guidance instead.
 */
function repairStack(config: WorkerConfig | null, onlyKey: string | undefined): void {
  if (!config) {
    console.error("switchyard-worker.json is missing or invalid — fix it before running --repair-stack.");
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
    const cli = project.stack?.cli ?? [];
    if (cli.length === 0) {
      console.log(`${key}: no stack.cli declared, nothing to repair`);
      continue;
    }
    if (config.containerized) {
      console.log(
        `${key}: containerized — add these to Dockerfile.worker and run \`npm run build:worker-image\`:\n` +
        cli.map((c) => `  - ${c.name}: ${c.install ?? "(no install command declared)"}`).join("\n")
      );
      continue;
    }
    for (const c of cli) {
      if (runsOk(c.check, config)) {
        console.log(`✓ ${key}: ${c.name} already present`);
        continue;
      }
      if (!c.install) {
        console.error(`✗ ${key}: ${c.name} missing and no install command declared`);
        failures++;
        continue;
      }
      console.log(`${key}: installing ${c.name} — ${c.install}`);
      spawnSync("sh", ["-c", c.install], { stdio: "inherit" });
      if (runsOk(c.check, config)) {
        console.log(`✓ ${key}: ${c.name} installed`);
      } else {
        console.error(`✗ ${key}: ${c.name} install failed or check still fails`);
        failures++;
      }
    }
  }
  if (failures > 0) process.exit(1);
}

/**
 * `--add-project KEY /path/to/repo ["Display Name"]` (SYD-52): create the
 * project on the server if the key is new, add it to switchyard-worker.json
 * preserving formatting, re-run the doctor, and print the CLAUDE.md priming
 * snippet — collapsing docs/onboarding-a-project.md steps 1-3/5 into one
 * command.
 */
async function addProject(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--add-project");
  const key = argv[idx + 1];
  const repoArg = argv[idx + 2];
  const displayName = argv[idx + 3] && !argv[idx + 3].startsWith("--") ? argv[idx + 3] : undefined;

  if (!key || !repoArg) {
    console.error('usage: npm run init-worker -- --add-project KEY /path/to/repo ["Display Name"]');
    process.exit(1);
  }
  if (!/^[A-Z]{2,10}$/.test(key)) {
    console.error(`project key "${key}" is invalid — use 2-10 uppercase letters, e.g. "NOC"`);
    process.exit(1);
  }

  const repoPath = path.resolve(repoArg);
  if (!existsSync(path.join(repoPath, ".git"))) {
    console.error(`${repoPath} is not a git repo (no .git directory) — check the path`);
    process.exit(1);
  }

  if (!existsSync(configPath)) {
    console.error(`${configPath} missing — copy switchyard-worker.example.json and edit it first`);
    process.exit(1);
  }
  const configText = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (err) {
    console.error(`${configPath} is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  const problems = validateWorkerConfig(parsed);
  if (problems.length > 0) {
    console.error(`${configPath} is currently invalid — fix it first:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const config = parsed as WorkerConfig;

  const alreadyConfigured = Object.prototype.hasOwnProperty.call(config.projects, key);
  if (alreadyConfigured) {
    const existingRepo = path.resolve(config.projects[key].repo);
    if (existingRepo !== repoPath) {
      console.error(
        `projects.${key} already points at ${existingRepo} (you asked for ${repoPath}) — edit ${configPath} by hand to change it`
      );
      process.exit(1);
    }
    console.log(`projects.${key} already points at ${repoPath} — switchyard-worker.json unchanged`);
  }

  const env = loadEnv();
  const token = env.SWITCHYARD_TOKEN;
  if (!token) {
    console.error(`SWITCHYARD_TOKEN not set in ${envPath} / environment — needed to create the project on the server`);
    process.exit(1);
  }
  const base = config.url.replace(/\/$/, "");
  const name = displayName ?? key;
  console.log(`\ncreating project ${key} ("${name}") on ${base}...`);
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key, name }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.log(`created project ${key}`);
    } else {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      const message = errBody.error ?? `HTTP ${res.status}`;
      if (message.includes("already exists")) {
        console.log(`project ${key} already exists on the server — continuing`);
      } else {
        console.error(`failed to create project: ${message}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`failed to reach ${base}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!alreadyConfigured) {
    const updatedText = insertProjectIntoConfigText(configText, key, repoPath);
    const reparsed = JSON.parse(updatedText) as WorkerConfig;
    if (reparsed.projects[key]?.repo !== repoPath) {
      console.error("internal error: config edit did not produce the expected entry — not writing switchyard-worker.json");
      process.exit(1);
    }
    writeFileSync(configPath, updatedText);
    console.log(`added projects.${key} -> ${repoPath} to ${configPath}`);
  }

  console.log("\nre-running doctor with the new project...\n");
  const { results } = await doctor();
  console.log(formatChecks(results));
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
  } else {
    console.log("\nall checks passed");
  }

  console.log(`\npaste this into ${repoPath}/CLAUDE.md (docs/agent-kit.md pattern):\n`);
  console.log(renderClaudeMdSnippet(key));
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

  if (args.includes("--add-project")) {
    await addProject(args);
    return;
  }

  const { results, config } = await doctor();
  console.log(formatChecks(results));

  // Runs even when the stack checks above failed — that's the whole point:
  // the doctor's "missing — run: ..." note points an operator here.
  const repairIdx = args.indexOf("--repair-stack");
  if (repairIdx !== -1) {
    const next = args[repairIdx + 1];
    const key = next && !next.startsWith("-") ? next : undefined;
    repairStack(config, key);
    return;
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed — fix them and re-run \`npm run init-worker\`.`);
    process.exit(1);
  }
  console.log("\nall checks passed");

  if (args.includes("--self-test")) selfTest();
  if (args.includes("--install-launchd")) installLaunchd("all");
  if (args.includes("--install-launchd-code")) installLaunchd("code");
  if (args.includes("--install-launchd-answer")) installLaunchd("answer");
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
