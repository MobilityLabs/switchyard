import { describe, expect, it } from "vitest";
import {
  buildProtectMainArgs,
  DELIVER_LAUNCHD_LABEL,
  WORKER_LAUNCHD_LABEL,
  WORKER_CODE_LAUNCHD_LABEL,
  WORKER_ANSWER_LAUNCHD_LABEL,
  formatChecks,
  formatDockerfileStackGuidance,
  formatUserStackCapture,
  nodeVersionSatisfies,
  nodeVersionSatisfiesEngines,
  insertProjectIntoConfigText,
  parseDebateAcpxReviewers,
  parseDotEnv,
  parseEnabledPlugins,
  parseGithubRemote,
  parseMcpServerNames,
  parsePlistPath,
  renderDeliverPlist,
  renderClaudeMdSnippet,
  renderWorkerPlist,
  stackParityGaps,
  suggestStackCli,
  summarizeRoleStatus,
  validateWorkerConfig,
  wellKnownCliInstall,
  workerLaunchdLabel,
  type UserStackCapture,
  findStableClaudeBinDir,
} from "../scripts/init-worker-lib.js";

describe("parseDotEnv", () => {
  it("parses flat KEY=VALUE lines, skipping comments and blanks", () => {
    const env = parseDotEnv("# tokens\nSWITCHYARD_URL=http://x:3300\n\nSWITCHYARD_TOKEN=syd_abc\n");
    expect(env).toEqual({ SWITCHYARD_URL: "http://x:3300", SWITCHYARD_TOKEN: "syd_abc" });
  });

  it("strips quotes and the export prefix", () => {
    const env = parseDotEnv("export A=\"quoted value\"\nB='single'\nC=bare");
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

describe("findStableClaudeBinDir", () => {
  // The SYD-153 incident: --install-launchd run inside a cmux session baked
  // `dirname $(which claude)` — a per-session shim in a temp dir — into the
  // plist PATH; under launchd the shim can't resolve a real claude and every
  // answer session exits 127.
  const home = "/Users/sean";
  const tmpdir = "/var/folders/xx/yyy/T";

  it("rejects a which-result inside a temp shim dir and falls back to a known install location", () => {
    const shimDir = `${tmpdir}/cmux-cli-shims/ABC123`;
    const resolved = findStableClaudeBinDir({
      whichPath: `${shimDir}/claude`,
      home,
      tmpdir,
      isExecutable: (p) => p === `${shimDir}/claude` || p === `${home}/.local/bin/claude`,
    });
    expect(resolved).toEqual({ dir: `${home}/.local/bin`, volatile: false });
  });

  it("accepts a which-result in a stable directory as-is", () => {
    const resolved = findStableClaudeBinDir({
      whichPath: "/opt/homebrew/bin/claude",
      home,
      tmpdir,
      isExecutable: (p) => p === "/opt/homebrew/bin/claude",
    });
    expect(resolved).toEqual({ dir: "/opt/homebrew/bin", volatile: false });
  });

  it("returns the volatile dir, flagged, when no stable install exists anywhere", () => {
    const shimDir = `${tmpdir}/cmux-cli-shims/ABC123`;
    const resolved = findStableClaudeBinDir({
      whichPath: `${shimDir}/claude`,
      home,
      tmpdir,
      isExecutable: (p) => p === `${shimDir}/claude`,
    });
    expect(resolved).toEqual({ dir: shimDir, volatile: true });
  });

  it("finds a known location even when which finds nothing at all", () => {
    const resolved = findStableClaudeBinDir({
      whichPath: null,
      home,
      tmpdir,
      isExecutable: (p) => p === `${home}/.claude/local/claude`,
    });
    expect(resolved).toEqual({ dir: `${home}/.claude/local`, volatile: false });
  });

  it("returns null when claude is nowhere to be found", () => {
    expect(
      findStableClaudeBinDir({ whichPath: null, home, tmpdir, isExecutable: () => false }),
    ).toBeNull();
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

  it("accepts valid egress values and rejects unknown ones (SYD-110)", () => {
    expect(validateWorkerConfig({ ...good, egress: "proxy" })).toEqual([]);
    expect(validateWorkerConfig({ ...good, egress: "open" })).toEqual([]);
    expect(validateWorkerConfig({ ...good, egress: "none" })).toEqual([
      '`egress` must be "proxy" or "open"',
    ]);
    expect(validateWorkerConfig({ ...good, egressAllow: "github.com" })).toEqual([
      "`egressAllow` must be an array of hostnames",
    ]);
    expect(validateWorkerConfig({ ...good, egressAllow: ["github.com"] })).toEqual([]);
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

  it("accepts an optional per-project baseBranch and rejects an empty one", () => {
    expect(
      validateWorkerConfig({
        ...good,
        projects: { SYD: { repo: "/repo", baseBranch: "develop" } },
      }),
    ).toEqual([]);
    expect(
      validateWorkerConfig({
        ...good,
        projects: { SYD: { repo: "/repo", baseBranch: "" } },
      }),
    ).toHaveLength(1);
    expect(
      validateWorkerConfig({
        ...good,
        projects: { SYD: { repo: "/repo", baseBranch: 5 } },
      }),
    ).toHaveLength(1);
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

  it("accepts an absent sessionTimeoutSeconds and rejects a non-positive one (SYD-115)", () => {
    expect(validateWorkerConfig(good)).toEqual([]);
    expect(validateWorkerConfig({ ...good, sessionTimeoutSeconds: 1800 })).toEqual([]);
    expect(validateWorkerConfig({ ...good, sessionTimeoutSeconds: 0 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, sessionTimeoutSeconds: -60 })).toHaveLength(1);
    expect(validateWorkerConfig({ ...good, sessionTimeoutSeconds: "3600" })).toHaveLength(1);
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
      expect(
        validateWorkerConfig({
          ...base,
          delivery: {
            openPrs: true,
            pollSeconds: 30,
            cloneDir: "/tmp/clones",
            deploy: false,
            verify: false,
            autoRebase: true,
            reconcile: true,
            conflictResolution: true,
          },
        }),
      ).toEqual([]);
    });

    it("accepts delivery.mode 'legacy' or 'queue' (SYD-164)", () => {
      expect(validateWorkerConfig({ ...base, delivery: { mode: "legacy" } })).toEqual([]);
      expect(validateWorkerConfig({ ...base, delivery: { mode: "queue" } })).toEqual([]);
    });

    it("rejects an unknown delivery.mode", () => {
      const problems = validateWorkerConfig({ ...base, delivery: { mode: "yolo" } });
      expect(problems.some((p) => p.includes("delivery.mode"))).toBe(true);
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
        delivery: {
          openPrs: "true",
          pollSeconds: -5,
          cloneDir: "",
          deploy: 1,
          verify: "yes",
          autoRebase: "nope",
          reconcile: "nope",
          conflictResolution: "nope",
        },
      });
      expect(problems.some((p) => p.includes("delivery.openPrs"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.pollSeconds"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.cloneDir"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.deploy"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.verify"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.autoRebase"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.reconcile"))).toBe(true);
      expect(problems.some((p) => p.includes("delivery.conflictResolution"))).toBe(true);
    });
  });

  describe("validateWorkerConfig stack block (SYD-76)", () => {
    const base = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 300,
      maxConcurrent: 1,
    };

    it("accepts a project with no stack declared", () => {
      expect(validateWorkerConfig({ ...base, projects: { SYD: { repo: "/repo" } } })).toEqual([]);
    });

    it("accepts a fully-populated stack block", () => {
      expect(
        validateWorkerConfig({
          ...base,
          projects: {
            SYD: {
              repo: "/repo",
              stack: {
                node: "20",
                cli: [{ name: "gh", check: "gh --version", install: "brew install gh" }],
                ports: [3300],
              },
            },
          },
        }),
      ).toEqual([]);
    });

    it("rejects a non-object stack", () => {
      const problems = validateWorkerConfig({
        ...base,
        projects: { SYD: { repo: "/repo", stack: "yes" } },
      });
      expect(problems.some((p) => p.includes("stack"))).toBe(true);
    });

    it("rejects a non-string node", () => {
      const problems = validateWorkerConfig({
        ...base,
        projects: { SYD: { repo: "/repo", stack: { node: 20 } } },
      });
      expect(problems.some((p) => p.includes("stack.node"))).toBe(true);
    });

    it("rejects a non-array ports and non-positive-integer entries", () => {
      expect(
        validateWorkerConfig({
          ...base,
          projects: { SYD: { repo: "/repo", stack: { ports: "3300" } } },
        }).some((p) => p.includes("stack.ports")),
      ).toBe(true);
      expect(
        validateWorkerConfig({
          ...base,
          projects: { SYD: { repo: "/repo", stack: { ports: [0, -1, 1.5] } } },
        }).some((p) => p.includes("stack.ports")),
      ).toBe(true);
    });

    it("rejects a non-array cli", () => {
      const problems = validateWorkerConfig({
        ...base,
        projects: { SYD: { repo: "/repo", stack: { cli: "gh" } } },
      });
      expect(problems.some((p) => p.includes("stack.cli"))).toBe(true);
    });

    it("rejects a cli entry missing name or check", () => {
      const problems = validateWorkerConfig({
        ...base,
        projects: { SYD: { repo: "/repo", stack: { cli: [{ install: "brew install gh" }] } } },
      });
      expect(problems.some((p) => p.includes("stack.cli[0].name"))).toBe(true);
      expect(problems.some((p) => p.includes("stack.cli[0].check"))).toBe(true);
    });

    it("rejects a blank install string", () => {
      const problems = validateWorkerConfig({
        ...base,
        projects: {
          SYD: {
            repo: "/repo",
            stack: { cli: [{ name: "gh", check: "gh --version", install: "" }] },
          },
        },
      });
      expect(problems.some((p) => p.includes("stack.cli[0].install"))).toBe(true);
    });
  });
});

describe("validateWorkerConfig githubPoll block (SYD-71)", () => {
  const base = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    projects: { SYD: { repo: "/repo" } },
  };

  it("accepts a valid githubPoll block", () => {
    expect(validateWorkerConfig({ ...base, githubPoll: { pollSeconds: 120 } })).toEqual([]);
  });

  it("accepts an absent githubPoll block", () => {
    expect(validateWorkerConfig(base)).toEqual([]);
  });

  it("rejects a non-object githubPoll block", () => {
    expect(validateWorkerConfig({ ...base, githubPoll: "yes" }).join()).toContain("githubPoll");
  });

  it("rejects a non-positive pollSeconds", () => {
    const problems = validateWorkerConfig({ ...base, githubPoll: { pollSeconds: -5 } });
    expect(problems.some((p) => p.includes("githubPoll.pollSeconds"))).toBe(true);
  });
});

describe("nodeVersionSatisfies", () => {
  it("accepts an actual version at or above the required major", () => {
    expect(nodeVersionSatisfies("20", "v20.0.0")).toBe(true);
    expect(nodeVersionSatisfies("20", "24.1.0")).toBe(true);
    expect(nodeVersionSatisfies("20", "20.19.5")).toBe(true);
  });

  it("rejects an actual version below the required major", () => {
    expect(nodeVersionSatisfies("20", "v18.20.0")).toBe(false);
  });

  it("rejects unparseable input on either side", () => {
    expect(nodeVersionSatisfies("nope", "v20.0.0")).toBe(false);
    expect(nodeVersionSatisfies("20", "not-a-version")).toBe(false);
  });
});

describe("nodeVersionSatisfiesEngines (SYD-97)", () => {
  it("accepts a version inside a lower-bound-only range", () => {
    expect(nodeVersionSatisfiesEngines(">=22", "v24.13.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines(">=22", "v20.0.0")).toBe(false);
  });

  it("accepts a version inside a two-sided range and rejects outside it", () => {
    expect(nodeVersionSatisfiesEngines(">=22 <25", "v22.0.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines(">=22 <25", "v24.13.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines(">=22 <25", "v25.4.0")).toBe(false);
    expect(nodeVersionSatisfiesEngines(">=22 <25", "v20.0.0")).toBe(false);
  });

  it("supports <=, >, < and bare = comparators", () => {
    expect(nodeVersionSatisfiesEngines("<=24", "v24.13.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines("<=24", "v25.0.0")).toBe(false);
    expect(nodeVersionSatisfiesEngines(">20", "v20.0.0")).toBe(false);
    expect(nodeVersionSatisfiesEngines("<25", "v24.0.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines("24", "v24.13.0")).toBe(true);
    expect(nodeVersionSatisfiesEngines("24", "v25.0.0")).toBe(false);
  });

  it("rejects unparseable input on either side", () => {
    expect(nodeVersionSatisfiesEngines(">=22", "not-a-version")).toBe(false);
    expect(nodeVersionSatisfiesEngines("not-a-range", "v24.0.0")).toBe(false);
    expect(nodeVersionSatisfiesEngines("", "v24.0.0")).toBe(false);
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
    expect(plist).toContain(
      "<string>/Users/sean/sites/switchyard/scripts/agent-worker.ts</string>",
    );
    expect(plist).not.toContain("/bin/bash");
    expect(plist).not.toContain(".env");
    // No secret material may ever appear in the plist (world-readable).
    expect(plist).not.toMatch(/syd_|sya_|sk-ant|OAUTH/);
  });

  it("restarts on crash only — a clean exit must stay down", () => {
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
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

describe("parsePlistPath", () => {
  it("extracts the colon-joined PATH dirs from a rendered plist (SYD-74)", () => {
    const plist = renderWorkerPlist({
      repoRoot: "/r",
      nodeBinDir: "/n",
      home: "/h",
      extraPathDirs: ["/Users/sean/.local/bin"],
    });
    expect(parsePlistPath(plist)).toEqual([
      "/n",
      "/Users/sean/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("omits extraPathDirs entirely when none were given, matching the pre-SYD-74 default", () => {
    const plist = renderWorkerPlist({ repoRoot: "/r", nodeBinDir: "/n", home: "/h" });
    expect(parsePlistPath(plist)).toEqual([
      "/n",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("returns an empty list for XML with no PATH key", () => {
    expect(parsePlistPath("<plist><dict></dict></plist>")).toEqual([]);
  });
});

describe("workerLaunchdLabel", () => {
  it("maps each role to a distinct label", () => {
    expect(workerLaunchdLabel("all")).toBe(WORKER_LAUNCHD_LABEL);
    expect(workerLaunchdLabel("code")).toBe(WORKER_CODE_LAUNCHD_LABEL);
    expect(workerLaunchdLabel("answer")).toBe(WORKER_ANSWER_LAUNCHD_LABEL);
    const labels = new Set([
      workerLaunchdLabel("all"),
      workerLaunchdLabel("code"),
      workerLaunchdLabel("answer"),
    ]);
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

describe("insertProjectIntoConfigText", () => {
  it("appends a project after a single-line entry, matching its indent", () => {
    const text = [
      "{",
      '  "url": "http://x:3300",',
      '  "projects": {',
      '    "SYD": { "repo": "/Users/sean/sites/switchyard" }',
      "  },",
      '  "maxConcurrent": 1',
      "}",
      "",
    ].join("\n");

    const updated = insertProjectIntoConfigText(text, "NOC", "/Users/sean/sites/piano-game");
    const parsed = JSON.parse(updated);

    expect(parsed.projects).toEqual({
      SYD: { repo: "/Users/sean/sites/switchyard" },
      NOC: { repo: "/Users/sean/sites/piano-game" },
    });
    expect(updated).toContain(
      '    "SYD": { "repo": "/Users/sean/sites/switchyard" },\n    "NOC": { "repo": "/Users/sean/sites/piano-game" }',
    );
    // Everything outside the projects block is untouched, character for character.
    expect(updated).toContain('  "url": "http://x:3300",');
    expect(updated).toContain('  "maxConcurrent": 1');
  });

  it("appends after a multi-line entry, ignoring the nested `repo` key's indent", () => {
    const text = [
      "{",
      '  "projects": {',
      '    "SYD": {',
      '      "repo": "/Users/sean/sites/switchyard"',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

    const updated = insertProjectIntoConfigText(text, "NOC", "/repo/noc");
    const parsed = JSON.parse(updated);

    expect(parsed.projects.NOC).toEqual({ repo: "/repo/noc" });
    // The new entry's indent matches the top-level "SYD" entry (4 spaces),
    // not the nested "repo" line (6 spaces).
    expect(updated).toContain('\n    "NOC": { "repo": "/repo/noc" }');
  });

  it("handles an object with multiple existing projects, inserting after the last", () => {
    const text =
      '{\n  "projects": {\n    "A": { "repo": "/a" },\n    "B": { "repo": "/b" }\n  }\n}\n';
    const updated = insertProjectIntoConfigText(text, "C", "/c");
    const parsed = JSON.parse(updated);
    expect(Object.keys(parsed.projects)).toEqual(["A", "B", "C"]);
  });

  it("handles an empty projects object", () => {
    const text = '{\n  "projects": {}\n}\n';
    const updated = insertProjectIntoConfigText(text, "NOC", "/repo/noc");
    const parsed = JSON.parse(updated);
    expect(parsed.projects).toEqual({ NOC: { repo: "/repo/noc" } });
  });

  it("throws when there is no projects block", () => {
    expect(() => insertProjectIntoConfigText("{}", "NOC", "/repo/noc")).toThrow(/no `"projects"/);
  });

  it("round-trips through JSON.parse without corrupting other top-level keys", () => {
    const text = JSON.stringify(
      {
        url: "http://x:3300",
        label: "auto",
        intervalSeconds: 300,
        maxConcurrent: 1,
        projects: { SYD: { repo: "/repo/syd" } },
        dispatchPolicy: "all-todo",
        delivery: { openPrs: true },
      },
      null,
      2,
    );
    const updated = insertProjectIntoConfigText(text, "NOC", "/repo/noc");
    const parsed = JSON.parse(updated);
    expect(parsed).toEqual({
      url: "http://x:3300",
      label: "auto",
      intervalSeconds: 300,
      maxConcurrent: 1,
      projects: { SYD: { repo: "/repo/syd" }, NOC: { repo: "/repo/noc" } },
      dispatchPolicy: "all-todo",
      delivery: { openPrs: true },
    });
  });
});

describe("renderClaudeMdSnippet", () => {
  it("includes the project key, house rules, and branch convention", () => {
    const snippet = renderClaudeMdSnippet("NOC");
    expect(snippet).toContain("project key `NOC`");
    expect(snippet).toContain("`NOC-1`");
    expect(snippet).toContain("next_task");
    expect(snippet).toContain("claim_issue");
    expect(snippet).toContain("NEVER move an issue to `done`");
    expect(snippet).toContain("agent/<ref>");
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
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
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

describe("parseDebateAcpxReviewers (SYD-82)", () => {
  it("accepts a bare array of string names", () => {
    expect(parseDebateAcpxReviewers(["codex", "gemini"])).toEqual(["codex", "gemini"]);
  });

  it("accepts an array of objects using name, cli, or command", () => {
    expect(
      parseDebateAcpxReviewers([{ name: "codex" }, { cli: "gemini" }, { command: "claude" }]),
    ).toEqual(["codex", "gemini", "claude"]);
  });

  it("accepts reviewers/agents/cli wrapper properties", () => {
    expect(parseDebateAcpxReviewers({ reviewers: ["codex", "gemini"] })).toEqual([
      "codex",
      "gemini",
    ]);
    expect(parseDebateAcpxReviewers({ agents: [{ name: "codex" }] })).toEqual(["codex"]);
    expect(parseDebateAcpxReviewers({ cli: ["gemini"] })).toEqual(["gemini"]);
  });

  it("dedupes and trims, and drops blank/unnamed entries", () => {
    expect(parseDebateAcpxReviewers([" codex ", "codex", "", {}, { name: "  " }])).toEqual([
      "codex",
    ]);
  });

  it("returns an empty list for missing files, null, or an unrecognized shape", () => {
    expect(parseDebateAcpxReviewers(null)).toEqual([]);
    expect(parseDebateAcpxReviewers(undefined)).toEqual([]);
    expect(parseDebateAcpxReviewers({ unrelated: true })).toEqual([]);
    expect(parseDebateAcpxReviewers("codex")).toEqual([]);
  });
});

describe("parseEnabledPlugins (SYD-82)", () => {
  it("keeps only true entries from the marketplace map form", () => {
    expect(
      parseEnabledPlugins({
        enabledPlugins: { "superpowers@marketplace": true, "old@marketplace": false },
      }),
    ).toEqual(["superpowers@marketplace"]);
  });

  it("accepts a bare array of plugin names", () => {
    expect(parseEnabledPlugins({ enabledPlugins: ["superpowers", "debate"] })).toEqual([
      "superpowers",
      "debate",
    ]);
  });

  it("returns an empty list when enabledPlugins is absent or the input is malformed", () => {
    expect(parseEnabledPlugins({})).toEqual([]);
    expect(parseEnabledPlugins(null)).toEqual([]);
    expect(parseEnabledPlugins({ enabledPlugins: "yes" })).toEqual([]);
  });
});

describe("parseMcpServerNames (SYD-82)", () => {
  it("returns the keys of a top-level mcpServers map", () => {
    expect(
      parseMcpServerNames({ mcpServers: { switchyard: { type: "http" }, github: {} } }),
    ).toEqual(["switchyard", "github"]);
  });

  it("returns an empty list when mcpServers is absent, an array, or the input is malformed", () => {
    expect(parseMcpServerNames({})).toEqual([]);
    expect(parseMcpServerNames(null)).toEqual([]);
    expect(parseMcpServerNames({ mcpServers: [] })).toEqual([]);
  });
});

describe("stackParityGaps (SYD-82)", () => {
  it("returns captured names not covered by the declared stack.cli", () => {
    expect(stackParityGaps(["codex", "gemini"], [{ name: "gh", check: "gh --version" }])).toEqual([
      "codex",
      "gemini",
    ]);
  });

  it("matches declared names case-insensitively", () => {
    expect(stackParityGaps(["Codex"], [{ name: "codex", check: "codex --version" }])).toEqual([]);
  });

  it("treats an undeclared stack.cli as covering nothing", () => {
    expect(stackParityGaps(["codex"], undefined)).toEqual(["codex"]);
  });

  it("returns an empty list when nothing was captured", () => {
    expect(stackParityGaps([], [{ name: "gh", check: "gh --version" }])).toEqual([]);
  });
});

describe("formatUserStackCapture (SYD-82)", () => {
  it("lists only the fields that captured something, plus sources", () => {
    const capture: UserStackCapture = {
      cli: ["codex", "gemini"],
      plugins: [],
      mcpServers: ["switchyard"],
      sources: ["~/.claude/debate-acpx.json", "~/.claude/settings.json"],
    };
    expect(formatUserStackCapture(capture)).toBe(
      "cli: codex, gemini; mcp: switchyard (from ~/.claude/debate-acpx.json, ~/.claude/settings.json)",
    );
  });
});

describe("wellKnownCliInstall (SYD-87)", () => {
  it("returns an install command for well-known reviewer CLIs, case-insensitively", () => {
    expect(wellKnownCliInstall("gh")).toBe("brew install gh");
    expect(wellKnownCliInstall("Codex")).toBe("npm install -g @openai/codex");
    expect(wellKnownCliInstall("GEMINI")).toBe("npm install -g @google/gemini-cli");
  });

  it("returns undefined for an unrecognized CLI", () => {
    expect(wellKnownCliInstall("some-internal-tool")).toBeUndefined();
  });
});

describe("suggestStackCli (SYD-82, SYD-87)", () => {
  it("builds a --version check per name and pre-fills install for well-known CLIs only", () => {
    expect(suggestStackCli(["codex", "gemini", "some-internal-tool"])).toEqual([
      { name: "codex", check: "codex --version", install: "npm install -g @openai/codex" },
      { name: "gemini", check: "gemini --version", install: "npm install -g @google/gemini-cli" },
      { name: "some-internal-tool", check: "some-internal-tool --version" },
    ]);
  });

  it("returns an empty list for no names", () => {
    expect(suggestStackCli([])).toEqual([]);
  });
});

describe("formatDockerfileStackGuidance (SYD-87)", () => {
  it("lists declared entries and labels captured-but-undeclared gaps separately", () => {
    expect(
      formatDockerfileStackGuidance(
        [{ name: "gh", check: "gh --version", install: "brew install gh" }],
        ["codex", "some-internal-tool"],
      ),
    ).toEqual([
      "  - gh: brew install gh",
      "  - codex (captured, not yet in stack.cli): npm install -g @openai/codex",
      "  - some-internal-tool (captured, not yet in stack.cli): (no install command known)",
    ]);
  });

  it("notes a missing declared install command", () => {
    expect(formatDockerfileStackGuidance([{ name: "foo", check: "foo --version" }], [])).toEqual([
      "  - foo: (no install command declared)",
    ]);
  });

  it("returns an empty list when nothing is declared or captured", () => {
    expect(formatDockerfileStackGuidance([], [])).toEqual([]);
  });
});
