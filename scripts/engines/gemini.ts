// Google Gemini CLI engine adapter (SYD-225). Third engine alongside Claude and
// Codex, reusing the engine-agnostic dispatch pipeline. Auth is a static
// AI-Studio API key (GEMINI_API_KEY), injected by the syd-egress proxy as the
// x-goog-api-key header for generativelanguage.googleapis.com (the rule is
// already provisioned in scripts/egress-inject-addon.py) — the container holds
// only a placeholder key + the CA public cert, never the real key.
//
// gemini-cli reads MCP config from settings.json (os.homedir()/.gemini/), which
// supports the httpUrl transport + a headers map AND $VAR expansion. So the
// switchyard MCP's bearer token and session lease are named as env REFERENCES
// (${SWITCHYARD_TOKEN} / ${SWITCHYARD_LEASE}) — the value stays in the env, out
// of the file and argv (parity with Codex's bearer_token_env_var, per SYD-220).

export const DEFAULT_GEMINI_BINARY = "gemini";
export const DEFAULT_GEMINI_IMAGE = "switchyard-worker-gemini";

/** Env var holding the AI-Studio API key; the proxy injects the real one, the container gets a placeholder. */
export const GEMINI_API_KEY_VAR = "GEMINI_API_KEY";

/** Env var + value that select API-key auth non-interactively (skips the auth picker that blocks headless startup). */
export const GEMINI_DEFAULT_AUTH_TYPE_VAR = "GEMINI_DEFAULT_AUTH_TYPE";
export const GEMINI_API_KEY_AUTH_TYPE = "gemini-api-key";

/** Default env var name the switchyard MCP bearer token is read from (via ${...} expansion in settings.json). */
export const GEMINI_TOKEN_ENV_VAR = "SWITCHYARD_TOKEN";

/** MCP header the session-scoped lease rides in (SYD-210), matched by the tracker's lease enforcement. */
export const SWITCHYARD_LEASE_HEADER = "X-Switchyard-Lease";

export function buildGeminiSettingsJson(
  switchyardUrl: string,
  opts: { tokenEnvVar?: string; leaseEnvVar?: string } = {},
): string {
  const url = `${switchyardUrl.replace(/\/$/, "")}/mcp`;
  const tokenEnvVar = opts.tokenEnvVar ?? GEMINI_TOKEN_ENV_VAR;
  const headers: Record<string, string> = {
    // Env reference, not a literal — gemini expands ${...} at connect time, so
    // the token value never appears in the 0600 settings.json or in argv.
    Authorization: `Bearer \${${tokenEnvVar}}`,
  };
  // SYD-220 parity: under lease enforcement the session's claim-scoped writes
  // must carry the lease as X-Switchyard-Lease; also an env reference.
  if (opts.leaseEnvVar) {
    headers[SWITCHYARD_LEASE_HEADER] = `\${${opts.leaseEnvVar}}`;
  }
  const settings = {
    // Select API-key mode non-interactively (no auth picker on headless startup).
    security: { auth: { selectedType: GEMINI_API_KEY_AUTH_TYPE } },
    mcpServers: {
      switchyard: { httpUrl: url, headers },
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Headless full-auto: the container is the sandbox, so --yolo auto-approves and
// --prompt runs one non-interactive turn (gemini-cli 0.x flag names).
export function buildGeminiExecArgs(prompt: string): string[] {
  return ["--yolo", "--prompt", prompt];
}
