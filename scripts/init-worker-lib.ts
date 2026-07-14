// Pure helpers for scripts/init-worker.ts (SYD-44).
// Kept separate from the CLI so parsing, validation, and plist rendering are
// trivially unit-testable without touching the filesystem or network.

import type { WorkerConfig, WorkerRole, WorkerStackCli } from "./worker-select.js";

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
  if (c.egress !== undefined && c.egress !== "proxy" && c.egress !== "open") {
    problems.push('`egress` must be "proxy" or "open"');
  }
  if (
    c.egressAllow !== undefined &&
    (!Array.isArray(c.egressAllow) || c.egressAllow.some((d) => typeof d !== "string"))
  ) {
    problems.push("`egressAllow` must be an array of hostnames");
  }
  const runner = c.runner ?? "cli";
  if (runner !== "cli" && runner !== "sdk") {
    problems.push('`runner` must be "cli" or "sdk"');
  }
  if (runner === "sdk" && c.containerized === true) {
    problems.push(
      '`runner: "sdk"` sessions run in-process on the host — remove `containerized: true` (container SDK image is not built yet)',
    );
  }
  if (c.engine !== undefined && c.engine !== "claude" && c.engine !== "codex") {
    problems.push('`engine` must be "claude" or "codex"');
  }
  if (c.engine === "codex" && c.egress === "open") {
    problems.push('engine "codex" requires the injecting proxy — remove `egress: "open"`');
  }
  if (c.token !== undefined && (typeof c.token !== "string" || c.token.length === 0)) {
    problems.push("`token` must be a non-empty string (the NAME of the env var holding this worker's token)");
  }
  if (typeof c.intervalSeconds !== "number" || !(c.intervalSeconds > 0)) {
    problems.push("`intervalSeconds` must be a positive number");
  }
  if (
    typeof c.maxConcurrent !== "number" ||
    !Number.isInteger(c.maxConcurrent) ||
    c.maxConcurrent < 1
  ) {
    problems.push("`maxConcurrent` must be an integer >= 1");
  }
  const policy = c.dispatchPolicy ?? "labeled";
  if (policy !== "labeled" && policy !== "all-todo") {
    problems.push('`dispatchPolicy` must be "labeled" or "all-todo"');
  }
  if (policy === "labeled" && (typeof c.label !== "string" || c.label.trim() === "")) {
    problems.push('`label` is required when dispatchPolicy is "labeled"');
  }
  if (
    typeof c.projects !== "object" ||
    c.projects === null ||
    Object.keys(c.projects).length === 0
  ) {
    problems.push("`projects` must map at least one project key to { repo }");
  } else {
    for (const [key, project] of Object.entries(c.projects)) {
      if (typeof project?.repo !== "string" || project.repo.trim() === "") {
        problems.push(`projects.${key}.repo must be a path to a local git repo`);
      }
      if (project?.stack !== undefined) {
        problems.push(...validateWorkerStack(key, project.stack));
      }
      if (
        project?.baseBranch !== undefined &&
        (typeof project.baseBranch !== "string" || project.baseBranch.trim() === "")
      ) {
        problems.push(`projects.${key}.baseBranch must be a non-empty string when set`);
      }
    }
  }
  if (
    c.maxAnswersPerIssue !== undefined &&
    (typeof c.maxAnswersPerIssue !== "number" ||
      !Number.isInteger(c.maxAnswersPerIssue) ||
      c.maxAnswersPerIssue < 1)
  ) {
    problems.push("`maxAnswersPerIssue` must be an integer >= 1");
  }
  if (
    c.maxAnswerConcurrent !== undefined &&
    (typeof c.maxAnswerConcurrent !== "number" ||
      !Number.isInteger(c.maxAnswerConcurrent) ||
      c.maxAnswerConcurrent < 1)
  ) {
    problems.push("`maxAnswerConcurrent` must be an integer >= 1");
  }
  if (c.delivery !== undefined) {
    if (typeof c.delivery !== "object" || c.delivery === null || Array.isArray(c.delivery)) {
      problems.push("`delivery` must be an object");
    } else {
      const d = c.delivery as Record<string, unknown>;
      if (
        d.pollSeconds !== undefined &&
        (typeof d.pollSeconds !== "number" || !(d.pollSeconds > 0))
      ) {
        problems.push("`delivery.pollSeconds` must be a positive number");
      }
      if (
        d.cloneDir !== undefined &&
        (typeof d.cloneDir !== "string" || d.cloneDir.trim() === "")
      ) {
        problems.push("`delivery.cloneDir` must be a non-empty path");
      }
      for (const key of ["openPrs", "deploy"] as const) {
        if (d[key] !== undefined && typeof d[key] !== "boolean") {
          problems.push(`\`delivery.${key}\` must be true or false`);
        }
      }
    }
  }
  if (
    c.sessionTimeoutSeconds !== undefined &&
    (typeof c.sessionTimeoutSeconds !== "number" || !(c.sessionTimeoutSeconds > 0))
  ) {
    problems.push("`sessionTimeoutSeconds` must be a positive number");
  }
  if (c.githubPoll !== undefined) {
    if (typeof c.githubPoll !== "object" || c.githubPoll === null || Array.isArray(c.githubPoll)) {
      problems.push("`githubPoll` must be an object");
    } else {
      const g = c.githubPoll as Record<string, unknown>;
      if (
        g.pollSeconds !== undefined &&
        (typeof g.pollSeconds !== "number" || !(g.pollSeconds > 0))
      ) {
        problems.push("`githubPoll.pollSeconds` must be a positive number");
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
      !Array.isArray(ports) ||
      ports.some((p) => typeof p !== "number" || !Number.isInteger(p) || p <= 0);
    if (bad)
      problems.push(`projects.${projectKey}.stack.ports must be an array of positive integers`);
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
          problems.push(
            `projects.${projectKey}.stack.cli[${i}].check must be a non-empty command string`,
          );
        }
        if (e.install !== undefined && (typeof e.install !== "string" || e.install.trim() === "")) {
          problems.push(
            `projects.${projectKey}.stack.cli[${i}].install must be a non-empty string if set`,
          );
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

export type ClaudeBinDirResolution = { dir: string; volatile: boolean } | null;

/**
 * Resolves the directory to pin into a LaunchAgent PATH so spawned sessions
 * find a *real* `claude` (SYD-153 incident): `--install-launchd` run from
 * inside a terminal-manager session (cmux) sees `which claude` pointing at a
 * per-session shim under the temp dir. Baked into a persistent plist, that
 * shim can't resolve the actual binary under launchd and every bare-host
 * `claude -p` exits 127. Same principle as the SYD-97 node pin: persist real
 * install locations, never the installing shell's view.
 *
 * Prefers the `which` result when its directory is stable; otherwise probes
 * known install locations. Only if claude exists nowhere stable does it
 * return the volatile dir (flagged, so the caller can warn).
 */
export function findStableClaudeBinDir(opts: {
  whichPath: string | null;
  home: string;
  tmpdir: string;
  isExecutable: (path: string) => boolean;
}): ClaudeBinDirResolution {
  const isVolatile = (dir: string): boolean =>
    dir.includes("cmux-cli-shims") ||
    dir.startsWith(opts.tmpdir) ||
    dir.startsWith("/var/folders/") ||
    dir.startsWith("/tmp/") ||
    dir.startsWith("/private/tmp/");

  const whichDir = opts.whichPath ? opts.whichPath.replace(/\/[^/]+$/, "") : null;
  if (whichDir && !isVolatile(whichDir) && opts.isExecutable(`${whichDir}/claude`)) {
    return { dir: whichDir, volatile: false };
  }
  const knownDirs = [
    `${opts.home}/.local/bin`,
    `${opts.home}/.claude/local`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of knownDirs) {
    if (opts.isExecutable(`${dir}/claude`)) return { dir, volatile: false };
  }
  if (whichDir && opts.isExecutable(`${whichDir}/claude`)) {
    return { dir: whichDir, volatile: true };
  }
  return null;
}

/**
 * Checks an actual `process.version`-shaped string (e.g. "v24.1.0") against a
 * package.json `engines.node`-style range: space-separated comparators on the
 * major version (">=22", "<25", ">=22 <25"). Used by the doctor (SYD-97) to
 * check a *plist-pinned* node — not just the doctor process's own shell node
 * — against the band declared in package.json, since a LaunchAgent PATH can
 * silently drift to whatever node happened to install it. Unparseable input
 * on either side fails closed (returns false) rather than silently passing.
 */
export function nodeVersionSatisfiesEngines(range: string, actual: string): boolean {
  const actualMajor = parseInt(actual.replace(/^v/, ""), 10);
  if (Number.isNaN(actualMajor)) return false;
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  for (const comparator of comparators) {
    const m = /^(>=|<=|>|<|=)?(\d+)$/.exec(comparator);
    if (!m) return false;
    const op = m[1] ?? "=";
    const bound = parseInt(m[2], 10);
    if (op === ">=" && !(actualMajor >= bound)) return false;
    if (op === "<=" && !(actualMajor <= bound)) return false;
    if (op === ">" && !(actualMajor > bound)) return false;
    if (op === "<" && !(actualMajor < bound)) return false;
    if (op === "=" && !(actualMajor === bound)) return false;
  }
  return true;
}

/**
 * Enforces `engines.node` before a caller proceeds (SYD-200, used by
 * vitest.config.ts): a bare warning let an unsupported Node version continue
 * into a noisy, unrelated jsdom/native-module failure log instead of
 * stopping on the actual root cause. `io` is injected so this is
 * unit-testable without spawning a real process or depending on the
 * runner's actual `process.version`.
 */
export function enforceNodeEngines(
  enginesNode: string | undefined,
  actualVersion: string,
  io: { error: (message: string) => void; exit: (code: number) => void },
): void {
  if (!enginesNode || nodeVersionSatisfiesEngines(enginesNode, actualVersion)) return;
  io.error(
    `\n✗ running tests under node ${actualVersion}, outside the supported engines.node range "${enginesNode}". ` +
      `See .nvmrc and SYD-97 — install a supported Node version before running tests.\n`,
  );
  io.exit(1);
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
    [
      opts.nodeBinDir,
      ...(opts.extraPathDirs ?? []),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
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

/**
 * Insert a new `"KEY": { "repo": "..." }` entry into the `"projects"` block
 * of a switchyard-worker.json text, preserving the file's existing
 * formatting (indentation, line endings, everything outside that block)
 * instead of round-tripping through JSON.parse/stringify. Callers should
 * already have confirmed `key` is not present (see `validateWorkerConfig` /
 * a plain `key in config.projects` check) — this always appends.
 */
export function insertProjectIntoConfigText(text: string, key: string, repoPath: string): string {
  const keyMatch = /"projects"\s*:\s*\{/.exec(text);
  if (!keyMatch) {
    throw new Error('config has no `"projects": { ... }` block to insert into');
  }

  const openBraceIdx = keyMatch.index + keyMatch[0].length - 1;
  let depth = 0;
  let closeBraceIdx = -1;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBraceIdx = i;
        break;
      }
    }
  }
  if (closeBraceIdx === -1) {
    throw new Error('unbalanced braces in the `"projects"` block');
  }

  const body = text.slice(openBraceIdx + 1, closeBraceIdx);
  const entryValue = `{ "repo": ${JSON.stringify(repoPath)} }`;
  const lastEntryEnd = body.lastIndexOf("}");

  let newBody: string;
  if (lastEntryEnd === -1) {
    // No existing entries to model formatting on — derive an indent one
    // level deeper than the "projects" line itself.
    const lineStart = text.lastIndexOf("\n", keyMatch.index) + 1;
    const outerIndent = text.slice(lineStart, keyMatch.index);
    const indent = `${outerIndent}  `;
    newBody = `\n${indent}"${key}": ${entryValue}\n${outerIndent}`;
  } else {
    const indent = topLevelEntryIndent(body) ?? "  ";
    newBody =
      body.slice(0, lastEntryEnd + 1) +
      `,\n${indent}"${key}": ${entryValue}` +
      body.slice(lastEntryEnd + 1);
  }

  return text.slice(0, openBraceIdx + 1) + newBody + text.slice(closeBraceIdx);
}

/** Indentation of the last top-level (depth-0) `"key":` line in a JSON object body. */
function topLevelEntryIndent(body: string): string | null {
  let depth = 0;
  let indent: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"' && depth === 0) {
      const lineStart = body.lastIndexOf("\n", i) + 1;
      const candidate = body.slice(lineStart, i);
      if (/^[ \t]*$/.test(candidate)) indent = candidate;
    }
  }
  return indent;
}

/**
 * The docs/agent-kit.md CLAUDE.md snippet, parameterized with the project
 * key, to paste into a newly-onboarded repo so interactive sessions there
 * pick up Switchyard conventions immediately (see docs/onboarding-a-project.md
 * step 5).
 */
export function renderClaudeMdSnippet(key: string): string {
  return `## Switchyard conventions

This repo is tracked in Switchyard under the project key \`${key}\` (issue refs look like \`${key}-1\`).

- When asked "what should I work on" or when idle between tasks, call
  \`next_task\` before doing anything else.
- File ANY discovered work — bugs noticed, TODOs, follow-ups, flaky tests —
  with \`file_issue\`, even if it's not what you were asked to do. Write a
  decision-grade description: what's wrong or needed, why it matters (impact
  if ignored), and your suggested next action.
- Call \`claim_issue\` before starting work on an issue.
- Comment progress as you go (\`comment\`) — don't go silent on a claimed issue.
- If you're blocked on a decision only a human can make, use
  \`request_human_input\` instead of guessing.
- Before moving an issue to \`in_review\`, comment the verification evidence:
  what you did and how you verified it.
- NEVER move an issue to \`done\`. That's a human or review-step call, always.
- Branches: \`agent/<ref>\` is reserved for dispatched worker sessions.
`;
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
    .map(
      (s) =>
        `${s.role}: ${s.running ? "running" : s.installed ? "installed, not running" : "not installed"}`,
    )
    .join(", ");
  return {
    name: "worker roles",
    ok: true,
    warn: !anyRunning,
    note: anyRunning
      ? note
      : `${note} — nothing is running; install a LaunchAgent or start a loop by hand`,
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
 * What was captured from the operating human's own environment (SYD-82):
 * CLIs their configs reference (even when not installed locally — the
 * config is the expectation), enabled Claude Code plugins, and configured
 * MCP server names. `sources` lists which files actually contributed
 * something, for doctor notes and --capture-stack output. Every field can be
 * empty — an empty `cli` means no user expectation was captured at all, in
 * which case a project's hand-authored `stack.cli` (SYD-76) stays the sole
 * source of truth, per point 4 of SYD-82: this is a check on top of the
 * declaration, not a replacement for it.
 */
export type UserStackCapture = {
  cli: string[];
  plugins: string[];
  mcpServers: string[];
  sources: string[];
};

/**
 * Extracts CLI tool names from a `~/.claude/debate-acpx.json`-shaped file
 * (SYD-82): a per-user config declaring reviewer CLIs (e.g. codex, gemini)
 * the human's own debate/review tooling expects, regardless of whether
 * they're installed on this machine. Tolerant of several shapes so a
 * hand-authored file doesn't have to match one exact schema: a bare array of
 * names, an array of `{ name | cli | command }` objects, or either wrapped
 * in a top-level `reviewers`/`agents`/`cli` array property. Anything else
 * (missing file, unrecognized shape) yields no names — this is a best-effort
 * capture, not a validated config format.
 */
export function parseDebateAcpxReviewers(raw: unknown): string[] {
  const entries = extractReviewerList(raw);
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") names.push(entry.trim());
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      const name = e.cli ?? e.command ?? e.name;
      if (typeof name === "string" && name.trim() !== "") names.push(name.trim());
    }
  }
  return [...new Set(names)];
}

function extractReviewerList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    for (const key of ["reviewers", "agents", "cli"]) {
      if (Array.isArray(r[key])) return r[key] as unknown[];
    }
  }
  return [];
}

/**
 * Extracts enabled Claude Code plugin names from a `~/.claude/settings.json`-
 * shaped object's `enabledPlugins` field (SYD-82): either the marketplace
 * map form (`{ "name@marketplace": true }`, only `true` entries kept) or a
 * bare array of names. Missing/malformed input yields an empty list.
 */
export function parseEnabledPlugins(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const value = (raw as Record<string, unknown>).enabledPlugins;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
  }
  return [];
}

/**
 * Extracts configured MCP server names from a `~/.claude/settings.json` or
 * `~/.claude.json`-shaped object's top-level `mcpServers` map (SYD-82) — the
 * keys are the server names (e.g. "switchyard"), regardless of their
 * transport/config details. Missing/malformed input yields an empty list.
 */
export function parseMcpServerNames(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>);
}

/**
 * Diffs a captured list of CLI names the user's own environment expects
 * against a project's declared `stack.cli` (SYD-76), case-insensitively by
 * name. The result is what the doctor/--capture-stack surface as a parity
 * gap: tools the human works with that this project's workers wouldn't get.
 * An undeclared `stack.cli` (undefined) means everything captured is a gap.
 */
export function stackParityGaps(
  capturedCli: string[],
  declared: WorkerStackCli[] | undefined,
): string[] {
  const declaredNames = new Set((declared ?? []).map((c) => c.name.toLowerCase()));
  return capturedCli.filter((name) => !declaredNames.has(name.toLowerCase()));
}

/** One-line summary of a capture for doctor output — omits any field that captured nothing. */
export function formatUserStackCapture(capture: UserStackCapture): string {
  const parts: string[] = [];
  if (capture.cli.length > 0) parts.push(`cli: ${capture.cli.join(", ")}`);
  if (capture.plugins.length > 0) parts.push(`plugins: ${capture.plugins.join(", ")}`);
  if (capture.mcpServers.length > 0) parts.push(`mcp: ${capture.mcpServers.join(", ")}`);
  return `${parts.join("; ")} (from ${capture.sources.join(", ")})`;
}

/**
 * Install commands for a small set of common reviewer CLIs we're confident
 * enough about to pre-fill and let `--repair-stack` run unattended (SYD-87
 * point 3) — narrow and hand-curated on purpose. Everything outside this
 * list still gets `install` left unset by `suggestStackCli`, per the "wrong
 * guess is worse than an honest gap" rule below.
 */
const WELL_KNOWN_CLI_INSTALL: Record<string, string> = {
  gh: "brew install gh",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli",
};

/** Looks up a well-known install command by CLI name, case-insensitively. */
export function wellKnownCliInstall(name: string): string | undefined {
  return WELL_KNOWN_CLI_INSTALL[name.toLowerCase()];
}

/**
 * Turns captured CLI names into paste-ready `stack.cli` entries (SYD-82
 * point 2/3, `--capture-stack`). `install` is pre-filled for the small
 * well-known set above (SYD-87 point 3) and otherwise deliberately left
 * unset — there's no reliable way to infer an install command from an
 * arbitrary tool name, and a wrong guess is worse than an honest gap: an
 * operator fills it in, or `--repair-stack` reports it as unrepairable
 * rather than running something unintended.
 */
export function suggestStackCli(names: string[]): WorkerStackCli[] {
  return names.map((name) => {
    const install = wellKnownCliInstall(name);
    return install
      ? { name, check: `${name} --version`, install }
      : { name, check: `${name} --version` };
  });
}

/**
 * Lines for the containerized "add these to Dockerfile.worker" guidance
 * (SYD-76's `--repair-stack`), extended to also cover captured-but-undeclared
 * gaps (SYD-87 point 2) alongside declared-but-missing `stack.cli` entries,
 * so one container rebuild can close both kinds of gap. Captured entries are
 * labeled distinctly since they aren't in `stack.cli` yet — the operator
 * still needs to add them there (e.g. via `--capture-stack`) for the parity
 * warning to stop firing.
 */
export function formatDockerfileStackGuidance(
  declared: WorkerStackCli[],
  capturedGaps: string[],
): string[] {
  const lines = declared.map(
    (c) => `  - ${c.name}: ${c.install ?? "(no install command declared)"}`,
  );
  for (const c of suggestStackCli(capturedGaps)) {
    lines.push(
      `  - ${c.name} (captured, not yet in stack.cli): ${c.install ?? "(no install command known)"}`,
    );
  }
  return lines;
}

/**
 * argv + stdin payload for `gh api -X PUT .../branches/main/protection`: the
 * standard force-push/deletion block used across onboarded repos (see
 * docs/onboarding-a-project.md step 4). Required reviews stay off until
 * there's a second GitHub identity to review with (SYD-19).
 */
export function buildProtectMainArgs(
  owner: string,
  repo: string,
): { args: string[]; input: string } {
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
        2,
      ) + "\n",
  };
}
