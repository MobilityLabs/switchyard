import { describe, it, expect } from "vitest";
import {
  ensureEgressGuard,
  injectKeyEnvArgs,
  EGRESS_CA_VOLUME,
  EGRESS_CA_DIR,
  type WorkerConfig,
} from "../../scripts/worker-select.js";

// SYD-186: the egress sidecar now also injects real provider credentials, so
// ensureEgressGuard passes the provider keys into the sidecar (bare `-e VAR`,
// value never in argv), mounts a persisted CA volume, and recreates the sidecar
// when the *set* of injected key-vars changes — but never regenerates the CA.

const config: WorkerConfig = {
  url: "http://localhost:3300",
  label: "auto",
  intervalSeconds: 300,
  maxConcurrent: 2,
  projects: { SYD: { repo: "/repo/syd" } },
};

const domainsCsv = "api.anthropic.com,localhost,registry.npmjs.org";

type Call = { cmd: string; args: string[] };
function mockExec(respond: (call: Call) => string | Error) {
  const calls: Call[] = [];
  const exec = async (cmd: string, args: string[]) => {
    const call = { cmd, args };
    calls.push(call);
    const out = respond(call);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { calls, exec };
}

describe("injectKeyEnvArgs", () => {
  it("emits a bare `-e VAR` (value never in argv) for each present provider key", () => {
    expect(
      injectKeyEnvArgs({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-X" } as NodeJS.ProcessEnv),
    ).toEqual(["-e", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("omits absent keys and never carries a secret value", () => {
    const args = injectKeyEnvArgs({
      ANTHROPIC_API_KEY: "sk-ant-api-Y",
      GEMINI_API_KEY: "g-key",
    } as NodeJS.ProcessEnv);
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args).toContain("GEMINI_API_KEY");
    expect(args).not.toContain("OPENAI_API_KEY");
    expect(args).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(args.join(" ")).not.toContain("sk-ant-api-Y");
    expect(args.join(" ")).not.toContain("g-key");
  });

  it("treats an empty-string key as absent", () => {
    expect(injectKeyEnvArgs({ OPENAI_API_KEY: "" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("ensureEgressGuard — credential injection + CA (SYD-186)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REAL" } as NodeJS.ProcessEnv;

  it("mounts the persisted CA volume and passes present provider keys into the sidecar", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network" && args[1] === "inspect") return new Error("no such network");
      if (args[0] === "inspect") return new Error("no such container");
      return "";
    });
    await ensureEgressGuard(config, exec, env);

    const run = calls.find((c) => c.args[0] === "run");
    expect(run).toBeDefined();
    const joined = run!.args.join(" ");
    // CA volume mounted at the mitmproxy confdir.
    expect(joined).toContain(`-v ${EGRESS_CA_VOLUME}:${EGRESS_CA_DIR}`);
    // Real key passed bare — the value never appears in argv.
    const passesKey = run!.args.some(
      (a, i) => a === "-e" && run!.args[i + 1] === "CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(passesKey).toBe(true);
    expect(joined).not.toContain("sk-ant-oat-REAL");
    // Freshness sentinel carries key *names* only, never values.
    expect(joined).toContain("INJECT_KEYS=CLAUDE_CODE_OAUTH_TOKEN");
    // A key absent from env is not passed.
    expect(joined).not.toContain("OPENAI_API_KEY");
  });

  it("is a no-op when domains AND the injected key-set both still match", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect")
        return `true ALLOWED_DOMAINS=${domainsCsv} INJECT_KEYS=CLAUDE_CODE_OAUTH_TOKEN`;
      return "";
    });
    await ensureEgressGuard(config, exec, env);
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
  });

  it("recreates the sidecar when the injected key-set changed (domains unchanged)", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      // Same domains, but the sidecar was built with a different key-set.
      if (args[0] === "inspect")
        return `true ALLOWED_DOMAINS=${domainsCsv} INJECT_KEYS=ANTHROPIC_API_KEY`;
      return "";
    });
    await ensureEgressGuard(config, exec, env);

    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("rm -f syd-egress"));
    expect(calls.some((c) => c.args[0] === "run")).toBe(true);
  });

  it("never removes or regenerates the CA volume on recreate", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network") return "[]";
      if (args[0] === "inspect")
        return `true ALLOWED_DOMAINS=${domainsCsv} INJECT_KEYS=ANTHROPIC_API_KEY`;
      return "";
    });
    await ensureEgressGuard(config, exec, env);
    // The container is rm'd and recreated, but the CA volume must persist —
    // regenerating it would break the trust every agent container already has.
    expect(calls.some((c) => c.args[0] === "volume" && c.args[1] === "rm")).toBe(false);
    expect(calls.some((c) => c.args[0] === "rm" && c.args.includes("-v"))).toBe(false);
  });

  it("passes the Codex OAuth token into the sidecar when present", async () => {
    const { calls, exec } = mockExec(({ args }) => {
      if (args[0] === "network" && args[1] === "inspect") return new Error("no such network");
      if (args[0] === "inspect") return new Error("no such container");
      return "";
    });
    await ensureEgressGuard(config, exec, { CODEX_OAUTH_TOKEN: "cxo-REAL" } as NodeJS.ProcessEnv);
    const run = calls.find((c) => c.args[0] === "run")!;
    const passes = run.args.some((a, i) => a === "-e" && run.args[i + 1] === "CODEX_OAUTH_TOKEN");
    expect(passes).toBe(true);
    expect(run.args.join(" ")).toContain("INJECT_KEYS=CODEX_OAUTH_TOKEN");
    expect(run.args.join(" ")).not.toContain("cxo-REAL");
  });
});
