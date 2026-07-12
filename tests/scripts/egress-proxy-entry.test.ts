import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// SYD-110: the egress-proxy sidecar's entrypoint renders tinyproxy's config
// from the ALLOWED_DOMAINS env var. Pure shell + files, so it's testable
// here with plain `sh` — no Docker needed: CONF_DIR points the output at a
// temp dir and TINYPROXY_BIN=true replaces the final exec.

const SCRIPT = path.resolve(__dirname, "../../scripts/egress-proxy-entry.sh");

function run(env: Record<string, string>) {
  const confDir = mkdtempSync(path.join(tmpdir(), "egress-entry-test-"));
  const result = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CONF_DIR: confDir, TINYPROXY_BIN: "true", ...env },
  });
  return { result, confDir };
}

describe("egress-proxy-entry.sh", () => {
  it("renders a default-deny tinyproxy config with one anchored pattern per domain", () => {
    const { result, confDir } = run({ ALLOWED_DOMAINS: "api.anthropic.com,nas.local" });
    expect(result.status).toBe(0);

    const conf = readFileSync(path.join(confDir, "tinyproxy.conf"), "utf8");
    expect(conf).toContain("Port 8888");
    expect(conf).toContain("Listen 0.0.0.0");
    expect(conf).toContain("FilterDefaultDeny Yes");
    expect(conf).toContain("FilterType ere");
    expect(conf).toContain("FilterURLs No");
    expect(conf).toContain(`Filter "${confDir}/filter"`);

    const filter = readFileSync(path.join(confDir, "filter"), "utf8");
    expect(filter.trim().split("\n")).toEqual(["^api\\.anthropic\\.com$", "^nas\\.local$"]);
  });

  it("fails loudly when ALLOWED_DOMAINS is missing — a proxy that allows nothing helps nobody", () => {
    const { result } = run({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ALLOWED_DOMAINS");
  });
});
