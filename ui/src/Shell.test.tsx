// @vitest-environment jsdom
//
// SYD-55: the "Board" nav link must point at the project the user was last
// looking at, not always the first project in the list — and must fall
// back gracefully if that remembered project no longer exists.
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
    root.render(<Shell me={ME} projects={projects}>{null}</Shell>);
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
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
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
    expect(boardHref(container)).toBe("/board/ACME");
  });

  it("points at the last-visited board project after navigating to triage", async () => {
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/board/SYD");

    await act(async () => {
      navigate({ view: "triage", project: null });
    });
    await act(async () => {}); // flush effects from the route change
    expect(boardHref(container)).toBe("/board/SYD");
  });

  it("ignores a remembered project that no longer exists", async () => {
    await act(async () => {
      navigate({ view: "board", project: "GONE" });
    });
    await act(async () => {
      navigate({ view: "triage", project: null });
    });
    const container = await renderShell();
    expect(boardHref(container)).toBe("/board/ACME");
  });
});

// SYD-77: Triage and Review are project-scoped like Board, with an "All
// projects" option, and the Board nav-link pattern (default to the SYD-55
// remembered project) is mirrored for the Triage/Review tabs too.
describe("Shell triage/review project scoping", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("Triage/Review tabs point at All projects when nothing has been visited yet", async () => {
    const container = await renderShell();
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/review");
  });

  it("Triage/Review tabs point at the last-visited board project once one is remembered", async () => {
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    const container = await renderShell();
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/triage/SYD");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/review/SYD");
  });

  it("the active tab keeps its own project selection instead of the remembered one", async () => {
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    await act(async () => {
      navigate({ view: "triage", project: "ACME" });
    });
    const container = await renderShell();
    // Triage is active on ACME (its own URL), Review is inactive and falls
    // back to the last-remembered board project (SYD).
    expect(navLink(container, "Triage").getAttribute("href")).toBe("/triage/ACME");
    expect(navLink(container, "Review").getAttribute("href")).toBe("/review/SYD");
  });

  it("shows a project selector with an All projects option on Triage and Review, but not on Board", async () => {
    await act(async () => {
      navigate({ view: "board", project: "SYD" });
    });
    const boardContainer = await renderShell();
    const boardSelect = projectSelect(boardContainer);
    expect(boardSelect).not.toBeNull();
    expect([...boardSelect!.options].some((o) => o.value === "")).toBe(false);

    await act(async () => {
      navigate({ view: "triage", project: null });
    });
    const triageContainer = await renderShell();
    const triageSelect = projectSelect(triageContainer);
    expect(triageSelect).not.toBeNull();
    expect(triageSelect!.value).toBe("");
    expect([...triageSelect!.options].map((o) => o.textContent)).toContain("All projects");

    await act(async () => {
      navigate({ view: "review", project: "SYD", ref: null });
    });
    const reviewContainer = await renderShell();
    const reviewSelect = projectSelect(reviewContainer);
    expect(reviewSelect).not.toBeNull();
    expect(reviewSelect!.value).toBe("SYD");
  });

  it("choosing a project in the selector navigates to that project scope on the current view", async () => {
    await act(async () => {
      navigate({ view: "triage", project: null });
    });
    const container = await renderShell();
    const select = projectSelect(container)!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(select, "SYD");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(location.pathname).toBe("/triage/SYD");
  });

  it("choosing All projects in the selector navigates back to the bare route", async () => {
    await act(async () => {
      navigate({ view: "review", project: "SYD", ref: null });
    });
    const container = await renderShell();
    const select = projectSelect(container)!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(location.pathname).toBe("/review");
  });

  it("scopes the Review nav badge query to the active project selection", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await act(async () => {
        navigate({ view: "triage", project: "SYD" });
      });
      await renderShell();
      await act(async () => {});
      const issuesCalls = calls.filter((u) => u.startsWith("/api/issues?"));
      expect(issuesCalls.some((u) => u.includes("status=in_review") && u.includes("project=SYD"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// SYD-51: project creation had no UI — onboarding a new project required a
// raw curl call. The "+ Project" popover on Shell fills that gap.
describe("Shell new project form", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("toggles open and closed", async () => {
    const container = await renderShell();
    expect(container.querySelector(".new-project-popover")).toBeNull();

    await click(findButton(container, "+ Project"));
    expect(container.querySelector(".new-project-popover")).not.toBeNull();

    await click(findButton(container, "Cancel"));
    expect(container.querySelector(".new-project-popover")).toBeNull();
  });

  it("keeps the submit button disabled for an invalid or taken key, and enables it once valid", async () => {
    const container = await renderShell();
    await click(findButton(container, "+ Project"));

    const keyInput = container.querySelector('.new-project-popover input[placeholder="ACME"]') as HTMLInputElement;
    const nameInput = container.querySelector('.new-project-popover input[placeholder="Acme Corp"]') as HTMLInputElement;
    const submit = findButton(container, "Create project");
    expect(submit.disabled).toBe(true);

    // lowercase input is uppercased automatically; single letter is too short
    await type(keyInput, "a");
    expect(keyInput.value).toBe("A");
    expect(container.querySelector(".new-project-popover")!.textContent).toContain("2–10 uppercase letters");
    expect(submit.disabled).toBe(true);

    // a key already in use is flagged and blocks submit even once well-formed
    await type(keyInput, "acme");
    expect(container.querySelector(".new-project-popover")!.textContent).toContain('key "ACME" already exists');
    expect(submit.disabled).toBe(true);

    await type(keyInput, "foo");
    await type(nameInput, "Foo Inc");
    expect(submit.disabled).toBe(false);
  });

  it("creates the project, closes the popover, and navigates to its board", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/projects");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ key: "FOO", name: "Foo Inc" });
      return { ok: true, json: async () => ({ id: 3, key: "FOO", name: "Foo Inc" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const container = await renderShell();
      await click(findButton(container, "+ Project"));
      const keyInput = container.querySelector('.new-project-popover input[placeholder="ACME"]') as HTMLInputElement;
      const nameInput = container.querySelector('.new-project-popover input[placeholder="Acme Corp"]') as HTMLInputElement;
      await type(keyInput, "foo");
      await type(nameInput, "Foo Inc");

      await click(findButton(container, "Create project"));

      expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST" }));
      expect(container.querySelector(".new-project-popover")).toBeNull();
      expect(location.pathname).toBe("/board/FOO");
      // optimistic splice: the new project shows up in the switcher immediately,
      // without waiting for the next projects poll.
      expect([...container.querySelectorAll("select option")].some((o) => o.textContent === "FOO — Foo Inc")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a server error inline and leaves the popover open", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'A project with key "ACME" already exists — call list_projects to see it.' }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const container = await renderShell();
      await click(findButton(container, "+ Project"));
      const keyInput = container.querySelector('.new-project-popover input[placeholder="ACME"]') as HTMLInputElement;
      const nameInput = container.querySelector('.new-project-popover input[placeholder="Acme Corp"]') as HTMLInputElement;
      // key isn't in the local `projects` prop, so client-side validation passes;
      // the server still rejects it (e.g. another actor claimed it moments earlier)
      await type(keyInput, "zzz");
      await type(nameInput, "Zzz Inc");
      await click(findButton(container, "Create project"));

      expect(container.querySelector(".new-project-popover")).not.toBeNull();
      expect(container.querySelector(".error-bar")?.textContent).toContain("already exists");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// SYD-86: the topbar search box is reachable from every view. Enter either
// jumps straight to a well-formed issue ref or opens the /search results
// route; "/" focuses the box unless the user is already typing elsewhere.
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
    expect(location.pathname).toBe("/issue/SYD-52");
  });

  it("opens /search?q=… for a plain-text query", async () => {
    const container = await renderShell();
    const input = searchInput(container);
    await type(input, "auth bug");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(location.pathname).toBe("/search");
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
      navigate({ view: "search", query: "widgets" });
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

  it("links to /agents and polls the active session count", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const container = await renderShell();
      await act(async () => {});
      expect(navLink(container, "Agents").getAttribute("href")).toBe("/agents");
      expect(calls.some((u) => u.startsWith("/api/agent-sessions?active=true"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
