// @vitest-environment jsdom
//
// SYD-55: the "Board" nav link must point at the project the user was last
// looking at, not always the first project in the list — and must fall
// back gracefully if that remembered project no longer exists.
// SYD-254: routes are scope-first (/SYD/board, /all/triage) and the topbar
// selector is the scope switcher for every view except settings.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Shell from "./Shell";
import { navigate } from "./router";
import type { Actor, Project } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: Actor = { id: 1, name: "sean", type: "human" };
const PROJECTS: Project[] = [
  { key: "ACME", name: "Acme" } as Project,
  { key: "SYD", name: "Switchyard" } as Project,
];

async function renderShell(projects: Project[] = PROJECTS): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Shell me={ME} projects={projects}>
        {null}
      </Shell>,
    );
  });
  return container;
}

function boardHref(container: HTMLElement): string | null {
  const links = [...container.querySelectorAll("nav a")];
  const boardLink = links.find((a) => a.textContent === "Board");
  return boardLink?.getAttribute("href") ?? null;
}

function navLink(container: HTMLElement, label: string): HTMLAnchorElement {
  const links = [...container.querySelectorAll<HTMLAnchorElement>("nav a")];
  // Review's label has a count badge appended as a text node sibling.
  const link = links.find((a) => a.textContent?.startsWith(label));
  if (!link) throw new Error(`no nav link labeled "${label}"`);
  return link;
}

function projectSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector(".topbar > select");
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button labeled "${label}"`);
  return button as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Shell board link", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("falls back to the first project when nothing has been visited yet", async () => {
    const container = await renderShell();
    expect(boardHref(container)).toBe("/ACME/board");
  });

  it("points at the last-visited board project after navigating to triage", async () => {
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/SYD/board");

    await act(async () => {
      navigate({ view: "triage", scope: "all" });
    });
    await act(async () => {}); // flush effects from the route change
    expect(boardHref(container)).toBe("/SYD/board");
  });

  it("ignores a remembered project that no longer exists", async () => {
    await act(async () => {
      navigate({ view: "board", scope: "GONE" });
    });
    await act(async () => {
      navigate({ view: "triage", scope: "all" });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/ACME/board");
  });
});

// SYD-254: every nav link renders under the current URL scope, so switching
// scope moves the whole chrome with it instead of each tab keeping its own
// per-tab project memory.
describe("Shell nav scope consistency", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("Triage/Review tabs point at the all scope when nothing has been visited yet", async () => {
    const container = await renderShell();
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/all/triage");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/all/review");
  });

  it("every nav link carries the current concrete scope", async () => {
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    const container = await renderShell();
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/SYD/triage");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/SYD/review");
    expect(navLink(container, "Agents").getAttribute("href")).toBe("/SYD/agents");
    expect(navLink(container, "Approvals").getAttribute("href")).toBe("/SYD/approvals");
  });

  it("moving to a different project's scope moves every nav link with it", async () => {
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    await act(async () => {
      navigate({ view: "triage", scope: "ACME" });
    });
    const container = await renderShell();
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/ACME/triage");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/ACME/review");
  });

  it("shows the scope selector with an All projects option everywhere except Board", async () => {
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    const boardContainer = await renderShell();
    const boardSelect = projectSelect(boardContainer);
    expect(boardSelect).not.toBeNull();
    expect([...boardSelect!.options].some((o) => o.value === "")).toBe(false);

    await act(async () => {
      navigate({ view: "triage", scope: "all" });
    });
    const triageContainer = await renderShell();
    const triageSelect = projectSelect(triageContainer);
    expect(triageSelect).not.toBeNull();
    expect(triageSelect!.value).toBe("");
    expect([...triageSelect!.options].map((o) => o.textContent)).toContain("All projects");

    await act(async () => {
      navigate({ view: "review", scope: "SYD", ref: null });
    });
    const reviewContainer = await renderShell();
    const reviewSelect = projectSelect(reviewContainer);
    expect(reviewSelect).not.toBeNull();
    expect(reviewSelect!.value).toBe("SYD");
  });

  it("choosing a project in the selector navigates to that scope on the current view", async () => {
    await act(async () => {
      navigate({ view: "triage", scope: "all" });
    });
    const container = await renderShell();
    const select = projectSelect(container)!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(select, "SYD");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(location.pathname).toBe("/SYD/triage");
  });

  it("choosing All projects in the selector navigates to the all scope", async () => {
    await act(async () => {
      navigate({ view: "review", scope: "SYD", ref: null });
    });
    const container = await renderShell();
    const select = projectSelect(container)!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(location.pathname).toBe("/all/review");
  });

  it("scopes the Review nav badge query to the active scope", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await act(async () => {
        navigate({ view: "triage", scope: "SYD" });
      });
      await renderShell();
      await act(async () => {});
      const issuesCalls = calls.filter((u) => u.startsWith("/api/issues?"));
      expect(
        issuesCalls.some((u) => u.includes("status=in_review") && u.includes("project=SYD")),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// SYD-214: the header's own "+ Project" popover was redundant with the
// Settings → Projects "New project" form, and was removed as part of the
// header collapse. Guard against it silently reappearing.
describe("Shell header (SYD-214)", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("no longer renders the header's own new-project popover or its toggle", async () => {
    const container = await renderShell();
    expect(container.querySelector(".new-project-popover")).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "+ Project")).toBe(
      false,
    );
  });

  it("always shows + New issue, the actor badge, and Log out", async () => {
    const container = await renderShell();
    expect(findButton(container, "+ New issue")).toBeTruthy();
    expect(container.querySelector(".badge.actor")?.textContent).toBe("sean");
    expect(findButton(container, "Log out")).toBeTruthy();
  });
});

// SYD-214: below the header-collapse breakpoint, the nav links (Triage /
// Board / Review / Agents / Settings) move into a disclosure menu toggled by
// a small menu button, controlled by a CSS breakpoint the menu-toggle button
// and the nav's "open" class exist for regardless of viewport width.
describe("Shell nav disclosure menu (SYD-214)", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  function menuToggle(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector(".menu-toggle");
    if (!button) throw new Error("no .menu-toggle button");
    return button as HTMLButtonElement;
  }

  function nav(container: HTMLElement): HTMLElement {
    return container.querySelector("nav") as HTMLElement;
  }

  it("renders nav closed by default and opens it on toggle click", async () => {
    const container = await renderShell();
    expect(nav(container).className).toBe("");
    expect(menuToggle(container).getAttribute("aria-expanded")).toBe("false");

    await click(menuToggle(container));
    expect(nav(container).className).toBe("open");
    expect(menuToggle(container).getAttribute("aria-expanded")).toBe("true");

    await click(menuToggle(container));
    expect(nav(container).className).toBe("");
  });

  it("closes the menu after picking a nav link", async () => {
    const container = await renderShell();
    await click(menuToggle(container));
    expect(nav(container).className).toBe("open");

    await click(navLink(container, "Board"));
    expect(nav(container).className).toBe("");
  });

  it("keeps every nav item (including the Review badge) present in the DOM regardless of menu state", async () => {
    const container = await renderShell();
    expect(navLink(container, "Triage")).toBeTruthy();
    expect(navLink(container, "Board")).toBeTruthy();
    expect(navLink(container, "Review")).toBeTruthy();
    expect(navLink(container, "Agents")).toBeTruthy();
    expect(navLink(container, "Settings")).toBeTruthy();
  });
});

// SYD-86: the topbar search box is reachable from every view. Enter either
// jumps straight to a well-formed issue ref or opens the current scope's
// /search results route; "/" focuses the box unless already typing elsewhere.
describe("Shell search box", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  function searchInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector(".search-box");
    if (!input) throw new Error("no .search-box input");
    return input as HTMLInputElement;
  }

  it("jumps straight to the issue for a well-formed ref (case-insensitive)", async () => {
    const container = await renderShell();
    const input = searchInput(container);
    await type(input, "syd-52");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(location.pathname).toBe("/SYD/issue/SYD-52");
  });

  it("opens the current scope's search for a plain-text query", async () => {
    await act(async () => {
      navigate({ view: "triage", scope: "SYD" });
    });
    const container = await renderShell();
    const input = searchInput(container);
    await type(input, "auth bug");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(location.pathname).toBe("/SYD/search");
    expect(location.search).toBe("?q=auth%20bug");
  });

  it("does nothing for an empty query", async () => {
    const container = await renderShell();
    const input = searchInput(container);
    const before = location.pathname;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(location.pathname).toBe(before);
  });

  it("focuses the search box on '/' unless already typing in a field", async () => {
    const container = await renderShell();
    const input = searchInput(container);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
  });

  it("keeps the search box in sync with the URL's query on the /search route", async () => {
    await act(async () => {
      navigate({ view: "search", scope: "all", query: "widgets" });
    });
    const container = await renderShell();
    expect(searchInput(container).value).toBe("widgets");
  });
});

describe("Shell agents nav (SYD-43)", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("links to the current scope's agents view and polls the active session count", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const container = await renderShell();
      await act(async () => {});
      expect(navLink(container, "Agents").getAttribute("href")).toBe("/all/agents");
      expect(calls.some((u) => u.startsWith("/api/agent-sessions?active=true"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Shell settings nav (SYD-158)", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("shows the Settings link for human actors", async () => {
    const container = await renderShell();
    expect(navLink(container, "Settings").getAttribute("href")).toBe("/settings");
  });

  it("hides the Settings link for agent actors", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Shell me={{ id: 9, name: "claude/dev", type: "agent" }} projects={PROJECTS}>
          {null}
        </Shell>,
      );
    });
    const links = [...container.querySelectorAll("nav a")];
    expect(links.some((a) => a.textContent?.startsWith("Settings"))).toBe(false);
  });
});
