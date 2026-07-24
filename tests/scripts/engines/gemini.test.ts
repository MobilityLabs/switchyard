// tests/scripts/engines/gemini.test.ts
import { describe, it, expect } from "vitest";
import {
  buildGeminiSettingsJson,
  buildGeminiExecArgs,
  DEFAULT_GEMINI_IMAGE,
  GEMINI_API_KEY_VAR,
} from "../../../scripts/engines/gemini.js";

describe("gemini engine builders", () => {
  it("writes a settings.json wiring the switchyard MCP over httpUrl, auth via env ref (never the token value)", () => {
    const json = buildGeminiSettingsJson("http://host:3300/");
    const settings = JSON.parse(json);
    expect(settings.mcpServers.switchyard.httpUrl).toBe("http://host:3300/mcp");
    // The token is an env REFERENCE (${VAR}), so the value never lands in the file.
    expect(settings.mcpServers.switchyard.headers.Authorization).toBe("Bearer ${SWITCHYARD_TOKEN}");
    // API-key mode selected non-interactively.
    expect(settings.security.auth.selectedType).toBe("gemini-api-key");
    // No baked secret / bearer literal.
    expect(json).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it("adds an env-referenced X-Switchyard-Lease header when a lease env var is given (SYD-220 parity)", () => {
    const json = buildGeminiSettingsJson("http://host:3300/", {
      leaseEnvVar: "SWITCHYARD_LEASE",
    });
    const settings = JSON.parse(json);
    expect(settings.mcpServers.switchyard.headers["X-Switchyard-Lease"]).toBe(
      "${SWITCHYARD_LEASE}",
    );
  });

  it("omits the lease header when no lease env var is given (non-lease sessions)", () => {
    const json = buildGeminiSettingsJson("http://host:3300/");
    const settings = JSON.parse(json);
    expect(settings.mcpServers.switchyard.headers["X-Switchyard-Lease"]).toBeUndefined();
    expect(json).not.toContain("X-Switchyard-Lease");
  });

  it("builds a headless full-auto gemini argv (container is the sandbox)", () => {
    expect(buildGeminiExecArgs("do the thing")).toEqual(["--yolo", "--prompt", "do the thing"]);
  });

  it("exposes the gemini image + api-key var constants", () => {
    expect(DEFAULT_GEMINI_IMAGE).toBe("switchyard-worker-gemini");
    expect(GEMINI_API_KEY_VAR).toBe("GEMINI_API_KEY");
  });
});
