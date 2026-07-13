// tests/scripts/engines/codex.test.ts
import { describe, it, expect } from "vitest";
import {
  buildCodexConfigToml,
  buildCodexExecArgs,
  DEFAULT_CODEX_IMAGE,
  CODEX_BEARER_TOKEN_ENV_VAR,
} from "../../../scripts/engines/codex.js";

describe("codex engine builders", () => {
  it("writes an MCP config.toml that names the token env var, never the token", () => {
    const toml = buildCodexConfigToml("http://host:3300/");
    expect(toml).toContain("[mcp_servers.switchyard]");
    expect(toml).toContain('url = "http://host:3300/mcp"');
    expect(toml).toContain('bearer_token_env_var = "SWITCHYARD_TOKEN"');
    expect(toml).not.toMatch(/Bearer |token = /);
  });

  it("builds a headless codex exec argv (container is the sandbox)", () => {
    // Spike (Task 1): codex 0.142.5 dropped --ask-for-approval; headless
    // full-auto is --dangerously-bypass-approvals-and-sandbox.
    expect(buildCodexExecArgs("do the thing")).toEqual([
      "exec", "--dangerously-bypass-approvals-and-sandbox", "do the thing",
    ]);
  });

  it("exposes the codex image + bearer var constants", () => {
    expect(DEFAULT_CODEX_IMAGE).toBe("switchyard-worker-codex");
    expect(CODEX_BEARER_TOKEN_ENV_VAR).toBe("SWITCHYARD_TOKEN");
  });
});
