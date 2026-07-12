import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-186: the egress-proxy sidecar's entrypoint execs mitmdump with the
// credential-injection + allowlist addon. Pure shell, so it's testable here
// with plain `sh` — no Docker needed: CONFDIR points the CA dir at a temp dir
// and MITMDUMP_BIN=echo replaces the final exec so we can capture its argv.
// (Unlike the old tinyproxy entry there is no rendered config file — the
// behavior *is* the mitmdump command line.)

const SCRIPT = path.resolve(__dirname, "../../scripts/egress-proxy-entry.sh");
const ADDON = path.resolve(__dirname, "../../scripts/egress-inject-addon.py");

function run(env: Record<string, string>) {
  const confDir = mkdtempSync(path.join(tmpdir(), "egress-entry-test-"));
  const result = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CONFDIR: confDir, ADDON, MITMDUMP_BIN: "echo", ...env },
  });
  return { result, confDir };
}

describe("egress-proxy-entry.sh", () => {
  it("execs mitmdump with the injection addon, a pinned CA dir, and a public listener", () => {
    const { result, confDir } = run({ ALLOWED_DOMAINS: "api.anthropic.com,nas.local" });
    expect(result.status).toBe(0);

    const cmd = result.stdout;
    expect(cmd).toContain("--listen-host 0.0.0.0");
    expect(cmd).toContain("--listen-port 8888");
    expect(cmd).toContain(`--set confdir=${confDir}`);
    expect(cmd).toContain("--set block_global=false");
    expect(cmd).toContain(`-s ${ADDON}`);
    // No --ssl-insecure: the proxy still verifies the real provider's cert.
    expect(cmd).not.toContain("--ssl-insecure");
  });

  it("fails loudly when ALLOWED_DOMAINS is missing — a proxy that allows nothing helps nobody", () => {
    const { result } = run({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ALLOWED_DOMAINS");
  });
});
