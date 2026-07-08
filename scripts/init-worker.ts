// Setup + health-check flow for the local agent worker (SYD-44).
//
//   npm run init-worker                       # doctor: check everything, change nothing
//   npm run init-worker -- --install-launchd  # doctor, then install the KeepAlive LaunchAgent
//   npm run init-worker -- --self-test        # doctor, then one dry-run worker tick
//
// Decision of record (SYD-44): the runner stays basic — `claude -p` headless
// sessions authenticated by CLAUDE_CODE_OAUTH_TOKEN, no Agent SDK. This script
// exists so bringing a new machine (or a rebooted one) online is one command
// instead of tribal knowledge.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerConfig } from "./worker-select.js";
import {
  formatChecks,
  parseDotEnv,
  renderWorkerPlist,
  validateWorkerConfig,
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
  if (config?.containerized) {
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
  results.push({
    name: ".env",
    ok: existsSync(envPath),
    note: existsSync(envPath) ? undefined : `missing ${envPath} — the LaunchAgent sources it at start`,
  });
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

  return { results, config };
}

function workerAlreadyRunning(): boolean {
  const out = spawnSync("pgrep", ["-f", "agent-worker.ts"], { encoding: "utf8" });
  return out.status === 0 && out.stdout.trim() !== "";
}

function installLaunchd(): void {
  const plist = renderWorkerPlist({
    repoRoot,
    nodeBinDir: path.dirname(process.execPath),
    home: os.homedir(),
  });
  const dest = path.join(os.homedir(), "Library", "LaunchAgents", `${WORKER_LAUNCHD_LABEL}.plist`);
  mkdirSync(path.dirname(dest), { recursive: true });
  mkdirSync(path.join(repoRoot, ".superpowers", "worker-logs"), { recursive: true });
  writeFileSync(dest, plist);
  console.log(`wrote ${dest}`);

  if (workerAlreadyRunning()) {
    console.log(
      "\nA worker process is already running — NOT loading the LaunchAgent now\n" +
      "(two workers would double-dispatch). Stop the current one, then run:\n" +
      `  launchctl load ${dest}`
    );
    return;
  }

  // Reload if a previous version was loaded; `unload` on a never-loaded
  // label just errors harmlessly.
  spawnSync("launchctl", ["unload", dest], { stdio: "ignore" });
  execFileSync("launchctl", ["load", dest], { stdio: "inherit" });
  console.log(`loaded ${WORKER_LAUNCHD_LABEL} — worker starts now and survives reboot`);
  console.log(`logs: ${path.join(repoRoot, ".superpowers", "worker-logs", "launchd.out.log")}`);
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
  const { results } = await doctor();
  console.log(formatChecks(results));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed — fix them and re-run \`npm run init-worker\`.`);
    process.exit(1);
  }
  console.log("\nall checks passed");

  if (args.includes("--self-test")) selfTest();
  if (args.includes("--install-launchd")) installLaunchd();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
