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
const { runsOk, checkProjectStack } = await import("../../scripts/init-worker.js");

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
