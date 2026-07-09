import { describe, expect, it } from "vitest";
import {
  buildProtectMainArgs,
  DELIVER_LAUNCHD_LABEL,
  WORKER_LAUNCHD_LABEL,
  WORKER_CODE_LAUNCHD_LABEL,
  WORKER_ANSWER_LAUNCHD_LABEL,
  formatChecks,
  parseDotEnv,
  parseGithubRemote,
  renderDeliverPlist,
  renderWorkerPlist,
  summarizeRoleStatus,
  validateWorkerConfig,
  workerLaunchdLabel,
} from "../scripts/init-worker-lib.js";

describe("parseDotEnv", () => {
  it("parses flat KEY=VALUE lines, skipping comments and blanks", () => {
    const env = parseDotEnv(
      "# tokens\nSWITCHYARD_URL=http://x:3300\n\nSWITCHYARD_TOKEN=syd_abc\n"
    );
    expect(env).toEqual({ SWITCHYARD_URL: "http://x:3300", SWITCHYARD_TOKEN: "syd_abc" });
  });

  it("strips quotes and the export prefix", () => {
    const env = parseDotEnv('export A="quoted value"\nB=\'single\'\nC=bare');
    expect(env).toEqual({ A: "quoted value", B: "single", C: "bare" });
  });

  it("keeps = signs inside values and ignores malformed lines", () => {
    const env = parseDotEnv("TOKEN=abc==\nnot a var line\n1BAD=x");
    expect(env).toEqual({ TOKEN: "abc==" });
  });

  it("does not mangle values with spaces or shell metacharacters", () => {
    // The worker reads .env directly (no shell sourcing), so these must
    // survive verbatim — a bash `. .env` would have executed or expanded them.
    const env = parseDotEnv("A=a b && rm -rf /\nB=has$dollar`backtick`");
    expect(env).toEqual({ A: "a b && rm -rf /", B: "has$dollar`backtick`" });
  });
});

describe("validateWorkerConfig", () => {
  const good = {
    url: "http://100.85.158.109:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/Users/sean/sites/switchyard" } },
    dispatchPolicy: "all-todo",
  };

  it("accepts the example-shaped config", () => {
    expect(validateWorkerConfig(good)).toEqual([]);
  });

  it("rejects non-objects", () => {
    expect(validateWorkerConfig(null)).toHaveLength(1);
    expect(validateWorkerConfig([])).toHaveLength(1);
  });

  it("requires an http(s) url, positive interval, integer maxConcurrent", () => {
    const problems = validateWorkerConfig({
      ...good,
      url: "ftp://x",
      intervalSeconds: 0,
      maxConcurrent: 1.5,
    });
    expect(problems).toHaveLength(3);
  });

  it("requires label only under the labeled policy", () => {
    const noLabel = { ...good, label: undefined };
    expect(validateWorkerConfig({ ...noLabel, dispatchPolicy: "all-todo" })).toEqual([]);
    expect(validateWorkerConfig({ ...noLabel, dispatchPolicy: "labeled" })).toEqual([
      '`label` is required when dispatchPolicy is "labeled"',
    ]);
  });

  it("rejects empty or repo-less projects and unknown policies", () => {
    expect(validateWorkerConfig({ ...good, projects: {} })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, projects: { SYD: {} } })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, dispatchPolicy: "yolo" })).toHaveLength(1);
  });

  it("rejects a bare scheme url and a string containerized flag", () => {
    expect(validateWorkerConfig({ ...good, url: "http://" })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, containerized: "true" })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, containerized: true })).toEqual([]);
  });

  it("accepts runner cli/sdk, rejects unknown runners and sdk+containerized", () => {
    expect(validateWorkerConfig({ ...good, runner: "cli" })).toEqual([]);
    expect(validateWorkerConfig({ ...good, runner: "sdk" })).toEqual([]);
    expect(validateWorkerConfig({ ...good, runner: "codex" })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, runner: "sdk", containerized: true })).toHaveLength(1);
  });

  it("accepts an absent maxAnswersPerIssue and rejects a non-positive-integer one", () => {
    expect(validateWorkerConfig(good)).toEqual([]);
    expect(validateWorkerConfig({ ...good, maxAnswersPerIssue: 5 })).toEqual([]);
    expect(validateWorkerConfig({ ...good, maxAnswersPerIssue: 0 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, maxAnswersPerIssue: 1.5 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, maxAnswersPerIssue: "3" })).toHaveLength(1);
  });

  it("accepts an absent maxAnswerConcurrent and rejects a non-positive-integer one (SYD-67)", () => {
    expect(validateWorkerConfig(good)).toEqual([]);
    expect(validateWorkerConfig({ ...good, maxAnswerConcurrent: 2 })).toEqual([]);
    expect(validateWorkerConfig({ ...good, maxAnswerConcurrent: 0 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, maxAnswerConcurrent: 1.5 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, maxAnswerConcurrent: "2" })).toHaveLength(1);
  });

  describe("validateWorkerConfig delivery block", () => {
    const base = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 300,
      maxConcurrent: 1,
      projects: { SYD: { repo: "/repo" } },
    };

    it("accepts a valid delivery block", () => {
      expect(validateWorkerConfig({
        ...base,
        delivery: { openPrs: true, pollSeconds: 30, cloneDir: "/tmp/clones", deploy: false, verify: false },
      })).toEqual([]);
    });

    it("accepts an absent delivery block", () => {
      expect(validateWorkerConfig(base)).toEqual([]);
    });

    it("rejects a non-object delivery block", () => {
      expect(validateWorkerConfig({ ...base, delivery: "yes" }).join()).toContain("delivery");
    });

    it("rejects bad field types", () => {
      const problems = validateWorkerConfig({
        ...base,
        delivery: { openPrs: "true", pollSeconds: -5, cloneDir: "", deploy: 1, verify: "yes" },
      });
      expect(problems.some((p) => p.includes("delivery.openPrs"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.pollSeconds"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.cloneDir"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.deploy"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.verify"))).toBe(true);
    });
  });
});

describe("renderWorkerPlist", () => {
  const plist = renderWorkerPlist({
    repoRoot: "/Users/sean/sites/switchyard",
    nodeBinDir: "/Users/sean/.nvm/versions/node/v24.13.0/bin",
    home: "/Users/sean",
  });

  it("execs tsx directly (no shell) and embeds no secret material", () => {
    expect(plist).toContain("<string>com.switchyard.worker</string>");
    expect(plist).toContain("<string>/Users/sean/sites/switchyard/node_modules/.bin/tsx</string>");
    expect(plist).toContain("<string>/Users/sean/sites/switchyard/scripts/agent-worker.ts</string>");
    expect(plist).not.toContain("/bin/bash");
    expect(plist).not.toContain(".env");
    // No secret material may ever appear in the plist (world-readable).
    expect(plist).not.toMatch(/syd_|sya_|sk-ant|OAUTH/);
  });

  it("restarts on crash only — a clean exit must stay down", () => {
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/
    );
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("pins PATH to the given node install plus extra dirs for launchd", () => {
    expect(plist).toContain("/Users/sean/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin");
    const withClaude = renderWorkerPlist({
      repoRoot: "/r",
      nodeBinDir: "/n",
      home: "/h",
      extraPathDirs: ["/Users/sean/.local/bin"],
    });
    expect(withClaude).toContain("/n:/Users/sean/.local/bin:/opt/homebrew/bin");
  });

  it("escapes XML-significant characters in paths, everywhere they appear", () => {
    const weird = renderWorkerPlist({
      repoRoot: "/tmp/it's <a>&b",
      nodeBinDir: "/usr/bin",
      home: "/Users/sean",
    });
    expect(weird).toContain("<string>/tmp/it's &lt;a&gt;&amp;b/node_modules/.bin/tsx</string>");
    expect(weird).not.toContain("<a>&b");
  });

  it("omits --role entirely for the default all role, matching pre-split output", () => {
    expect(plist).not.toContain("--role");
  });

  describe("role split (SYD-67)", () => {
    const base = { repoRoot: "/r", nodeBinDir: "/n", home: "/h" };

    it("passes --role code / answer as separate argv entries, and picks the role's label", () => {
      const code = renderWorkerPlist({ ...base, role: "code" });
      expect(code).toContain(`<string>${WORKER_CODE_LAUNCHD_LABEL}</string>`);
      expect(code).toContain("<string>--role</string>");
      expect(code).toContain("<string>code</string>");
      expect(code).toContain("<string>/r/scripts/agent-worker.ts</string>");

      const answer = renderWorkerPlist({ ...base, role: "answer" });
      expect(answer).toContain(`<string>${WORKER_ANSWER_LAUNCHD_LABEL}</string>`);
      expect(answer).toContain("<string>--role</string>");
      expect(answer).toContain("<string>answer</string>");
    });

    it("logs code/answer roles to their own launchd-<role>.{out,err}.log", () => {
      const code = renderWorkerPlist({ ...base, role: "code" });
      expect(code).toContain("worker-logs/launchd-code.out.log");
      expect(code).toContain("worker-logs/launchd-code.err.log");
    });

    it("role: all is byte-identical to the no-role-passed default", () => {
      expect(renderWorkerPlist({ ...base, role: "all" })).toBe(renderWorkerPlist(base));
    });
  });
});

describe("workerLaunchdLabel", () => {
  it("maps each role to a distinct label", () => {
    expect(workerLaunchdLabel("all")).toBe(WORKER_LAUNCHD_LABEL);
    expect(workerLaunchdLabel("code")).toBe(WORKER_CODE_LAUNCHD_LABEL);
    expect(workerLaunchdLabel("answer")).toBe(WORKER_ANSWER_LAUNCHD_LABEL);
    const labels = new Set([workerLaunchdLabel("all"), workerLaunchdLabel("code"), workerLaunchdLabel("answer")]);
    expect(labels.size).toBe(3);
  });
});

describe("summarizeRoleStatus", () => {
  it("does not fail when no role is running, but warns", () => {
    const check = summarizeRoleStatus([
      { role: "all", running: false, installed: false },
      { role: "code", running: false, installed: false },
      { role: "answer", running: false, installed: false },
    ]);
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.note).toMatch(/nothing is running/i);
  });

  it("does not warn when at least one role is running", () => {
    const check = summarizeRoleStatus([
      { role: "all", running: false, installed: false },
      { role: "code", running: true, installed: true },
      { role: "answer", running: false, installed: false },
    ]);
    expect(check.warn).toBeFalsy();
    expect(check.note).toContain("code: running");
  });

  it("distinguishes installed-but-not-running from not-installed", () => {
    const check = summarizeRoleStatus([
      { role: "all", running: false, installed: false },
      { role: "code", running: false, installed: true },
      { role: "answer", running: true, installed: true },
    ]);
    expect(check.note).toContain("all: not installed");
    expect(check.note).toContain("code: installed, not running");
    expect(check.note).toContain("answer: running");
  });
});

describe("formatChecks", () => {
  it("marks pass, warn, and fail distinctly", () => {
    const out = formatChecks([
      { name: "node", ok: true },
      { name: "slack", ok: true, warn: true, note: "SLACK_WEBHOOK_URL not set" },
      { name: "server", ok: false, note: "unreachable" },
    ]);
    expect(out).toBe("✓ node\n⚠ slack — SLACK_WEBHOOK_URL not set\n✗ server — unreachable");
  });
});

describe("renderDeliverPlist", () => {
  const plist = renderDeliverPlist({
    repoRoot: "/Users/sean/sites/switchyard",
    nodeBinDir: "/Users/sean/.nvm/versions/node/v24.13.0/bin",
    home: "/Users/sean",
  });

  it("execs tsx against deliver.ts under its own label, distinct from the worker's", () => {
    expect(plist).toContain(`<string>${DELIVER_LAUNCHD_LABEL}</string>`);
    expect(DELIVER_LAUNCHD_LABEL).not.toBe("com.switchyard.worker");
    expect(plist).toContain("<string>/Users/sean/sites/switchyard/node_modules/.bin/tsx</string>");
    expect(plist).toContain("<string>/Users/sean/sites/switchyard/scripts/deliver.ts</string>");
    expect(plist).not.toContain("agent-worker.ts");
    expect(plist).not.toContain("/bin/bash");
    expect(plist).not.toContain(".env");
    expect(plist).not.toMatch(/syd_|sya_|sk-ant|OAUTH/);
  });

  it("restarts on crash only, same as the worker plist", () => {
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/
    );
  });

  it("logs to its own deliver.{out,err}.log, not the worker's launchd.*.log", () => {
    expect(plist).toContain("worker-logs/deliver.out.log");
    expect(plist).toContain("worker-logs/deliver.err.log");
    expect(plist).not.toContain("launchd.out.log");
  });
});

describe("parseGithubRemote", () => {
  it("parses the SSH form", () => {
    expect(parseGithubRemote("git@github.com:seanperkins/nocturne.git")).toEqual({
      owner: "seanperkins",
      repo: "nocturne",
    });
  });

  it("parses the SSH form without a .git suffix", () => {
    expect(parseGithubRemote("git@github.com:seanperkins/nocturne")).toEqual({
      owner: "seanperkins",
      repo: "nocturne",
    });
  });

  it("parses the https form, with and without .git", () => {
    expect(parseGithubRemote("https://github.com/seanperkins/nocturne.git")).toEqual({
      owner: "seanperkins",
      repo: "nocturne",
    });
    expect(parseGithubRemote("https://github.com/seanperkins/nocturne")).toEqual({
      owner: "seanperkins",
      repo: "nocturne",
    });
  });

  it("parses the ssh:// form", () => {
    expect(parseGithubRemote("ssh://git@github.com/seanperkins/nocturne.git")).toEqual({
      owner: "seanperkins",
      repo: "nocturne",
    });
  });

  it("returns null for a local path or a non-GitHub host", () => {
    expect(parseGithubRemote("/origin")).toBeNull();
    expect(parseGithubRemote("/Users/sean/sites/piano-game")).toBeNull();
    expect(parseGithubRemote("git@gitlab.com:seanperkins/nocturne.git")).toBeNull();
    expect(parseGithubRemote("https://example.com/seanperkins/nocturne")).toBeNull();
  });
});

describe("buildProtectMainArgs", () => {
  it("targets the right repo's branches/main/protection endpoint via PUT", () => {
    const { args } = buildProtectMainArgs("seanperkins", "nocturne");
    expect(args).toEqual([
      "api",
      "-X",
      "PUT",
      "repos/seanperkins/nocturne/branches/main/protection",
      "--input",
      "-",
    ]);
  });

  it("blocks force-push and deletion, leaves required reviews off", () => {
    const { input } = buildProtectMainArgs("seanperkins", "nocturne");
    const body = JSON.parse(input);
    expect(body).toEqual({
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  });
});
