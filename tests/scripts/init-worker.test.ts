import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerConfig, WorkerProject } from "../../scripts/worker-select.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

// Import after mocking
const { runsOk, checkProjectStack, checkContainerPrerequisites } =
  await import("../../scripts/init-worker.js");

describe("engine-aware container prerequisites (#267)", () => {
  const base: WorkerConfig = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 30,
    maxConcurrent: 1,
    projects: {},
    containerized: true,
  };
  const engines = [
    {
      engine: "claude",
      image: "switchyard-worker",
      env: { ANTHROPIC_API_KEY: "test-claude" },
      suffix: "",
    },
    {
      engine: "codex",
      image: "switchyard-worker-codex",
      env: { CODEX_OAUTH_TOKEN: "test-codex", CODEX_ACCOUNT_ID: "test-account" },
      suffix: "-codex",
    },
    {
      engine: "gemini",
      image: "switchyard-worker-gemini",
      env: { GEMINI_API_KEY: "test-gemini" },
      suffix: "-gemini",
    },
  ] as const;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "v24.19.0\n" });
  });

  it.each(engines)(
    "accepts only $engine credentials and probes its default image",
    ({ engine, image, env }) => {
      const config = { ...base, engine };
      const results = checkContainerPrerequisites(config, env);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledWith("docker", ["image", "inspect", image], {
        stdio: "ignore",
      });
      expect(runsOk("git --version", config)).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "docker",
        ["run", "--rm", "--entrypoint", "sh", image, "-c", "git --version"],
        { stdio: "ignore" },
      );
      expect(checkProjectStack("SYD", { repo: "/repo", stack: { node: "24" } }, config)[0].ok).toBe(
        true,
      );
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "docker",
        ["run", "--rm", "--entrypoint", "node", image, "--version"],
        { encoding: "utf8" },
      );
      for (const value of Object.values(env)) expect(JSON.stringify(results)).not.toContain(value);
    },
  );

  it.each(engines)("honors an explicit image override for $engine", ({ engine, env }) => {
    const config = { ...base, engine, image: "registry.example/worker:custom" };
    expect(checkContainerPrerequisites(config, env).every((result) => result.ok)).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith("docker", ["image", "inspect", config.image], {
      stdio: "ignore",
    });
    runsOk("git --version", config);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", config.image, "-c", "git --version"],
      { stdio: "ignore" },
    );
  });

  it.each(engines)(
    "gives the correct build command for a missing $engine image",
    ({ engine, env, suffix }) => {
      spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
      const results = checkContainerPrerequisites({ ...base, engine }, env);
      expect(results.find((result) => result.name.startsWith("worker image"))).toMatchObject({
        ok: false,
        note: `not built — run: npm run build:worker-image${suffix}`,
      });
    },
  );

  it("does not suggest building a default image when an overridden image is missing", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
    const results = checkContainerPrerequisites(
      { ...base, engine: "gemini", image: "custom-image" },
      { GEMINI_API_KEY: "test-gemini" },
    );
    expect(results.find((result) => result.name.startsWith("worker image"))).toMatchObject({
      ok: false,
      note: 'not built — build or pull the configured gemini-compatible image "custom-image"',
    });
  });

  it("accepts either Claude credential, including the default engine", () => {
    for (const env of [
      { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth" },
      { ANTHROPIC_API_KEY: "test-key" },
    ]) {
      expect(checkContainerPrerequisites(base, env).every((result) => result.ok)).toBe(true);
    }
    expect(
      checkContainerPrerequisites(base, {})
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)"]);
  });

  it("requires both Codex OAuth and account ID without accepting Claude credentials", () => {
    const config = { ...base, engine: "codex" as const };
    expect(
      checkContainerPrerequisites(config, { ANTHROPIC_API_KEY: "test-claude" })
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual(["CODEX_OAUTH_TOKEN", "CODEX_ACCOUNT_ID"]);
    expect(
      checkContainerPrerequisites(config, { CODEX_OAUTH_TOKEN: "test-codex" })
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual(["CODEX_ACCOUNT_ID"]);
  });

  it("requires a Gemini API key without accepting another engine's credentials", () => {
    expect(
      checkContainerPrerequisites(
        { ...base, engine: "gemini" },
        { CODEX_OAUTH_TOKEN: "test-codex", ANTHROPIC_API_KEY: "test-claude" },
      )
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual(["GEMINI_API_KEY"]);
  });

  it("reports missing Docker without attempting an image inspection", () => {
    spawnSyncMock.mockReturnValue({ status: 1 });
    expect(
      checkContainerPrerequisites({ ...base, engine: "gemini" }, { GEMINI_API_KEY: "test-gemini" })
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual(["docker CLI"]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("init-worker: runsOk", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("calls sh directly when non-containerized", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
      containerized: false,
    };

    const res = runsOk("echo hello", config);
    expect(res).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith("sh", ["-c", "echo hello"], { stdio: "ignore" });
  });

  it("calls docker with entrypoint override when containerized", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
      containerized: true,
      image: "my-custom-image",
    };

    const res = runsOk("echo hello", config);
    expect(res).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", "my-custom-image", "-c", "echo hello"],
      { stdio: "ignore" },
    );
  });

  it("uses default image if image is unset in containerized config", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
      containerized: true,
    };

    const res = runsOk("echo hello", config);
    expect(res).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", "switchyard-worker", "-c", "echo hello"],
      { stdio: "ignore" },
    );
  });
});

describe("init-worker: checkProjectStack", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("returns empty if no stack defined", () => {
    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
    };
    const project: WorkerProject = {
      repo: "/my/repo",
    };

    const res = checkProjectStack("MY_PROJ", project, config);
    expect(res).toEqual([]);
  });

  it("checks node version with entrypoint bypass when containerized", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "v20.10.0\n",
    });

    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
      containerized: true,
      image: "my-image",
    };
    const project: WorkerProject = {
      repo: "/my/repo",
      stack: {
        node: "20",
      },
    };

    const res = checkProjectStack("MY_PROJ", project, config);
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(true);
    expect(res[0].note).toContain("found v20.10.0");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "--entrypoint", "node", "my-image", "--version"],
      { encoding: "utf8" },
    );
  });

  it("checks cli options with entrypoint bypass when containerized", () => {
    // First call (node version): returns v20.10.0
    // Second call (cli runsOk): status 0
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "v20.10.0\n",
      })
      .mockReturnValueOnce({
        status: 0,
      });

    const config: WorkerConfig = {
      url: "http://localhost:3300",
      label: "auto",
      intervalSeconds: 30,
      maxConcurrent: 1,
      projects: {},
      containerized: true,
    };
    const project: WorkerProject = {
      repo: "/my/repo",
      stack: {
        node: "20",
        cli: [
          {
            name: "yarn",
            check: "yarn --version",
          },
        ],
      },
    };

    const res = checkProjectStack("MY_PROJ", project, config);
    expect(res).toHaveLength(2);
    expect(res[0].ok).toBe(true);
    expect(res[1].ok).toBe(true);
    expect(res[1].name).toBe("projects.MY_PROJ stack: yarn");

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["run", "--rm", "--entrypoint", "node", "switchyard-worker", "--version"],
      { encoding: "utf8" },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["run", "--rm", "--entrypoint", "sh", "switchyard-worker", "-c", "yarn --version"],
      { stdio: "ignore" },
    );
  });
});
