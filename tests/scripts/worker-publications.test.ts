import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerConfig } from "../../scripts/worker-select.js";
import { readPublications, savePublication } from "../../scripts/worker-publications.js";

const publishAgentBranch = vi.fn();
vi.mock("../../scripts/delivery-exec.js", () => ({
  publishAgentBranch: (...args: unknown[]) => publishAgentBranch(...args),
  prFreshness: async () => ({ headSha: "head", ghUpdatedAt: "2026-09-27T12:00:00Z" }),
  originOwnerRepo: async () => "acme/widgets",
}));
const { reconcileContainerSessions, recoverPublications } =
  await import("../../scripts/agent-worker.js");

let repo: string;
let config: WorkerConfig;
const publication = { ref: "SYD-9", issueTitle: "Ship it", sessionId: 12, exitCode: 0 };
const opened = { status: "opened", prNumber: 42, url: "https://github.com/acme/widgets/pull/42" };

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "publication-recovery-"));
  config = {
    url: "http://localhost:3300",
    label: "auto",
    intervalSeconds: 300,
    maxConcurrent: 1,
    containerized: true,
    projects: { SYD: { repo } },
    delivery: { openPrs: true },
  };
  publishAgentBranch.mockReset();
  publishAgentBranch.mockResolvedValue(opened);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(repo, { recursive: true, force: true });
});

function installFetch(sessions: unknown[] = [], failObservation = false) {
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("?active=true")) return new Response(JSON.stringify(sessions));
    if (u.endsWith("/api/agent-sessions/12")) {
      // A crash immediately after this response must still leave durable work.
      expect(readPublications(repo, config)).toHaveLength(1);
    }
    if (
      failObservation &&
      u.endsWith("/delivery-events") &&
      JSON.parse(init?.body as string).type === "pr_opened"
    ) {
      return new Response("test refusal", { status: 400 });
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("durable publication recovery (review finding 11)", () => {
  it("publishes a container that completed while the host worker was down", async () => {
    const fetch = installFetch([
      { id: 12, ref: "SYD-9", issueTitle: "Ship it", mode: "container" },
    ]);
    await reconcileContainerSessions(config, "test-token", {
      listLiveContainerNames: async () => new Set(),
    });
    expect(publishAgentBranch).toHaveBeenCalledWith(repo, "SYD-9", "Ship it", config.url, null);
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/delivery-events") &&
          JSON.parse(init?.body as string).type === "pr_opened",
      ),
    ).toBe(true);
    expect(readPublications(repo, config)).toEqual([]);
  });

  it("retries after session completion even when no active session remains on the server", async () => {
    savePublication(repo, config, publication);
    installFetch();
    publishAgentBranch.mockRejectedValueOnce(
      new Error("fatal: unable to read local branch: Input/output error"),
    );
    await recoverPublications(config, "test-token", new Set());
    expect(readPublications(repo, config)).toEqual([publication]);
    await reconcileContainerSessions(config, "test-token", {
      listLiveContainerNames: async () => new Set(),
    });
    expect(publishAgentBranch).toHaveBeenCalledTimes(2);
    expect(readPublications(repo, config)).toEqual([]);
  });

  it("retains the outbox until the PR observation is acknowledged", async () => {
    savePublication(repo, config, publication);
    installFetch([], true);
    await recoverPublications(config, "test-token", new Set());
    expect(readPublications(repo, config)).toEqual([publication]);
    installFetch();
    publishAgentBranch.mockResolvedValue({ ...opened, status: "already-open" });
    await recoverPublications(config, "test-token", new Set());
    expect(publishAgentBranch).toHaveBeenCalledTimes(2);
    expect(readPublications(repo, config)).toEqual([]);
  });

  it("recovers the pre-spawn marker after the server has swept the session", async () => {
    savePublication(repo, config, { ...publication, sessionId: null, exitCode: null });
    installFetch();
    await reconcileContainerSessions(config, "test-token", {
      listLiveContainerNames: async () => new Set(),
    });
    expect(publishAgentBranch).toHaveBeenCalledOnce();
    expect(readPublications(repo, config)).toEqual([]);
  });

  it("leaves still-running containers and other engine outboxes untouched", async () => {
    savePublication(repo, config, publication);
    installFetch();
    await recoverPublications(config, "test-token", new Set(["syd-SYD-9"]));
    expect(publishAgentBranch).not.toHaveBeenCalled();
    expect(readPublications(repo, { ...config, token: "SWITCHYARD_CODEX_TOKEN" })).toEqual([]);
    expect(readPublications(repo, config)).toEqual([publication]);
  });
});
