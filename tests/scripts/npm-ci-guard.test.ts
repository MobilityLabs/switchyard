import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-81: piano-game's container dispatch hit an `npm ci` "usage error" with
// no way to tell why after the fact. Reproduced locally (no Docker needed):
// `npm error code EUSAGE ... can only install with an existing
// package-lock.json` fires the instant a clone has package.json but no
// lockfile -- exactly what `git clone /origin /work` produces for a target
// repo that doesn't commit one. These tests exercise the actual script
// container-entry.sh now shells out to.

const REPO_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_DIR, "scripts/npm-ci-guard.mjs");

function run(workspace: string): string {
  return execFileSync("node", [SCRIPT, workspace], { encoding: "utf8", stdio: "pipe" }).toString();
}

function runCapturingStderr(workspace: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync("node", [SCRIPT, workspace], { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function tmpWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "npm-ci-guard-test-"));
}

describe("npm-ci-guard.mjs", () => {
  it("skips npm ci and warns when no lockfile is present", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("dependency installation skipped -- no package-lock.json");
    expect(existsSync(path.join(workspace, "node_modules"))).toBe(false);
  });

  it("exits 0 even when the lockfile is missing (non-fatal, matches prior behavior)", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );

    expect(() => run(workspace)).not.toThrow();
  });

  it("runs npm ci successfully when package.json and package-lock.json are in sync", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "tmp-x", version: "1.0.0" } },
      }),
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).not.toContain("WARNING");
  });

  it("logs node/npm version when npm ci fails for a reason other than a missing lockfile", () => {
    const workspace = tmpWorkspace();
    // package.json declares a dependency the lockfile doesn't have -- npm ci's
    // "in sync" EUSAGE case, resolved entirely offline (no registry hit).
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0", dependencies: { "left-pad": "^1.0.0" } }),
    );
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "tmp-x", version: "1.0.0" } },
      }),
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("npm install failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toContain("engines/packageManager");
  });

  it("runs yarn install successfully when package.json and yarn.lock are present", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(workspace, "yarn.lock"),
      "# yarn lockfile v1\n",
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).not.toContain("WARNING");
  });

  it("logs node/yarn version when yarn install fails", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      "invalid-json",
    );
    writeFileSync(
      path.join(workspace, "yarn.lock"),
      "# yarn lockfile v1\n",
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("yarn install failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toContain("yarn 1.");
  });

  it("logs node/pnpm version when pnpm install fails", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(workspace, "pnpm-lock.yaml"),
      "lockfileVersion: '6.0'\n",
    );

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("pnpm install failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toContain("pnpm unknown");
  });

  it("requires a workspace argument", () => {
    expect(() => execFileSync("node", [SCRIPT], { stdio: "pipe" })).toThrow();
  });

  it("runs npm ci with the secret env vars stripped, so lifecycle scripts can't read tokens (SYD-110)", () => {
    const workspace = tmpWorkspace();
    // A real root-project postinstall script: records which secrets it can see.
    writeFileSync(
      path.join(workspace, "record-env.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(
  "env-seen.txt",
  ["SWITCHYARD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "PATH"]
    .map((k) => (process.env[k] ? k + "=set" : k + "=unset"))
    .join(","),
);
`,
    );
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        scripts: { postinstall: "node record-env.mjs" },
      }),
    );
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "tmp-x", version: "1.0.0" } },
      }),
    );

    const result = spawnSync("node", [SCRIPT, workspace], {
      encoding: "utf8",
      env: {
        ...process.env,
        SWITCHYARD_TOKEN: "syd_secret",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth_secret",
        ANTHROPIC_API_KEY: "key_secret",
      },
    });
    expect(result.status).toBe(0);

    const seen = readFileSync(path.join(workspace, "env-seen.txt"), "utf8");
    expect(seen).toBe(
      "SWITCHYARD_TOKEN=unset,CLAUDE_CODE_OAUTH_TOKEN=unset,ANTHROPIC_API_KEY=unset,PATH=set",
    );
  });

  it("runs yarn install with the secret env vars stripped, so lifecycle scripts can't read tokens (SYD-110)", () => {
    const workspace = tmpWorkspace();
    // A real root-project postinstall script: records which secrets it can see.
    writeFileSync(
      path.join(workspace, "record-env.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(
  "env-seen.txt",
  ["SWITCHYARD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "PATH"]
    .map((k) => (process.env[k] ? k + "=set" : k + "=unset"))
    .join(","),
);
`,
    );
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "tmp-x",
        version: "1.0.0",
        scripts: { postinstall: "node record-env.mjs" },
      }),
    );
    writeFileSync(
      path.join(workspace, "yarn.lock"),
      "# yarn lockfile v1\n",
    );

    const result = spawnSync("node", [SCRIPT, workspace], {
      encoding: "utf8",
      env: {
        ...process.env,
        SWITCHYARD_TOKEN: "syd_secret",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth_secret",
        ANTHROPIC_API_KEY: "key_secret",
      },
    });
    expect(result.status).toBe(0);

    const seen = readFileSync(path.join(workspace, "env-seen.txt"), "utf8");
    expect(seen).toBe(
      "SWITCHYARD_TOKEN=unset,CLAUDE_CODE_OAUTH_TOKEN=unset,ANTHROPIC_API_KEY=unset,PATH=set",
    );
  });
});
