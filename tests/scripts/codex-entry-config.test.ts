import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodexConfigToml } from "../../scripts/engines/codex.js";

// Exercise the actual shell config/auth handoff without cloning a repo or
// contacting a provider. Only its fixed output directory is relocated. Image
// startup/CLI parsing are covered separately by the worker-image smoke job.
const entry = readFileSync(
  path.resolve(__dirname, "../../scripts/container-entry.codex.sh"),
  "utf8",
);
const start = entry.indexOf("export CODEX_HOME=/tmp/codex-home");
const end = entry.indexOf("# The container is the sandbox here", start);
const account = "11111111-2222-3333-4444-555555555555";

describe("Codex entrypoint generated configuration (#268)", () => {
  it.each([false, true])(
    "writes private, secret-free config and placeholder auth (lease=%s)",
    (lease) => {
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const dir = mkdtempSync(path.join(tmpdir(), "codex-entry-config-"));
      try {
        const body = entry
          .slice(start, end)
          .replace("export CODEX_HOME=/tmp/codex-home", 'export CODEX_HOME="$TEST_CODEX_HOME"');
        const run = spawnSync("sh", ["-eu", "-c", body], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            TEST_CODEX_HOME: dir,
            CODEX_ACCOUNT_ID: account,
            SWITCHYARD_URL: "https://tracker.example",
            SWITCHYARD_TOKEN: "fixture-mcp-secret",
            SWITCHYARD_LEASE: lease ? "fixture-lease-secret" : "",
          },
        });
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        const config = readFileSync(path.join(dir, "config.toml"), "utf8");
        expect(config).toBe(
          buildCodexConfigToml("https://tracker.example", "SWITCHYARD_TOKEN", {
            leaseEnvVar: lease ? "SWITCHYARD_LEASE" : undefined,
          }),
        );
        const authText = readFileSync(path.join(dir, "auth.json"), "utf8");
        const auth = JSON.parse(authText);
        expect(auth.OPENAI_API_KEY).toBeNull();
        expect(auth.tokens.account_id).toBe(account);
        expect(auth.tokens.refresh_token).toBe("rt-placeholder");
        expect(auth.tokens.id_token).toBe(auth.tokens.access_token);
        const jwt = auth.tokens.access_token.split(".");
        expect(jwt).toHaveLength(3);
        const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString("utf8"));
        expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe(account);
        // 0.157.1's should_refresh_proactively checks JWT exp before last_refresh.
        expect(claims.exp).toBeGreaterThan(Date.now() / 1000 + 300);
        expect(Number.isNaN(Date.parse(auth.last_refresh))).toBe(false);
        for (const file of ["config.toml", "auth.json"]) {
          expect(statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
        }
        for (const text of [config, authText, run.stdout, run.stderr]) {
          expect(text).not.toContain("fixture-mcp-secret");
          expect(text).not.toContain("fixture-lease-secret");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
