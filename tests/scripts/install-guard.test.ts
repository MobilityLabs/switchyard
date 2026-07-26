import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error -- plain .mjs script, no type declarations by design
import { yarnInstallArgs, detectInstaller } from "../../scripts/install-guard.mjs";

// SYD-81: piano-game's container dispatch hit an `npm ci` "usage error" with
// no way to tell why after the fact. Reproduced locally (no Docker needed):
// `npm error code EUSAGE ... can only install with an existing
// package-lock.json` fires the instant a clone has package.json but no
// lockfile -- exactly what `git clone /origin /work` produces for a target
// repo that doesn't commit one. These tests exercise the actual script
// container-entry.sh now shells out to.

const REPO_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_DIR, "scripts/install-guard.mjs");

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
  return mkdtempSync(path.join(tmpdir(), "install-guard-test-"));
}

describe("install-guard.mjs", () => {
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

    // The warning names the exact command line, so a container log shows
    // which install actually ran (SYD-253 -- it's how you tell --immutable
    // from --frozen-lockfile after the fact).
    expect(stderr).toContain("npm ci failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toContain("engines/packageManager");
  });

  it("runs yarn install successfully when package.json and yarn.lock are present", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(path.join(workspace, "yarn.lock"), "# yarn lockfile v1\n");

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).not.toContain("WARNING");
  });

  // SYD-259: the guard logs the failing tool's `--version` output, or
  // "unknown" when even that fails (tool absent, or — with a corepack shim —
  // the workspace's broken package.json corrupting the probe itself). The CI
  // runner has yarn and no pnpm; a dev Mac may have the opposite. Assert the
  // version slot is populated with a version-or-unknown, not one specific
  // machine's toolset, so `npm run verify` is green everywhere the guard
  // itself behaves correctly.
  it("logs node/yarn version when yarn install fails", () => {
    const workspace = tmpWorkspace();
    writeFileSync(path.join(workspace, "package.json"), "invalid-json");
    writeFileSync(path.join(workspace, "yarn.lock"), "# yarn lockfile v1\n");

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("yarn install --frozen-lockfile failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toMatch(/yarn (\d[\w.-]*|unknown)\)/);
  });

  it("logs node/pnpm version when pnpm install fails", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");

    const { stderr } = runCapturingStderr(workspace);

    expect(stderr).toContain("pnpm install --frozen-lockfile failed");
    expect(stderr).toContain(`node ${process.version}`);
    expect(stderr).toMatch(/pnpm (\d[\w.-]*|unknown)\)/);
  });

  // SYD-253: classic and berry disagree on the frozen-install flag, and both
  // wrong pairings fail silently rather than loudly -- berry 4.5.0 exits 1 on
  // --frozen-lockfile ("YN0050 ... deprecated; use --immutable"), while
  // classic 1.22.22 ignores --immutable and rewrites yarn.lock ("success
  // Saved lockfile", exit 0), quietly dropping the frozen guarantee. Both
  // behaviors were confirmed against the real binaries before this was
  // written.
  describe("yarn frozen-install flag selection", () => {
    it("uses --frozen-lockfile for classic yarn (no packageManager pin, no .yarnrc.yml)", () => {
      const workspace = tmpWorkspace();
      writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
      );

      expect(yarnInstallArgs(workspace)).toEqual(["install", "--frozen-lockfile"]);
    });

    it("uses --immutable when packageManager pins a berry major", () => {
      const workspace = tmpWorkspace();
      writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "tmp-x", version: "1.0.0", packageManager: "yarn@3.6.4" }),
      );

      expect(yarnInstallArgs(workspace)).toEqual(["install", "--immutable"]);
    });

    it("uses --frozen-lockfile when packageManager pins classic, even beside a .yarnrc.yml", () => {
      const workspace = tmpWorkspace();
      writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "tmp-x", version: "1.0.0", packageManager: "yarn@1.22.22" }),
      );
      writeFileSync(path.join(workspace, ".yarnrc.yml"), "nodeLinker: node-modules\n");

      // The explicit pin is Corepack's own source of truth; it wins over the
      // .yarnrc.yml heuristic.
      expect(yarnInstallArgs(workspace)).toEqual(["install", "--frozen-lockfile"]);
    });

    it("falls back to .yarnrc.yml to detect berry when there is no pin", () => {
      const workspace = tmpWorkspace();
      writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
      );
      writeFileSync(path.join(workspace, ".yarnrc.yml"), "nodeLinker: node-modules\n");

      expect(yarnInstallArgs(workspace)).toEqual(["install", "--immutable"]);
    });

    it("falls back to .yarnrc.yml when package.json is unparseable", () => {
      const workspace = tmpWorkspace();
      writeFileSync(path.join(workspace, "package.json"), "invalid-json");
      writeFileSync(path.join(workspace, ".yarnrc.yml"), "nodeLinker: node-modules\n");

      expect(yarnInstallArgs(workspace)).toEqual(["install", "--immutable"]);
    });

    // End-to-end: prove the chosen flag actually reaches a yarn binary,
    // rather than only that the pure function returns it. yarn classic execs
    // whatever `yarnPath` points at and forwards its argv verbatim (verified
    // against yarn 1.22.22), so a recorder script standing in for a vendored
    // berry release captures exactly what the guard dispatched.
    it("passes --immutable through to the binary for a berry (.yarnrc.yml) repo", () => {
      const workspace = tmpWorkspace();
      writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
      );
      writeFileSync(path.join(workspace, "yarn.lock"), "");
      mkdirSync(path.join(workspace, ".yarn/releases"), { recursive: true });
      writeFileSync(
        path.join(workspace, ".yarn/releases/recorder.cjs"),
        `require("node:fs").writeFileSync(
  require("node:path").join(__dirname, "../../argv-seen.txt"),
  process.argv.slice(2).join(" "),
);
`,
      );
      writeFileSync(path.join(workspace, ".yarnrc.yml"), "yarnPath: .yarn/releases/recorder.cjs\n");

      const { status } = runCapturingStderr(workspace);
      expect(status).toBe(0);

      const argvSeen = path.join(workspace, "argv-seen.txt");
      // Skip rather than fail where no yarn binary exists at all (the guard's
      // own missing-installer path is covered above, and SYD-259 made these
      // assertions environment-proof on purpose).
      if (existsSync(argvSeen)) {
        expect(readFileSync(argvSeen, "utf8")).toBe("install --immutable");
      }
    });
  });

  it("detects the installer from the lockfile, preferring npm when several are present", () => {
    const workspace = tmpWorkspace();
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "tmp-x", version: "1.0.0" }),
    );
    writeFileSync(path.join(workspace, "yarn.lock"), "# yarn lockfile v1\n");
    writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
    expect(detectInstaller(workspace)?.command).toBe("yarn");

    writeFileSync(path.join(workspace, "package-lock.json"), "{}");
    expect(detectInstaller(workspace)?.command).toBe("npm");
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
    writeFileSync(path.join(workspace, "yarn.lock"), "# yarn lockfile v1\n");

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
