// @vitest-environment jsdom
//
// SYD-55: the "Board" nav link must point at the project the user was last
// looking at, not always the first project in the list — and must fall
// back gracefully if that remembered project no longer exists.
import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Shell from "./Shell";
import { navigate } from "./router";
import type { Actor, Project } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: Actor = { id: 1, name: "sean", kind: "human" } as Actor;
const PROJECTS: Project[] = [
  { key: "ACME", name: "Acme" } as Project,
  { key: "SYD", name: "Switchyard" } as Project,
];

async function renderShell(projects: Project[] = PROJECTS): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Shell me={ME} projects={projects}>{null}</Shell>);
  });
  return container;
}

function boardHref(container: HTMLElement): string | null {
  const links = [...container.querySelectorAll("nav a")];
  const boardLink = links.find((a) => a.textContent === "Board");
  return boardLink?.getAttribute("href") ?? null;
}

describe("Shell board link", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("falls back to the first project when nothing has been visited yet", async () => {
    const container = await renderShell();
    expect(boardHref(container)).toBe("/board/ACME");
  });

  it("points at the last-visited board project after navigating to triage", async () => {
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/board/SYD");

    await act(async () => {
      navigate({ view: "triage" });
    });
    await act(async () => {}); // flush effects from the route change
    expect(boardHref(container)).toBe("/board/SYD");
  });

  it("ignores a remembered project that no longer exists", async () => {
    await act(async () => {
      navigate({ view: "board", project: "GONE" });
    });
    await act(async () => {
      navigate({ view: "triage" });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/board/ACME");
  });
});
