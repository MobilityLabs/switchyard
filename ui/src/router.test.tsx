// @vitest-environment jsdom
//
// SYD-254: scope-first routing — the first path segment of every route
// except /settings is the scope (a project key, or the reserved lowercase
// "all" for cross-project views). Legacy view-first paths still parse (old
// bookmarks, refs in markdown comments) and useRoute canonicalizes the
// address bar to the scope-first form via replaceState.
import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  getLastProject,
  href,
  isIssueRef,
  isKnownPath,
  issueRoute,
  navigate,
  parsePath,
  redirect,
  scopeProject,
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

describe("scope-first routes", () => {
  it("parses every scoped view", () => {
    expect(parsePath("/SYD/triage")).toEqual({ view: "triage", scope: "SYD" });
    expect(parsePath("/all/triage")).toEqual({ view: "triage", scope: "all" });
    expect(parsePath("/SYD/board")).toEqual({ view: "board", scope: "SYD" });
    expect(parsePath("/SYD/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/SYD/review")).toEqual({ view: "review", scope: "SYD", ref: null });
    expect(parsePath("/all/review")).toEqual({ view: "review", scope: "all", ref: null });
    expect(parsePath("/all/review/SYD-66")).toEqual({
      view: "review",
      scope: "all",
      ref: "SYD-66",
    });
    expect(parsePath("/SYD/new")).toEqual({ view: "new-issue", scope: "SYD" });
    expect(parsePath("/SYD/search", "?q=auth%20bug")).toEqual({
      view: "search",
      scope: "SYD",
      query: "auth bug",
    });
    expect(parsePath("/all/agents")).toEqual({ view: "agents", scope: "all" });
    expect(parsePath("/all/approvals")).toEqual({ view: "approvals", scope: "all" });
  });

  it("round-trips href for every scoped view", () => {
    expect(href({ view: "triage", scope: "all" })).toBe("/all/triage");
    expect(href({ view: "triage", scope: "SYD" })).toBe("/SYD/triage");
    expect(href({ view: "board", scope: "SYD" })).toBe("/SYD/board");
    expect(href({ view: "issue", scope: "SYD", ref: "SYD-66" })).toBe("/SYD/issue/SYD-66");
    expect(href({ view: "review", scope: "SYD", ref: null })).toBe("/SYD/review");
    expect(href({ view: "review", scope: "all", ref: "SYD-66" })).toBe("/all/review/SYD-66");
    expect(href({ view: "new-issue", scope: "all" })).toBe("/all/new");
    expect(href({ view: "search", scope: "SYD", query: "auth bug" })).toBe(
      "/SYD/search?q=auth%20bug",
    );
    expect(href({ view: "search", scope: "SYD", query: "" })).toBe("/SYD/search");
    expect(href({ view: "agents", scope: "HEX" })).toBe("/HEX/agents");
    expect(href({ view: "approvals", scope: "all" })).toBe("/all/approvals");
  });

  it("board needs a concrete project key — /all/board is not a route", () => {
    expect(isKnownPath("/all/board")).toBe(false);
  });

  it("/all/issue/:ref is known — the ref supplies the concrete scope", () => {
    expect(parsePath("/all/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
  });

  it("the ref wins a ref-vs-scope mismatch", () => {
    expect(parsePath("/SYD/issue/HEX-3")).toEqual({ view: "issue", scope: "HEX", ref: "HEX-3" });
  });

  it("rejects malformed scope segments", () => {
    expect(isKnownPath("/syd/board")).toBe(false);
    expect(isKnownPath("/TOOLONGPROJECTKEY/board")).toBe(false);
    expect(isKnownPath("/SYD/bogus")).toBe(false);
  });

  it("scopeProject maps 'all' to null and a key to itself", () => {
    expect(scopeProject("all")).toBeNull();
    expect(scopeProject("SYD")).toBe("SYD");
  });

  it("issueRoute derives the scope from the ref", () => {
    expect(issueRoute("HEX-3")).toEqual({ view: "issue", scope: "HEX", ref: "HEX-3" });
  });
});

describe("legacy redirects (old shape parses to the new Route)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("maps every legacy row from the spec table", () => {
    expect(parsePath("/triage")).toEqual({ view: "triage", scope: "all" });
    expect(parsePath("/triage/SYD")).toEqual({ view: "triage", scope: "SYD" });
    expect(parsePath("/board/SYD")).toEqual({ view: "board", scope: "SYD" });
    expect(parsePath("/issue/SYD-66")).toEqual({ view: "issue", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/review")).toEqual({ view: "review", scope: "all", ref: null });
    expect(parsePath("/review/SYD")).toEqual({ view: "review", scope: "SYD", ref: null });
    expect(parsePath("/review/SYD-66")).toEqual({ view: "review", scope: "SYD", ref: "SYD-66" });
    expect(parsePath("/new")).toEqual({ view: "new-issue", scope: "all" });
    expect(parsePath("/agents")).toEqual({ view: "agents", scope: "all" });
    expect(parsePath("/approvals")).toEqual({ view: "approvals", scope: "all" });
    expect(parsePath("/search", "?q=x")).toEqual({ view: "search", scope: "all", query: "x" });
  });

  it("legacy paths stay known paths so the anchor interceptor catches markdown links", () => {
    expect(isKnownPath("/issue/SYD-66")).toBe(true);
    expect(isKnownPath("/board/SYD")).toBe(true);
    expect(isKnownPath("/triage")).toBe(true);
    expect(isKnownPath("/review/SYD-66")).toBe(true);
  });

  it("bare / lands on the last concrete scope's triage, else all", () => {
    expect(parsePath("/")).toEqual({ view: "triage", scope: "all" });
    localStorage.setItem("switchyard:last-project", "SYD");
    expect(parsePath("/")).toEqual({ view: "triage", scope: "SYD" });
  });
});

describe("useRoute canonicalization", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("replaces a legacy URL with its canonical scope-first form", async () => {
    history.replaceState(null, "", "/issue/SYD-66");
    await mountRoute();
    expect(location.pathname).toBe("/SYD/issue/SYD-66");
  });

  it("rewrites a mismatched issue scope to the ref's project", async () => {
    history.replaceState(null, "", "/SYD/issue/HEX-3");
    await mountRoute();
    expect(location.pathname).toBe("/HEX/issue/HEX-3");
  });

  it("leaves an already-canonical URL alone", async () => {
    history.replaceState(null, "", "/SYD/board");
    await mountRoute();
    expect(location.pathname).toBe("/SYD/board");
  });

  it("carries the search query through canonicalization", async () => {
    history.replaceState(null, "", "/search?q=auth%20bug");
    await mountRoute();
    expect(location.pathname).toBe("/all/search");
    expect(location.search).toBe("?q=auth%20bug");
  });
});

// SYD-55, generalized by SYD-254: the last *concrete* project scope seen on
// any scoped view is remembered, so bare "/" and the Board link from an
// all-scope view return to the project you were working in.
describe("last-project memory", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/all/triage");
    document.body.innerHTML = "";
  });

  it("has no remembered project before any scoped visit", () => {
    expect(getLastProject()).toBeNull();
  });

  it("remembers the project after useRoute observes a board route", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    expect(getLastProject()).toBe("SYD");
  });

  it("remembers the project from any scoped view, not just board", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "agents", scope: "HEX" });
    });
    expect(getLastProject()).toBe("HEX");
  });

  it("keeps the memory when moving to an all-scope view", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", scope: "ACME" });
    });
    await act(async () => {
      navigate({ view: "triage", scope: "all" });
    });
    expect(getLastProject()).toBe("ACME");
  });

  it("updates the memory when switching to a different project", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "board", scope: "SYD" });
    });
    await act(async () => {
      navigate({ view: "board", scope: "ACME" });
    });
    expect(getLastProject()).toBe("ACME");
  });
});

// SYD-75: the ref lives in the URL so reload/back/forward preserve the item
// being reviewed instead of it drifting with the polled list's order.
describe("review navigation history semantics", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/all/triage");
    document.body.innerHTML = "";
  });

  it("navigate pushes a new history entry per ref, so each is its own back-button stop", async () => {
    await mountRoute();
    const before = history.length;
    await act(async () => {
      navigate({ view: "review", scope: "SYD", ref: "SYD-1" });
    });
    expect(location.pathname).toBe("/SYD/review/SYD-1");
    expect(history.length).toBe(before + 1);
    await act(async () => {
      navigate({ view: "review", scope: "SYD", ref: "SYD-2" });
    });
    expect(location.pathname).toBe("/SYD/review/SYD-2");
    expect(history.length).toBe(before + 2);
  });

  it("redirect replaces the current entry instead of pushing a new one", async () => {
    await mountRoute();
    await act(async () => {
      navigate({ view: "review", scope: "SYD", ref: null });
    });
    expect(location.pathname).toBe("/SYD/review");
    const before = history.length;
    await act(async () => {
      redirect({ view: "review", scope: "SYD", ref: "SYD-1" });
    });
    expect(location.pathname).toBe("/SYD/review/SYD-1");
    // Bare /SYD/review never became its own back-button stop.
    expect(history.length).toBe(before);
  });
});

// SYD-86: /:scope/search?q=… is the shareable results route; the query lives
// in the search string, not the path, so parsePath needs both.
describe("search route", () => {
  it("parses a scoped /search with no query as an empty search", () => {
    expect(parsePath("/all/search")).toEqual({ view: "search", scope: "all", query: "" });
  });

  it("round-trips a query through href and parsePath", () => {
    const route = { view: "search" as const, scope: "SYD", query: "SYD-1 & friends" };
    const url = new URL(href(route), "http://localhost");
    expect(parsePath(url.pathname, url.search)).toEqual(route);
  });

  it("is a known path so the anchor interceptor and popstate handling pick it up", () => {
    expect(isKnownPath("/all/search")).toBe(true);
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

// SYD-158, unchanged by SYD-254: settings is global, so it keeps its
// unprefixed path — the one route family with no scope segment.
describe("settings route", () => {
  it("parses /settings to the default projects tab", () => {
    expect(parsePath("/settings")).toEqual({ view: "settings", tab: "projects" });
  });
  it("parses each known tab", () => {
    for (const tab of ["projects", "actors", "integrations", "config"] as const) {
      expect(parsePath(`/settings/${tab}`)).toEqual({ view: "settings", tab });
    }
  });
  it("treats unknown tabs as an unknown path (falls back to the default route)", () => {
    localStorage.clear();
    expect(isKnownPath("/settings/bogus")).toBe(false);
    expect(parsePath("/settings/bogus")).toEqual({ view: "triage", scope: "all" });
  });
  it("round-trips through href", () => {
    expect(href({ view: "settings", tab: "projects" })).toBe("/settings");
    expect(href({ view: "settings", tab: "config" })).toBe("/settings/config");
  });
});
