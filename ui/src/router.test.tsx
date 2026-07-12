// @vitest-environment jsdom
//
// SYD-55: leaving the board (e.g. for triage) and clicking "Board" again
// should return to the same project, not silently fall back to whatever
// project happens to be first in the list.
import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  getLastProject,
  href,
  isIssueRef,
  isKnownPath,
  navigate,
  parsePath,
  redirect,
  useRoute,
} from "./router";

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
      navigate({ view: "triage", project: null });
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

// SYD-75: the ref lives in the URL so reload/back/forward preserve the item
// being reviewed instead of it drifting with the polled list's order.
describe("review route", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
  });

  it("parses bare /review with no ref", () => {
    expect(parsePath("/review")).toEqual({ view: "review", project: null, ref: null });
  });

  it("parses /review/:ref, implying the ref's own project as the scope", () => {
    expect(parsePath("/review/SYD-66")).toEqual({ view: "review", project: "SYD", ref: "SYD-66" });
  });

  it("builds hrefs with and without a ref", () => {
    expect(href({ view: "review", project: null, ref: null })).toBe("/review");
    expect(href({ view: "review", project: "SYD", ref: "SYD-66" })).toBe("/review/SYD-66");
  });

  it("navigate pushes a new history entry per ref, so each is its own back-button stop", async () => {
    await mountRoute();
    const before = history.length;
    await act(async () => {
      navigate({ view: "review", project: "SYD", ref: "SYD-1" });
    });
    expect(location.pathname).toBe("/review/SYD-1");
    expect(history.length).toBe(before + 1);
    await act(async () => {
      navigate({ view: "review", project: "SYD", ref: "SYD-2" });
    });
    expect(location.pathname).toBe("/review/SYD-2");
    expect(history.length).toBe(before + 2);
  });

  it("redirect replaces the current entry instead of pushing a new one", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "review", project: null, ref: null });
    });
    expect(location.pathname).toBe("/review");
    const before = history.length;
    await act(async () => {
      redirect({ view: "review", project: "SYD", ref: "SYD-1" });
    });
    expect(location.pathname).toBe("/review/SYD-1");
    // Bare /review never became its own back-button stop.
    expect(history.length).toBe(before);
  });
});

// SYD-77: Triage and Review are project-scoped like Board, but a bare path
// means "All projects" so existing links/bookmarks keep working.
describe("triage/review project scoping", () => {
  it("parses bare paths as All projects", () => {
    expect(parsePath("/")).toEqual({ view: "triage", project: null });
    expect(parsePath("/triage")).toEqual({ view: "triage", project: null });
    expect(parsePath("/review")).toEqual({ view: "review", project: null, ref: null });
  });

  it("parses a project-scoped triage/review path", () => {
    expect(parsePath("/triage/SYD")).toEqual({ view: "triage", project: "SYD" });
    expect(parsePath("/review/SYD")).toEqual({ view: "review", project: "SYD", ref: null });
  });

  it("round-trips href for both bare and project-scoped routes", () => {
    expect(href({ view: "triage", project: null })).toBe("/");
    expect(href({ view: "triage", project: "SYD" })).toBe("/triage/SYD");
    expect(href({ view: "review", project: null, ref: null })).toBe("/review");
    expect(href({ view: "review", project: "SYD", ref: null })).toBe("/review/SYD");
  });

  it("treats an issue ref (with a -NUMBER suffix) as a specific selection, not a project key", () => {
    // "SYD-66" isn't a bare project key (2-10 uppercase letters), so /review
    // reads it as a ref and scopes to its project. Triage has no per-ref
    // concept, so the same segment there falls through to the default.
    expect(parsePath("/review/SYD-66")).toEqual({ view: "review", project: "SYD", ref: "SYD-66" });
    expect(parsePath("/triage/SYD-66")).toEqual({ view: "triage", project: null });
  });
});

// SYD-86: /search?q=… is the shareable/back-navigable results route; the
// query lives in the search string, not the path, so parsePath needs both.
describe("search route", () => {
  it("parses /search with no query as an empty search", () => {
    expect(parsePath("/search")).toEqual({ view: "search", query: "" });
  });

  it("parses /search?q=… into the query", () => {
    expect(parsePath("/search", "?q=auth%20bug")).toEqual({ view: "search", query: "auth bug" });
  });

  it("builds hrefs with and without a query, encoding special characters", () => {
    expect(href({ view: "search", query: "" })).toBe("/search");
    expect(href({ view: "search", query: "auth bug" })).toBe("/search?q=auth%20bug");
  });

  it("round-trips a query through href and parsePath", () => {
    const route = { view: "search" as const, query: "SYD-1 & friends" };
    const url = new URL(href(route), "http://localhost");
    expect(parsePath(url.pathname, url.search)).toEqual(route);
  });

  it("is a known path so the anchor interceptor and popstate handling pick it up", () => {
    expect(isKnownPath("/search")).toBe(true);
  });
});

// SYD-86: the ref fast-path — typing a ref like "SYD-52" into the search box
// jumps straight to the issue instead of showing a one-row results list.
describe("issue ref fast-path", () => {
  it("recognizes a well-formed ref", () => {
    expect(isIssueRef("SYD-52")).toBe(true);
    expect(isIssueRef("ACME-1")).toBe(true);
  });

  it("rejects plain words, bare project keys, and malformed refs", () => {
    expect(isIssueRef("search")).toBe(false);
    expect(isIssueRef("SYD")).toBe(false);
    expect(isIssueRef("SYD-")).toBe(false);
    expect(isIssueRef("syd-52")).toBe(false);
    expect(isIssueRef("SYD-52x")).toBe(false);
  });
});

describe("agents route (SYD-43)", () => {
  it("parses /agents", () => {
    expect(parsePath("/agents")).toEqual({ view: "agents" });
  });
  it("round-trips through href", () => {
    expect(href({ view: "agents" })).toBe("/agents");
  });
});

describe("settings route (SYD-158)", () => {
  it("parses /settings to the default projects tab", () => {
    expect(parsePath("/settings")).toEqual({ view: "settings", tab: "projects" });
  });
  it("parses each known tab", () => {
    for (const tab of ["projects", "actors", "integrations", "config"] as const) {
      expect(parsePath(`/settings/${tab}`)).toEqual({ view: "settings", tab });
    }
  });
  it("treats unknown tabs as an unknown path (falls back to triage)", () => {
    expect(isKnownPath("/settings/bogus")).toBe(false);
    expect(parsePath("/settings/bogus")).toEqual({ view: "triage", project: null });
  });
  it("round-trips through href", () => {
    expect(href({ view: "settings", tab: "projects" })).toBe("/settings");
    expect(href({ view: "settings", tab: "config" })).toBe("/settings/config");
  });
});
