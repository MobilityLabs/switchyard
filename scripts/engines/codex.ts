// OpenAI Codex CLI engine adapter (SYD-187). Ported from the stranded
// agent/SYD-83:scripts/runners/codex.ts, minus its API-key auth: auth here is
// the user's ChatGPT login, injected by the syd-egress proxy (the container
// holds only a placeholder auth.json), so no provider key is passed in-container.
//
// Codex reads MCP config from $CODEX_HOME/config.toml (not a CLI flag) with a
// dedicated bearer_token_env_var key — the token name, never its value, so the
// bearer never appears in the file or in argv.

export const DEFAULT_CODEX_BINARY = "codex";
export const DEFAULT_CODEX_IMAGE = "switchyard-worker-codex";

/** Env var Codex is told (via bearer_token_env_var) to read the switchyard MCP token from at run time. */
export const CODEX_BEARER_TOKEN_ENV_VAR = "SWITCHYARD_TOKEN";

/** Proxy-held ChatGPT OAuth token the syd-egress sidecar injects for the Codex host (secret). */
export const CODEX_OAUTH_TOKEN_VAR = "CODEX_OAUTH_TOKEN";

/** ChatGPT account UUID (NON-secret) codex sends as the chatgpt-account-id header; goes in the container's placeholder auth.json. */
export const CODEX_ACCOUNT_ID_VAR = "CODEX_ACCOUNT_ID";

export function buildCodexConfigToml(
  switchyardUrl: string,
  tokenEnvVar: string = CODEX_BEARER_TOKEN_ENV_VAR,
): string {
  const url = `${switchyardUrl.replace(/\/$/, "")}/mcp`;
  return `[mcp_servers.switchyard]\nurl = "${url}"\nbearer_token_env_var = "${tokenEnvVar}"\n`;
}

// Spike (Task 1): headless full-auto in codex 0.142.5 (the container is the
// sandbox). `--ask-for-approval never` was removed in this version.
export function buildCodexExecArgs(prompt: string): string[] {
  return ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt];
}
