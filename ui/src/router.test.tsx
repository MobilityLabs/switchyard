// @vitest-environment jsdom
//
// SYD-55: leaving the board (e.g. for triage) and clicking "Board" again
// should return to the same project, not silently fall back to whatever
// project happens to be first in the list.
import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getLastProject, navigate, useRoute } from "./router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useRoute();
  return null;
}

async function mountRoute(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
}

describe("last-project memory", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("has no remembered project before any board visit", () => {
    expect(getLastProject()).toBeNull();
  });

  it("remembers the project after useRoute observes a board route", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    expect(getLastProject()).toBe("SYD");
  });

  it("keeps the last board project after navigating away to triage", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", project: "ACME" });
    });
    expect(getLastProject()).toBe("ACME");

    await act(async () => {
      navigate({ view: "triage" });
    });
    // Still ACME: triage isn't a board route, so it must not clear the memory.
    expect(getLastProject()).toBe("ACME");
  });

  it("updates the memory when switching to a different project's board", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    await act(async () => {
      navigate({ view: "board", project: "ACME" });
    });
    expect(getLastProject()).toBe("ACME");
  });
});
