import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runSdkSession, type SdkSessionOpts } from "./sdk-runner.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const queryMock = vi.mocked(query);
// Query also exposes interactive controls that runSdkSession does not use.
const asQuery = (stream: AsyncIterable<SDKMessage>) => stream as ReturnType<typeof query>;
const result = (subtype = "success") => ({ type: "result", subtype }) as SDKMessage;

describe("runSdkSession", () => {
  let directory: string;
  let options: SdkSessionOpts;

  beforeEach(() => {
    queryMock.mockReset();
    directory = mkdtempSync(join(tmpdir(), "switchyard-sdk-"));
    options = {
      prompt: "Fix the claimed issue.",
      cwd: directory,
      switchyardUrl: "https://switchyard.example/",
      switchyardToken: "test-bearer-secret",
      switchyardLeaseToken: "test-lease-secret",
      allowedTools: ["Read", "Edit", "Bash", "mcp__switchyard__claim_issue"],
      logPath: join(directory, "session.log"),
    };
    queryMock.mockImplementation(() =>
      asQuery(
        (async function* () {
          yield result();
        })(),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses the coding prompt, project settings and in-memory MCP credentials", async () => {
    expect(await runSdkSession(options)).toBe(0);
    expect(queryMock).toHaveBeenCalledExactlyOnceWith({
      prompt: options.prompt,
      options: {
        cwd: directory,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["project"],
        permissionMode: "acceptEdits",
        allowedTools: options.allowedTools,
        abortController: expect.any(AbortController),
        mcpServers: {
          switchyard: {
            type: "http",
            url: "https://switchyard.example/mcp",
            headers: {
              Authorization: "Bearer test-bearer-secret",
              "X-Switchyard-Lease": "test-lease-secret",
            },
          },
        },
      },
    });
    const log = readFileSync(options.logPath, "utf8");
    expect(log).toContain("result: success");
    expect(log).not.toContain(options.switchyardToken);
    expect(log).not.toContain(options.switchyardLeaseToken);
  });

  it("omits an absent lease and passes an explicitly configured model", async () => {
    delete options.switchyardLeaseToken;
    options.model = "claude-sonnet-4-6";
    await runSdkSession(options);
    expect(queryMock.mock.calls[0][0].options).toMatchObject({
      model: options.model,
      mcpServers: {
        switchyard: { headers: { Authorization: "Bearer test-bearer-secret" } },
      },
    });
    expect(queryMock.mock.calls[0][0].options?.mcpServers?.switchyard).not.toHaveProperty(
      "headers.X-Switchyard-Lease",
    );
  });

  it("records SDK version, requested model and separately observed model metadata", async () => {
    options.model = "requested-model";
    queryMock.mockImplementation(() =>
      asQuery(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            model: "actual-model",
            claude_code_version: "2.1.283",
            authorization: "secret-auth",
          } as unknown as SDKMessage;
          yield result();
        })(),
      ),
    );
    expect(await runSdkSession(options)).toBe(0);
    const log = readFileSync(options.logPath, "utf8");
    const events = log
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "worker.runtime",
        sdk_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        requested_model: "requested-model",
        cli_version: null,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "worker.event",
        effective_models: ["actual-model"],
        cli_version: "2.1.283",
      }),
    );
    expect(log).not.toContain("secret-auth");
  });

  it("does not start a provider session after the host cancels its lease", async () => {
    const host = new AbortController();
    host.abort();
    expect(await runSdkSession({ ...options, externalAbortSignal: host.signal })).toBe(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("propagates cancellation, refuses late success and removes the host listener", async () => {
    const host = new AbortController();
    const remove = vi.spyOn(host.signal, "removeEventListener");
    let querySignal: AbortSignal | undefined;
    queryMock.mockImplementation(({ options: sdkOptions }) =>
      asQuery(
        (async function* () {
          querySignal = sdkOptions?.abortController?.signal;
          host.abort();
          yield result();
        })(),
      ),
    );
    expect(await runSdkSession({ ...options, externalAbortSignal: host.signal })).toBe(1);
    expect(querySignal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("aborts a stalled query through the SDK controller and clears the watchdog", async () => {
    vi.useFakeTimers();
    queryMock.mockImplementation(({ options: sdkOptions }) =>
      asQuery(
        (async function* () {
          yield { type: "system", subtype: "init" } as SDKMessage;
          await new Promise<void>((resolve) => {
            sdkOptions?.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new Error("query aborted");
        })(),
      ),
    );
    const running = runSdkSession({ ...options, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toBe(1);
    expect(readFileSync(options.logPath, "utf8")).toContain("watchdog timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up timeout and cancellation hooks after a successful session", async () => {
    vi.useFakeTimers();
    const host = new AbortController();
    const remove = vi.spyOn(host.signal, "removeEventListener");
    expect(
      await runSdkSession({ ...options, externalAbortSignal: host.signal, timeoutMs: 1000 }),
    ).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error_during_execution", "error_max_turns"])(
    "treats provider result %s as failure",
    async (subtype) => {
      queryMock.mockImplementation(() =>
        asQuery(
          (async function* () {
            yield result(subtype);
          })(),
        ),
      );
      expect(await runSdkSession(options)).toBe(1);
    },
  );

  it("requires a terminal success result", async () => {
    queryMock.mockImplementation(() =>
      asQuery(
        (async function* () {
          yield { type: "system", subtype: "init" } as SDKMessage;
        })(),
      ),
    );
    expect(await runSdkSession(options)).toBe(1);
  });

  it("settles provider failures and redacts authorization and lease values from errors", async () => {
    queryMock.mockImplementation(() => {
      throw new Error(`MCP failed: ${options.switchyardToken} ${options.switchyardLeaseToken}`);
    });
    expect(await runSdkSession(options)).toBe(1);
    expect(readFileSync(options.logPath, "utf8")).toContain(
      "session error: MCP failed: [redacted] [redacted]",
    );
  });

  it("still settles when the session log cannot be written", async () => {
    expect(await runSdkSession({ ...options, logPath: directory })).toBe(0);
    queryMock.mockImplementation(() => {
      throw new Error("provider unavailable");
    });
    expect(await runSdkSession({ ...options, logPath: directory })).toBe(1);
  });
});
