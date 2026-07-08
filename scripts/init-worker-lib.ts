// Pure helpers for scripts/init-worker.ts (SYD-44).
// Kept separate from the CLI so parsing, validation, and plist rendering are
// trivially unit-testable without touching the filesystem or network.

import type { WorkerConfig } from "./worker-select.js";

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
    }
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
      for (const key of ["openPrs", "deploy"] as const) {
        if (d[key] !== undefined && typeof d[key] !== "boolean") {
          problems.push(`\`delivery.${key}\` must be true or false`);
        }
      }
    }
  }
  return problems;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const WORKER_LAUNCHD_LABEL = "com.switchyard.worker";

/**
 * Render the LaunchAgent plist that keeps the worker loop alive across
 * logout/reboot. No shell is involved — launchd execs tsx directly, so there
 * is no quoting surface at all; the worker reads the repo .env itself, so no
 * secret ever touches this (world-readable) plist. `nodeBinDir` pins PATH to
 * a concrete node install (launchd doesn't source shell profiles, so
 * nvm-managed node is invisible without it); `extraPathDirs` carries e.g. the
 * resolved directory of the `claude` binary for bare-host mode.
 */
export function renderWorkerPlist(opts: {
  repoRoot: string;
  nodeBinDir: string;
  home: string;
  extraPathDirs?: string[];
}): string {
  const repo = escapeXml(opts.repoRoot);
  const path = escapeXml(
    [opts.nodeBinDir, ...(opts.extraPathDirs ?? []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":")
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`npm run init-worker -- --install-launchd\`. Re-run that to update. -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WORKER_LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${repo}/node_modules/.bin/tsx</string>
        <string>${repo}/scripts/agent-worker.ts</string>
    </array>

    <!-- Restart on crash only; a clean exit (SIGINT handler, launchctl unload)
         stays down instead of respawning forever. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- If the worker crash-loops, don't respawn faster than every 30s. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>WorkingDirectory</key>
    <string>${repo}</string>

    <key>StandardOutPath</key>
    <string>${repo}/.superpowers/worker-logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${repo}/.superpowers/worker-logs/launchd.err.log</string>

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

export type CheckResult = { name: string; ok: boolean; note?: string; warn?: boolean };

/** Format doctor results as aligned ✓/✗ lines. */
export function formatChecks(results: CheckResult[]): string {
  return results
    .map((r) => {
      const mark = r.ok ? (r.warn ? "⚠" : "✓") : "✗";
      return `${mark} ${r.name}${r.note ? ` — ${r.note}` : ""}`;
    })
    .join("\n");
}
