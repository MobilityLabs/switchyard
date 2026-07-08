import { describe, expect, it } from "vitest";
import {
  formatChecks,
  parseDotEnv,
  renderWorkerPlist,
  shellQuote,
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
});

describe("renderWorkerPlist", () => {
  const plist = renderWorkerPlist({
    repoRoot: "/Users/sean/sites/switchyard",
    nodeBinDir: "/Users/sean/.nvm/versions/node/v24.13.0/bin",
    home: "/Users/sean",
  });

  it("is a KeepAlive LaunchAgent that sources .env instead of embedding tokens", () => {
    expect(plist).toContain("<string>com.switchyard.worker</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain(". ./.env");
    expect(plist).toContain("exec npx tsx scripts/agent-worker.ts");
    // No secret material may ever appear in the plist (world-readable).
    expect(plist).not.toMatch(/syd_|sya_|sk-ant|OAUTH/);
  });

  it("pins PATH to the given node install for launchd", () => {
    expect(plist).toContain("/Users/sean/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin");
  });

  it("escapes XML-significant characters in paths", () => {
    const weird = renderWorkerPlist({
      repoRoot: "/tmp/a&b<c>",
      nodeBinDir: "/usr/bin",
      home: "/Users/sean",
    });
    expect(weird).toContain("/tmp/a&amp;b&lt;c&gt;");
    expect(weird).not.toContain("a&b<c>");
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes and escapes embedded quotes", () => {
    expect(shellQuote("/plain/path")).toBe("'/plain/path'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
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
