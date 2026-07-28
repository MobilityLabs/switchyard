// @vitest-environment jsdom
//
// SYD-86: the /search results view threads listIssues({text, project, status,
// label}) and renders ref/title/status/project/updatedAt rows that link to
// the issue, per the SYD-62 whole-row-clickable convention.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Search from "./Search";
import type { Issue, Project } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api", () => ({
  listIssues: vi.fn(() => Promise.resolve([])),
  listProjects: vi.fn(() => Promise.resolve([])),
}));

import { listIssues, listProjects } from "../api";

const ISSUE: Issue = {
  id: 1,
  projectId: 1,
  ref: "SYD-42",
  title: "Fix the widget",
  description: "",
  summary: null,
  status: "in_progress",
  priority: "medium",
  assigneeId: null,
  creatorId: 1,
  labels: [],
  sourceType: null,
  sourceDetail: null,
  sourceUrl: null,
  needsInput: false,
  workerPreference: null,
  parentId: null,
  snoozedUntil: null,
  createdAt: 0,
  updatedAt: 1700000000,
  attention: null,
  openPr: null,
};

const PROJECTS: Project[] = [{ key: "SYD", name: "Switchyard" } as Project];

async function renderSearch(query: string, project: string | null = null): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Search query={query} project={project} />);
  });
  await act(async () => {}); // flush the usePoll effect
  return container;
}

describe("Search view", () => {
  beforeEach(() => {
    vi.mocked(listIssues).mockClear();
    vi.mocked(listProjects).mockClear();
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
  });

  it("prompts for a query instead of searching when empty", async () => {
    const container = await renderSearch("");
    expect(container.textContent).toContain("Type a search term.");
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("searches by text and renders a clickable result row", async () => {
    vi.mocked(listIssues).mockResolvedValue([ISSUE]);
    const container = await renderSearch("widget");

    expect(listIssues).toHaveBeenCalledWith(expect.objectContaining({ text: "widget" }));
    const row = container.querySelector(".search-row") as HTMLAnchorElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("href")).toBe("/SYD/issue/SYD-42");
    expect(row.textContent).toContain("SYD-42");
    expect(row.textContent).toContain("Fix the widget");
    expect(row.textContent).toContain("in progress");
  });

  it("shows an empty state when nothing matches", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    const container = await renderSearch("nonexistent");
    expect(container.textContent).toContain('No issues match "nonexistent"');
  });

  it("trims whitespace-only queries down to the empty prompt", async () => {
    const container = await renderSearch("   ");
    expect(container.textContent).toContain("Type a search term.");
    expect(listIssues).not.toHaveBeenCalled();
  });

  // SYD-254: the project filter comes from the URL scope (the topbar scope
  // switcher), not an in-view dropdown that would fight it.
  it("threads the URL scope into listIssues as the project filter", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    await renderSearch("widget", "SYD");
    expect(listIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "widget", project: "SYD" }),
    );
  });

  it("searches all projects when the scope is all", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    await renderSearch("widget", null);
    expect(listIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "widget", project: undefined }),
    );
  });

  it("no longer renders its own project dropdown", async () => {
    vi.mocked(listIssues).mockResolvedValue([]);
    const container = await renderSearch("widget", "SYD");
    const selects = [...container.querySelectorAll<HTMLSelectElement>(".search-filters select")];
    // Only the status select remains; scope lives in the topbar switcher.
    expect(selects).toHaveLength(1);
    expect([...selects[0].options].map((o) => o.textContent)).toContain("Any status");
  });
});
