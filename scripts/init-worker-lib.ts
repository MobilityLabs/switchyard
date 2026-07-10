// Pure helpers for scripts/init-worker.ts (SYD-44).
// Kept separate from the CLI so parsing, validation, and plist rendering are
// trivially unit-testable without touching the filesystem or network.

import type { WorkerConfig, WorkerRole } from "./worker-select.js";

/**
 * Minimal .env parser: KEY=VALUE lines, optional `export ` prefix, optional
 * single/double quotes around the value, `#` comments and blank lines skipped.
 * Deliberately does NOT do interpolation or multiline values — the repo .env
 * is three flat tokens and should stay that way.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Validate a parsed switchyard-worker.json. Returns a list of human-readable
 * problems; an empty list means the config is usable.
 */
export function validateWorkerConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["config is not a JSON object"];
  }
  const c = raw as Partial<WorkerConfig>;

  if (typeof c.url !== "string" || !/^https?:\/\/./.test(c.url)) {
    problems.push('`url` must be an http(s) URL, e.g. "http://100.85.158.109:3300"');
  }
  if (c.containerized !== undefined && typeof c.containerized !== "boolean") {
    problems.push("`containerized` must be true or false, not a string");
  }
  const runner = c.runner ?? "cli";
  if (runner !== "cli" && runner !== "sdk") {
    problems.push('`runner` must be "cli" or "sdk"');
  }
  if (runner === "sdk" && c.containerized === true) {
    problems.push('`runner: "sdk"` sessions run in-process on the host — remove `containerized: true` (container SDK image is not built yet)');
  }
  if (typeof c.intervalSeconds !== "number" || !(c.intervalSeconds > 0)) {
    problems.push("`intervalSeconds` must be a positive number");
  }
  if (typeof c.maxConcurrent !== "number" || !Number.isInteger(c.maxConcurrent) || c.maxConcurrent < 1) {
    problems.push("`maxConcurrent` must be an integer >= 1");
  }
  const policy = c.dispatchPolicy ?? "labeled";
  if (policy !== "labeled" && policy !== "all-todo") {
    problems.push('`dispatchPolicy` must be "labeled" or "all-todo"');
  }
  if (policy === "labeled" && (typeof c.label !== "string" || c.label.trim() === "")) {
    problems.push('`label` is required when dispatchPolicy is "labeled"');
  }
  if (typeof c.projects !== "object" || c.projects === null || Object.keys(c.projects).length === 0) {
    problems.push("`projects` must map at least one project key to { repo }");
  } else {
    for (const [key, project] of Object.entries(c.projects)) {
      if (typeof project?.repo !== "string" || project.repo.trim() === "") {
        problems.push(`projects.${key}.repo must be a path to a local git repo`);
      }
      if (project?.stack !== undefined) {
        problems.push(...validateWorkerStack(key, project.stack));
      }
    }
  }
  if (
    c.maxAnswersPerIssue !== undefined &&
    (typeof c.maxAnswersPerIssue !== "number" || !Number.isInteger(c.maxAnswersPerIssue) || c.maxAnswersPerIssue < 1)
  ) {
    problems.push("`maxAnswersPerIssue` must be an integer >= 1");
  }
  if (
    c.maxAnswerConcurrent !== undefined &&
    (typeof c.maxAnswerConcurrent !== "number" || !Number.isInteger(c.maxAnswerConcurrent) || c.maxAnswerConcurrent < 1)
  ) {
    problems.push("`maxAnswerConcurrent` must be an integer >= 1");
  }
  if (c.delivery !== undefined) {
    if (typeof c.delivery !== "object" || c.delivery === null || Array.isArray(c.delivery)) {
      problems.push("`delivery` must be an object");
    } else {
      const d = c.delivery as Record<string, unknown>;
      if (d.pollSeconds !== undefined && (typeof d.pollSeconds !== "number" || !(d.pollSeconds > 0))) {
        problems.push("`delivery.pollSeconds` must be a positive number");
      }
      if (d.cloneDir !== undefined && (typeof d.cloneDir !== "string" || d.cloneDir.trim() === "")) {
        problems.push("`delivery.cloneDir` must be a non-empty path");
      }
      for (const key of ["openPrs", "deploy", "verify"] as const) {
        if (d[key] !== undefined && typeof d[key] !== "boolean") {
          problems.push(`\`delivery.${key}\` must be true or false`);
        }
      }
    }
  }
  return problems;
}

/** Validates a project's `stack` declaration (SYD-76). See `validateWorkerConfig`. */
function validateWorkerStack(projectKey: string, raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [`projects.${projectKey}.stack must be an object`];
  }
  const stack = raw as Record<string, unknown>;

  if (stack.node !== undefined && (typeof stack.node !== "string" || stack.node.trim() === "")) {
    problems.push(`projects.${projectKey}.stack.node must be a non-empty string, e.g. "20"`);
  }

  if (stack.ports !== undefined) {
    const ports = stack.ports;
    const bad =
      !Array.isArray(ports) || ports.some((p) => typeof p !== "number" || !Number.isInteger(p) || p <= 0);
    if (bad) problems.push(`projects.${projectKey}.stack.ports must be an array of positive integers`);
  }

  if (stack.cli !== undefined) {
    if (!Array.isArray(stack.cli)) {
      problems.push(`projects.${projectKey}.stack.cli must be an array`);
    } else {
      stack.cli.forEach((entry, i) => {
        if (typeof entry !== "object" || entry === null) {
          problems.push(`projects.${projectKey}.stack.cli[${i}] must be an object`);
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || e.name.trim() === "") {
          problems.push(`projects.${projectKey}.stack.cli[${i}].name must be a non-empty string`);
        }
        if (typeof e.check !== "string" || e.check.trim() === "") {
          problems.push(`projects.${projectKey}.stack.cli[${i}].check must be a non-empty command string`);
        }
        if (e.install !== undefined && (typeof e.install !== "string" || e.install.trim() === "")) {
          problems.push(`projects.${projectKey}.stack.cli[${i}].install must be a non-empty string if set`);
        }
      });
    }
  }

  return problems;
}

/**
 * Compares a declared minimum Node major version (e.g. "20") against an
 * actual `process.version`-shaped string (e.g. "v24.1.0" or "24.1.0").
 * Returns false if either side doesn't parse as a number, so a malformed
 * `stack.node` or an unreadable `node --version` output fails the check
 * rather than silently passing.
 */
export function nodeVersionSatisfies(required: string, actual: string): boolean {
  const requiredMajor = parseInt(required, 10);
  const actualMajor = parseInt(actual.replace(/^v/, ""), 10);
  if (Number.isNaN(requiredMajor) || Number.isNaN(actualMajor)) return false;
  return actualMajor >= requiredMajor;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const WORKER_LAUNCHD_LABEL = "com.switchyard.worker";
export const WORKER_CODE_LAUNCHD_LABEL = "com.switchyard.worker-code";
export const WORKER_ANSWER_LAUNCHD_LABEL = "com.switchyard.worker-answer";
export const DELIVER_LAUNCHD_LABEL = "com.switchyard.deliver";

/** LaunchAgent label for a given worker role (SYD-67) — "all" keeps the pre-split label. */
export function workerLaunchdLabel(role: WorkerRole): string {
  if (role === "code") return WORKER_CODE_LAUNCHD_LABEL;
  if (role === "answer") return WORKER_ANSWER_LAUNCHD_LABEL;
  return WORKER_LAUNCHD_LABEL;
}

/**
 * Shared plist body for both LaunchAgents (worker + deliver): launchd execs
 * tsx directly (no shell, so no quoting surface at all), restarts on crash
 * only, and never receives secret material — each loop reads the repo .env
 * itself. `nodeBinDir` pins PATH to a concrete node install (launchd doesn't
 * source shell profiles, so nvm-managed node is invisible without it);
 * `extraPathDirs` carries e.g. the resolved directory of the `claude` binary
 * for bare-host worker dispatch.
 */
function renderLaunchdPlist(opts: {
  label: string;
  repoRoot: string;
  scriptRelPath: string;
  /** Extra argv entries appended after the script path, e.g. ["--role", "code"]. */
  extraArgs?: string[];
  nodeBinDir: string;
  home: string;
  extraPathDirs?: string[];
  logStem: string;
  generatedBy: string;
}): string {
  const repo = escapeXml(opts.repoRoot);
  const path = escapeXml(
    [opts.nodeBinDir, ...(opts.extraPathDirs ?? []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":")
  );
  const argLines = (opts.extraArgs ?? [])
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`${opts.generatedBy}\`. Re-run that to update. -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${opts.label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${repo}/node_modules/.bin/tsx</string>
        <string>${repo}/${opts.scriptRelPath}</string>
${argLines ? argLines + "\n" : ""}    </array>

    <!-- Restart on crash only; a clean exit (SIGINT handler, launchctl unload)
         stays down instead of respawning forever. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- If it crash-loops, don't respawn faster than every 30s. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>WorkingDirectory</key>
    <string>${repo}</string>

    <key>StandardOutPath</key>
    <string>${repo}/.superpowers/worker-logs/${opts.logStem}.out.log</string>
    <key>StandardErrorPath</key>
    <string>${repo}/.superpowers/worker-logs/${opts.logStem}.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path}</string>
        <key>HOME</key>
        <string>${escapeXml(opts.home)}</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Render the LaunchAgent plist that keeps a dispatch worker loop alive across
 * logout/reboot. `role` (default "all", SYD-67) selects the label, log
 * filenames, and the `--role` argv passed to agent-worker.ts — "all" omits
 * the flag entirely so its plist is byte-identical to the pre-split output.
 */
export function renderWorkerPlist(opts: {
  repoRoot: string;
  nodeBinDir: string;
  home: string;
  extraPathDirs?: string[];
  role?: WorkerRole;
}): string {
  const role = opts.role ?? "all";
  return renderLaunchdPlist({
    ...opts,
    label: workerLaunchdLabel(role),
    scriptRelPath: "scripts/agent-worker.ts",
    extraArgs: role === "all" ? [] : ["--role", role],
    logStem: role === "all" ? "launchd" : `launchd-${role}`,
    generatedBy:
      role === "all"
        ? "npm run init-worker -- --install-launchd"
        : `npm run init-worker -- --install-launchd-${role}`,
  });
}

/**
 * Render the LaunchAgent plist that keeps the delivery gate (scripts/deliver.ts)
 * alive across logout/reboot — deliver.ts otherwise has to be started by hand
 * and dies with the terminal. Its own pidfile (`.superpowers/deliver.pid`,
 * see pidfile.ts `isLocked`) is what the installer checks before loading, so
 * a hand-started loop doesn't get double-run by the LaunchAgent.
 */
export function renderDeliverPlist(opts: {
  repoRoot: string;
  nodeBinDir: string;
  home: string;
  extraPathDirs?: string[];
}): string {
  return renderLaunchdPlist({
    ...opts,
    label: DELIVER_LAUNCHD_LABEL,
    scriptRelPath: "scripts/deliver.ts",
    logStem: "deliver",
    generatedBy: "npm run init-worker -- --install-launchd-deliver",
  });
}

/**
 * Extracts the `PATH` launchd would actually see from a rendered plist (see
 * `renderLaunchdPlist`) — distinct from the doctor process's own shell PATH,
 * which launchd never inherits. Used by the doctor to verify an installed
 * LaunchAgent can resolve `claude` (SYD-74: a plist installed while
 * `containerized` was set used to have no `claude` directory pinned in at
 * all, so the answer role's bare `claude -p` spawn failed with ENOENT only
 * once a question actually came in).
 */
export function parsePlistPath(plistXml: string): string[] {
  const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plistXml);
  return m ? m[1].split(":").filter(Boolean) : [];
}

export type CheckResult = { name: string; ok: boolean; note?: string; warn?: boolean };

export type RoleStatus = { role: WorkerRole; running: boolean; installed: boolean };

/**
 * Summarizes per-role running/installed state (SYD-67) into a single doctor
 * check: warns (doesn't fail — a machine legitimately running only the
 * "code" role, or only "answer", is a supported configuration) when no role
 * is running at all, since that usually means the operator forgot to start
 * or install anything.
 */
export function summarizeRoleStatus(statuses: RoleStatus[]): CheckResult {
  const anyRunning = statuses.some((s) => s.running);
  const note = statuses
    .map((s) => `${s.role}: ${s.running ? "running" : s.installed ? "installed, not running" : "not installed"}`)
    .join(", ");
  return {
    name: "worker roles",
    ok: true,
    warn: !anyRunning,
    note: anyRunning ? note : `${note} — nothing is running; install a LaunchAgent or start a loop by hand`,
  };
}

/** Format doctor results as aligned ✓/✗ lines. */
export function formatChecks(results: CheckResult[]): string {
  return results
    .map((r) => {
      const mark = r.ok ? (r.warn ? "⚠" : "✓") : "✗";
      return `${mark} ${r.name}${r.note ? ` — ${r.note}` : ""}`;
    })
    .join("\n");
}

/**
 * Parses a `git remote get-url origin` value into { owner, repo }, or null if
 * it isn't a GitHub remote (a local path, a non-GitHub host, etc). Handles
 * the SSH (`git@github.com:owner/repo.git`), `ssh://`, and `https://` forms
 * gh/git actually produce; a trailing `.git` and slash are optional.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(trimmed);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

/**
 * argv + stdin payload for `gh api -X PUT .../branches/main/protection`: the
 * standard force-push/deletion block used across onboarded repos (see
 * docs/onboarding-a-project.md step 4). Required reviews stay off until
 * there's a second GitHub identity to review with (SYD-19).
 */
export function buildProtectMainArgs(owner: string, repo: string): { args: string[]; input: string } {
  return {
    args: ["api", "-X", "PUT", `repos/${owner}/${repo}/branches/main/protection`, "--input", "-"],
    input:
      JSON.stringify(
        {
          required_status_checks: null,
          enforce_admins: false,
          required_pull_request_reviews: null,
          restrictions: null,
          allow_force_pushes: false,
          allow_deletions: false,
        },
        null,
        2
      ) + "\n",
  };
}
