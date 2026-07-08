// The `runner: "sdk"` dispatch path (SYD-47): run a headless session through
// the Claude Agent SDK, in-process, instead of shelling out to `claude -p`.
//
// Why this exists alongside the CLI runner: the MCP bearer token is handed to
// the SDK as an in-memory object — it never touches argv (visible to ps) or a
// temp file, which both CLI modes need — and the typed event stream gives the
// worker log one line per tool call instead of an opaque transcript.
//
// This file lives in worker-sdk/ (own package.json, own node_modules) because
// the SDK peer-depends on zod@4 while the main app is pinned to zod@3.
// agent-worker.ts imports it via a runtime-computed path so the main
// typecheck and the server Docker image never depend on it. Auth is the same
// CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) from the environment.

import { appendFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { formatSdkEvent, type SdkEventLike } from "./sdk-format.js";

export type SdkSessionOpts = {
  prompt: string;
  cwd: string;
  switchyardUrl: string;
  switchyardToken: string;
  allowedTools: string[];
  logPath: string;
};

/** Run one issue's session to completion. Resolves to an exit-code-like
 * number (0 = the session finished successfully) so the worker can treat SDK
 * runs and child processes uniformly. Never throws for session-level errors —
 * they're logged and reported as a nonzero result. */
export async function runSdkSession(o: SdkSessionOpts): Promise<number> {
  const log = (line: string) => appendFileSync(o.logPath, `${line}\n`);
  let exit = 1;
  try {
    const stream = query({
      prompt: o.prompt,
      options: {
        cwd: o.cwd,
        permissionMode: "acceptEdits",
        allowedTools: o.allowedTools,
        mcpServers: {
          switchyard: {
            type: "http",
            url: `${o.switchyardUrl.replace(/\/$/, "")}/mcp`,
            headers: { Authorization: `Bearer ${o.switchyardToken}` },
          },
        },
      },
    });
    for await (const message of stream) {
      const line = formatSdkEvent(message as SdkEventLike);
      if (line) log(line);
      if (message.type === "result") {
        exit = message.subtype === "success" ? 0 : 1;
      }
    }
  } catch (err) {
    log(`[sdk] session error: ${(err as Error).message}`);
    exit = 1;
  }
  return exit;
}
