import { prepareWorkerExchange, clearWorkerExchange } from "../../scripts/worker-exchange.js";
// The host-side publish step's pr_opened event gains repo + headSha +
// ghUpdatedAt (SYD-205): the worker is the named freshness producer for agent
// PRs at publish time — without headSha here, pr_state (SYD-206) has no
// producer when the PR opens. Enrichment is best-effort: a failed `gh pr
// view` or origin lookup must never drop the publish itself (the publish IS
// the claim gate's close under the new architecture).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { WorkerConfig } from "../../scripts/worker-select.js";
import {
  savePublication,
  clearPublication,
  readPublications,
} from "../../scripts/worker-publications.js";

const spawnMock = vi.fn();
const dockerPs = vi.fn(() => "");

vi.mock("../../scripts/worker-publications.js", () => ({
  savePublication: vi.fn(),
  readPublications: vi.fn(() => []),
  clearPublication: vi.fn(),
}));

vi.mock("../../scripts/worker-exchange.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/worker-exchange.js")>()),
  prepareWorkerExchange: vi.fn(),
  importWorkerExchange: vi.fn(),
  clearWorkerExchange: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFile: (
      _command: string,
      _args: string[],
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      try {
        callback(null, { stdout: dockerPs(), stderr: "" });
      } catch (error) {
        callback(error as Error);
      }
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    closeSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

const publishAgentBranch = vi.fn();
const prFreshness = vi.fn();
const originOwnerRepo = vi.fn();

vi.mock("../../scripts/delivery-exec.js", () => ({
  publishAgentBranch: (...args: unknown[]) => publishAgentBranch(...args),
  prFreshness: (...args: unknown[]) => prFreshness(...args),
  originOwnerRepo: (...args: unknown[]) => originOwnerRepo(...args),
}));

const { dispatch, active, activeMode, recoverPublications } =
  await import("../../scripts/agent-worker.js");

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
  stdout = new EventEmitter();
}

const issue = {
  ref: "SYD-9",
  title: "Ship it",
  labels: ["auto"],
  assigneeId: null,
  needsInput: false,
  updatedAt: 0,
};

const config: WorkerConfig = {
  url: "http://localhost:3300",
  label: "auto",
  intervalSeconds: 300,
  maxConcurrent: 1,
  projects: { SYD: { repo: "/repo/syd" } },
  containerized: true,
  delivery: { openPrs: true },
};

const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
  ok: true,
  json: async () => ({}),
  text: async () => "",
}));

function deliveryEventBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/api/issues/SYD-9/delivery-events"))
    .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);
}

function commentBodies(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/api/issues/SYD-9/comments"))
    .map(([, init]) => (JSON.parse(init?.body as string) as { body: string }).body);
}

beforeEach(() => {
  active.clear();
  activeMode.clear();
  spawnMock.mockReset();
  dockerPs.mockReset().mockReturnValue("");
  vi.mocked(readPublications).mockReturnValue([]);
  vi.mocked(savePublication).mockClear();
  vi.mocked(clearPublication).mockClear();
  publishAgentBranch.mockReset();
  prFreshness.mockReset();
  originOwnerRepo.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publish-time pr_opened enrichment (SYD-205)", () => {
  it("posts pr_opened with repo, headSha, and ghUpdatedAt sourced from gh", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    publishAgentBranch.mockResolvedValue({
      status: "opened",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    originOwnerRepo.mockResolvedValue("acme/widgets");
    prFreshness.mockResolvedValue({
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 0);

    await vi.waitFor(() => expect(deliveryEventBodies()).toHaveLength(1));
    expect(deliveryEventBodies()[0]).toEqual({
      type: "pr_opened",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
      repo: "acme/widgets",
      headSha: "a".repeat(40),
      ghUpdatedAt: "2026-07-12T10:00:00Z",
    });
    expect(prFreshness).toHaveBeenCalledWith("/repo/syd", 42);
  });

  it("still posts the bare pr_opened when the freshness/origin lookups fail", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    publishAgentBranch.mockResolvedValue({
      status: "already-open",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    originOwnerRepo.mockRejectedValue(new Error("no origin"));
    prFreshness.mockRejectedValue(new Error("gh exploded"));

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 0);

    await vi.waitFor(() => expect(deliveryEventBodies()).toHaveLength(1));
    expect(deliveryEventBodies()[0]).toEqual({
      type: "pr_opened",
      prNumber: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    errorSpy.mockRestore();
  });
});

describe("publish failure surfaces on the board (SYD-257)", () => {
  it("comments the git/gh error and records a delivery_failed event", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    publishAgentBranch.mockRejectedValue(
      new Error("ssh: connect to host github.com: config error"),
    );

    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 0);

    await vi.waitFor(() => expect(deliveryEventBodies()).toHaveLength(1));
    expect(deliveryEventBodies()[0]).toEqual({
      type: "delivery_failed",
      message: "publish failed: ssh: connect to host github.com: config error",
    });

    await vi.waitFor(() => expect(commentBodies()).toHaveLength(1));
    expect(commentBodies()[0]).toContain("SYD-9");
    expect(commentBodies()[0]).toContain("ssh: connect to host github.com: config error");

    errorSpy.mockRestore();
  });
});

describe("publication intent cleanup", () => {
  it("cleans this attempt when exchange preparation fails before spawn", () => {
    vi.mocked(prepareWorkerExchange).mockImplementationOnce(() => {
      throw new Error("root .env tracked");
    });
    dispatch(issue, config, "tok", "code");
    expect(savePublication).toHaveBeenCalledOnce();
    expect(clearWorkerExchange).toHaveBeenCalledWith("/repo/syd", config, "SYD-9");
    expect(clearPublication).toHaveBeenCalledWith("/repo/syd", config, "SYD-9");
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("does not overwrite or clear an existing publication obligation", () => {
    vi.mocked(readPublications).mockReturnValue([
      { ref: issue.ref, issueTitle: "Existing", sessionId: 99, exitCode: null, exchange: true },
    ]);
    dispatch(issue, config, "tok", "code");
    expect(savePublication).not.toHaveBeenCalled();
    expect(clearPublication).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("clears the intent when spawn throws before starting a container", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn setup failed");
    });
    dispatch(issue, config, "tok", "code");
    expect(savePublication).toHaveBeenCalledOnce();
    expect(clearPublication).toHaveBeenCalledWith("/repo/syd", config, "SYD-9");
    expect(publishAgentBranch).not.toHaveBeenCalled();
  });

  it("clears the intent on an asynchronous failed spawn", () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    dispatch(issue, config, "tok", "code");
    child.emit("error", new Error("ENOENT: docker"));
    expect(clearPublication).toHaveBeenCalledWith("/repo/syd", config, "SYD-9");
    expect(publishAgentBranch).not.toHaveBeenCalled();
  });
});

describe("container completion verification", () => {
  it("keeps the obligation when the local docker client exits before its container", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    dockerPs.mockReturnValue("syd-SYD-9\n");
    publishAgentBranch.mockResolvedValue({ status: "no-commits" });
    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 1);
    await vi.waitFor(() => expect(dockerPs).toHaveBeenCalledOnce());
    expect(publishAgentBranch).not.toHaveBeenCalled();
    expect(clearPublication).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).includes("/agent-sessions/") && init?.method === "PATCH",
      ),
    ).toBe(false);
    vi.mocked(readPublications).mockReturnValue([
      { ref: issue.ref, issueTitle: issue.title, sessionId: null, exitCode: 1 },
    ]);
    await recoverPublications(config, "tok", new Set());
    expect(publishAgentBranch).toHaveBeenCalledOnce();
    expect(clearPublication).toHaveBeenCalledWith("/repo/syd", config, issue.ref);
  });

  it("preserves the publication marker if Docker inspection fails", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    dockerPs.mockImplementation(() => {
      throw new Error("Docker daemon unavailable");
    });
    dispatch(issue, config, "tok", "code");
    child.pid = 111;
    child.emit("spawn");
    child.emit("exit", 1);
    await vi.waitFor(() => expect(dockerPs).toHaveBeenCalledOnce());
    expect(publishAgentBranch).not.toHaveBeenCalled();
    expect(clearPublication).not.toHaveBeenCalled();
  });
});
