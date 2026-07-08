import { describe, expect, it } from "vitest";
import {
  formatChecks,
  parseDotEnv,
  renderWorkerPlist,
  validateWorkerConfig,
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
        delivery: { openPrs: true, pollSeconds: 30, cloneDir: "/tmp/clones", deploy: false },
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
        delivery: { openPrs: "true", pollSeconds: -5, cloneDir: "", deploy: 1 },
      });
      expect(problems.some((p) => p.includes("delivery.openPrs"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.pollSeconds"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.cloneDir"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.deploy"))).toBe(true);
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
