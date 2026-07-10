// @vitest-environment jsdom
//
// SYD-43: the Agents panel shows live worker sessions (issue ref, elapsed,
// last progress note) split from recently-exited ones.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentSession } from "../types";

vi.mock("../api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
}));

import { listAgentSessions } from "../api";
import Agents, { formatElapsed } from "./Agents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 1, ref: "SYD-1", issueTitle: "Ship v1", mode: "cli",
    pid: 4242, status: "running", exitCode: null,
    startedAt: Math.floor(Date.now() / 1000) - 90, endedAt: null, lastNote: null,
    ...overrides,
  };
}

async function renderAgents(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Agents />); });
  return container;
}

afterEach(() => vi.mocked(listAgentSessions).mockReset());

describe("formatElapsed", () => {
  it("renders seconds, minutes, and hours", () => {
    expect(formatElapsed(1000, 1042)).toBe("42s");
    expect(formatElapsed(1000, 1000 + 7 * 60)).toBe("7m");
    expect(formatElapsed(1000, 1000 + 3600 + 12 * 60)).toBe("1h 12m");
  });
  it("uses now for a still-running session", () => {
    expect(formatElapsed(1000, null, 1090)).toBe("1m");
  });
  it("crosses the 60s boundary from seconds to minutes (SYD-105)", () => {
    expect(formatElapsed(1000, 1059)).toBe("59s");
    expect(formatElapsed(1000, 1060)).toBe("1m");
  });
  it("crosses the 3600s boundary from minutes to hours, rendering '1h 0m' at the seam (SYD-105)", () => {
    expect(formatElapsed(1000, 1000 + 3599)).toBe("59m");
    expect(formatElapsed(1000, 1000 + 3600)).toBe("1h 0m");
  });
  it("clamps a clock-skewed endedAt before startedAt to 0s instead of going negative (SYD-105)", () => {
    expect(formatElapsed(1000, 900)).toBe("0s");
  });
});

describe("Agents view", () => {
  it("splits running sessions from exited ones and links the ref", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 2, status: "running", lastNote: { note: "writing tests", createdAt: 0 } }),
      session({ id: 1, ref: "SYD-9", status: "exited", exitCode: 0, endedAt: Math.floor(Date.now() / 1000) }),
    ]);
    const container = await renderAgents();
    const text = container.textContent ?? "";
    expect(text).toContain("writing tests");
    expect(text).toContain("SYD-9");
    expect(container.querySelector('a[href="/issue/SYD-1"]')).not.toBeNull();
    const sections = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(sections).toEqual(["Active sessions", "Recent"]);
  });

  it("shows empty states when nothing is running", async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const container = await renderAgents();
    expect(container.textContent).toContain("No agent sessions");
  });
});
