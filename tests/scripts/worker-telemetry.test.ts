import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEngineArgs,
  classifyWorkerDiagnostic,
  isValidWorkerModel,
  normalizeProviderEvent,
  parseProviderLine,
  parseRuntimeVersion,
  resolveWorkerModel,
} from "../../scripts/worker-telemetry.mjs";
import { containerImageMetadata } from "../../scripts/worker-image-metadata.js";
import { validateWorkerConfig } from "../../scripts/init-worker-lib.js";
import { buildDockerArgs, type WorkerConfig } from "../../scripts/worker-select.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const config: WorkerConfig = {
  url: "http://localhost:3300",
  label: "auto",
  intervalSeconds: 60,
  maxConcurrent: 1,
  projects: { SYD: { repo: "/repo" } },
};

describe("worker model configuration", () => {
  it("preserves provider defaults and gives project requests precedence", () => {
    expect(resolveWorkerModel(config, {})).toBeUndefined();
    expect(resolveWorkerModel({ model: "worker-model" }, {})).toBe("worker-model");
    expect(resolveWorkerModel({ model: "worker-model" }, { model: "project-model" })).toBe(
      "project-model",
    );
    expect(validateWorkerConfig(config)).toEqual([]);
    expect(validateWorkerConfig({ ...config, model: "provider/models/example-1" })).toEqual([]);
  });
  it.each([
    "",
    "--help",
    "a b",
    "a\nb",
    "$(touch /tmp/no)",
    "x;env",
    "x'",
    "x".repeat(201),
    null,
    2,
  ])("rejects invalid model %j", (model) => {
    expect(isValidWorkerModel(model)).toBe(false);
    expect(validateWorkerConfig({ ...config, model })).toContainEqual(
      expect.stringContaining("model"),
    );
    expect(
      validateWorkerConfig({ ...config, projects: { SYD: { repo: "/repo", model } } }),
    ).toContainEqual(expect.stringContaining("projects.SYD.model"));
  });
  it.each(["claude", "codex", "gemini"])(
    "passes %s model as one argument without a shell",
    (engine) => {
      const model = "provider/model-v1:stable";
      const args = buildEngineArgs(engine, ["a prompt; $(env)"], model);
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
        "--model",
        model,
      ]);
      expect(args).toContain("a prompt; $(env)");
      expect(buildEngineArgs(engine, [], undefined)).not.toContain("--model");
      expect(() => buildEngineArgs(engine, [], "--help")).toThrow();
    },
  );
  it("passes the resolved model to a container with no effect on old configs", () => {
    const issue = { ref: "SYD-1", labels: [], assigneeId: null, needsInput: false, updatedAt: 0 };
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "do-not-log" };
    expect(
      buildDockerArgs(
        issue,
        { repo: "/repo", model: "project-model" },
        { ...config, model: "worker-model" },
        env,
      ),
    ).toContain("WORKER_MODEL=project-model");
    expect(buildDockerArgs(issue, { repo: "/repo" }, config, env).join(" ")).not.toContain(
      "WORKER_MODEL",
    );
  });
});

describe("structured provider metadata", () => {
  it("records actual Claude models, usage and tool names without auth or tool input", () => {
    const event = normalizeProviderEvent("claude", {
      type: "assistant",
      model: "claude-configured",
      message: {
        model: "claude-actual",
        usage: { input_tokens: 10, output_tokens: 2, auth_token: "secret" },
        content: [{ type: "tool_use", name: "Bash", input: { command: "echo secret" } }],
      },
      authorization: "Bearer secret",
    });
    expect(event).toMatchObject({
      effective_models: ["claude-configured", "claude-actual"],
      usage: { input_tokens: 10, output_tokens: 2 },
      tool_names: ["Bash"],
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });
  it("handles Gemini init and results, preserving numeric per-event usage", () => {
    expect(
      parseProviderLine("gemini", '{"type":"init","model":"gemini-actual","session_id":"secret"}'),
    ).toEqual({
      type: "worker.event",
      engine: "gemini",
      event_type: "init",
      effective_models: ["gemini-actual"],
    });
    expect(
      normalizeProviderEvent("gemini", {
        type: "result",
        status: "success",
        stats: {
          models: { "gemini-actual": { tokens: { input: 4 } } },
          tokens: { input: 4, total: 8 },
        },
      }),
    ).toMatchObject({
      status: "success",
      effective_models: ["gemini-actual"],
      usage: { input: 4, total: 8 },
    });
  });
  it("does not invent an effective model for Codex events that omit it", () => {
    expect(
      normalizeProviderEvent("codex", {
        type: "turn.completed",
        usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 },
      }),
    ).toEqual({
      type: "worker.event",
      engine: "codex",
      event_type: "turn.completed",
      usage: { input_tokens: 30, output_tokens: 5, cached_input_tokens: 20 },
    });
    expect(
      normalizeProviderEvent("codex", {
        type: "item.completed",
        item: {
          type: "command_execution",
          status: "completed",
          exit_code: 1,
          command: "echo secret",
          aggregated_output: "secret",
        },
      }),
    ).toMatchObject({ item_type: "command_execution", exit_code: 1 });
  });
  it("ignores malformed data and unknown payload fields", () => {
    for (const line of ["not json", "null", "[]", '{"token":"secret"}'])
      expect(parseProviderLine("claude", line)).toBeNull();
    expect(
      normalizeProviderEvent("claude", {
        type: "future.event",
        data: { token: "secret" },
        usage: { input_tokens: Infinity, output_tokens: -1 },
      }),
    ).toEqual({ type: "worker.event", engine: "claude", event_type: "future.event" });
    expect(parseRuntimeVersion("claude 2.1.283 (Claude Code)\nsecret")).toBe("2.1.283");
    expect(parseRuntimeVersion("auth failed")).toBeNull();
  });
});

describe("runtime capture without provider calls", () => {
  it("runs a fake CLI, retains split JSON events, omits credentials and preserves exit status", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "syd-telemetry-"));
    tempDirs.push(dir);
    const argsFile = path.join(dir, "args.json");
    writeFileSync(
      path.join(dir, "claude"),
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }\nfs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('{"type":"system",');\nsetTimeout(() => { console.log('"subtype":"init","model":"actual-model","token":"secret"}'); console.error('Authorization: Bearer secret'); process.exitCode = 7; }, 10);\n`,
      { mode: 0o700 },
    );
    let failure: { stdout: string; stderr: string; code: number } | undefined;
    try {
      await exec(
        process.execPath,
        [path.resolve("scripts/worker-engine-runner.mjs"), "claude", "-p", "prompt; $(env)"],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            WORKER_MODEL: "requested-model",
            ARGS_FILE: argsFile,
          },
        },
      );
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.code).toBe(7);
    if (!failure) throw new Error("fake provider must exit unsuccessfully");
    const lines = failure.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: "worker.runtime",
        requested_model: "requested-model",
        cli_version: "2.1.283",
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "worker.event", effective_models: ["actual-model"] }),
    );
    expect(lines).toContainEqual({ type: "worker.output_omitted", stream: "stderr", lines: 1 });
    expect(failure.stdout + failure.stderr).not.toContain("secret");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
      "-p",
      "prompt; $(env)",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "requested-model",
    ]);
  });
  it("keeps missing CLI exit code 127 and actionable diagnostics", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "syd-missing-cli-"));
    tempDirs.push(dir);
    try {
      await exec(
        process.execPath,
        [path.resolve("scripts/worker-engine-runner.mjs"), "claude", "-p", "test"],
        { env: { ...process.env, PATH: dir } },
      );
      expect.fail("missing CLI must fail");
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      expect(failure.code).toBe(127);
      expect(failure.stdout).toContain('"code":"ENOENT"');
      expect(failure.stdout).toContain("installed and executable");
      expect(failure.stdout).toContain('"code":127');
    }
  });
  it("classifies configuration and authentication failures without echoing secrets", () => {
    expect(classifyWorkerDiagnostic("unknown option --token=secret")).toEqual({
      code: "invalid_arguments",
      message: "Check the installed CLI version and supported worker flags.",
    });
    expect(classifyWorkerDiagnostic("Authentication failed for token secret")).toEqual({
      code: "authentication",
      message: "Check provider authentication and the credential-injecting proxy.",
    });
    expect(classifyWorkerDiagnostic("arbitrary secret text")).toBeNull();
  });
  it.each([false, true])(
    "stops process-group tool descendants (ignores SIGTERM: %s)",
    async (ignoreTerm) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "syd-cancel-cli-"));
      tempDirs.push(dir);
      const marker = path.join(dir, "terminated");
      const heartbeat = path.join(dir, "heartbeat");
      const pidFile = path.join(dir, "descendant.pid");
      writeFileSync(
        path.join(dir, "tool.cjs"),
        `const fs = require('node:fs'); fs.writeFileSync(process.env.PID_FILE, String(process.pid)); process.on('SIGTERM', () => { fs.writeFileSync(process.env.MARKER, 'terminated'); if (!process.env.IGNORE_TERM) process.exit(0); }); setInterval(() => fs.writeFileSync(process.env.HEARTBEAT, String(Date.now())), 30);`,
      );
      writeFileSync(
        path.join(dir, "claude"),
        `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.283'); process.exit(0); }
require('node:child_process').spawn(process.execPath, [process.env.TOOL], { stdio: 'inherit' }); setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const wrapper = spawn(
        process.execPath,
        [path.resolve("scripts/worker-engine-runner.mjs"), "claude", "-p", "test"],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            TOOL: path.join(dir, "tool.cjs"),
            PID_FILE: pidFile,
            MARKER: marker,
            HEARTBEAT: heartbeat,
            IGNORE_TERM: ignoreTerm ? "1" : "",
          },
        },
      );
      try {
        await vi.waitFor(() => expect(readFileSync(pidFile, "utf8")).toMatch(/^\d+$/), {
          timeout: 3000,
        });
        const closed = new Promise<void>((resolve) => wrapper.once("close", () => resolve()));
        wrapper.kill("SIGTERM");
        await closed;
        expect(readFileSync(marker, "utf8")).toBe("terminated");
        if (ignoreTerm) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const lastBeat = readFileSync(heartbeat, "utf8");
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(readFileSync(heartbeat, "utf8")).toBe(lastBeat);
        }
      } finally {
        if (wrapper.pid) {
          try {
            process.kill(-wrapper.pid, "SIGKILL");
          } catch {
            /* group exited */
          }
        }
      }
    },
  );
  it("inspects immutable image identity without reading container env", async () => {
    const id = `sha256:${"a".repeat(64)}`;
    const digest = `registry/worker@sha256:${"b".repeat(64)}`;
    const run = vi
      .fn()
      .mockResolvedValueOnce(id)
      .mockResolvedValueOnce(JSON.stringify([digest, "secret"]));
    expect(await containerImageMetadata("syd-SYD-1", run)).toEqual({
      image_id: id,
      image_digests: [digest],
    });
    expect(run.mock.calls[0][0]).toEqual([
      "container",
      "inspect",
      "--format",
      "{{.Image}}",
      "syd-SYD-1",
    ]);
    expect(run.mock.calls[1][0]).toEqual([
      "image",
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      id,
    ]);
  });
  it("reports unknown identity if Docker is unavailable", async () => {
    expect(
      await containerImageMetadata("missing", vi.fn().mockRejectedValue({ code: "ENOENT" })),
    ).toEqual({ image_id: null, image_digests: [] });
  });
});
