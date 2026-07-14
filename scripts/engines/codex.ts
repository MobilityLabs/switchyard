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

/** Env var the session-scoped lease is passed in (SYD-210); codex reads it via env_http_headers (SYD-220). */
export const CODEX_LEASE_ENV_VAR = "SWITCHYARD_LEASE";

/** MCP header the lease rides in, matched by the tracker's lease enforcement (SYD-210). */
export const SWITCHYARD_LEASE_HEADER = "X-Switchyard-Lease";

export function buildCodexConfigToml(
  switchyardUrl: string,
  tokenEnvVar: string = CODEX_BEARER_TOKEN_ENV_VAR,
  opts: { leaseEnvVar?: string } = {},
): string {
  const url = `${switchyardUrl.replace(/\/$/, "")}/mcp`;
  let toml = `[mcp_servers.switchyard]\nurl = "${url}"\nbearer_token_env_var = "${tokenEnvVar}"\n`;
  // SYD-220: codex 0.144.x supports env_http_headers — the env var NAME (never
  // its value) sourcing a custom header, exact parity with bearer_token_env_var.
  // Under lease enforcement the session's claim-scoped writes must carry the
  // lease as X-Switchyard-Lease; the value stays in the env, out of the file/argv.
  if (opts.leaseEnvVar) {
    toml += `env_http_headers = { "${SWITCHYARD_LEASE_HEADER}" = "${opts.leaseEnvVar}" }\n`;
  }
  return toml;
}

// Spike (Task 1): headless full-auto in codex 0.142.5 (the container is the
// sandbox). `--ask-for-approval never` was removed in this version.
export function buildCodexExecArgs(prompt: string): string[] {
  return ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt];
}
