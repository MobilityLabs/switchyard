// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "../../types";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listProjects: vi.fn(() => Promise.resolve([] as Project[])),
    createProject: vi.fn(),
    updateProject: vi.fn(),
  };
});

import { listProjects, createProject, updateProject, ApiError } from "../../api";
import ProjectsTab from "./ProjectsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECTS: Project[] = [
  { id: 1, key: "SYD", name: "Switchyard", nextIssueNumber: 42, createdAt: 1751900000 },
  { id: 2, key: "MOB", name: "Mobility Labs Inc.", nextIssueNumber: 5, createdAt: 1783500000 },
];

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ProjectsTab />);
  });
  return container;
}

async function click(el: Element): Promise<void> {
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

afterEach(() => {
  vi.mocked(listProjects).mockReset().mockResolvedValue([]);
  vi.mocked(createProject).mockReset();
  vi.mocked(updateProject).mockReset();
});

describe("ProjectsTab (SYD-158)", () => {
  it("renders the projects table from polled data", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    const container = await render();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("SYD");
    expect(rows[0].textContent).toContain("Switchyard");
    expect(rows[0].textContent).toContain("42");
  });

  it("renames a project inline via PATCH", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(updateProject).mockResolvedValue({ ...PROJECTS[0], name: "Switchyard (prod)" });
    const container = await render();

    await click(button(container, "Rename"));
    const input = container.querySelector<HTMLInputElement>("tbody input")!;
    expect(input.value).toBe("Switchyard");
    await type(input, "Switchyard (prod)");
    await click(button(container, "Save"));

    expect(updateProject).toHaveBeenCalledWith("SYD", { name: "Switchyard (prod)" });
  });

  it("surfaces a rename failure inline", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(updateProject).mockRejectedValue(new ApiError(400, "Only humans can rename"));
    const container = await render();

    await click(button(container, "Rename"));
    await type(container.querySelector<HTMLInputElement>("tbody input")!, "X");
    await click(button(container, "Save"));

    expect(container.textContent).toContain("Only humans can rename");
  });

  it("creates a project from the form", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: 3,
      key: "ACME",
      name: "Acme",
      nextIssueNumber: 1,
      createdAt: 1783800000,
    });
    const container = await render();

    await type(container.querySelector<HTMLInputElement>('input[placeholder="ACME"]')!, "ACME");
    await type(container.querySelector<HTMLInputElement>('input[placeholder="Acme Corp"]')!, "Acme");
    await click(button(container, "Create project"));

    expect(createProject).toHaveBeenCalledWith({ key: "ACME", name: "Acme" });
  });

  it("blocks invalid keys client-side with the server's own rule", async () => {
    const container = await render();
    await type(container.querySelector<HTMLInputElement>('input[placeholder="ACME"]')!, "A1");
    await type(container.querySelector<HTMLInputElement>('input[placeholder="Acme Corp"]')!, "Acme");
    expect(button(container, "Create project").disabled).toBe(true);
    expect(createProject).not.toHaveBeenCalled();
  });
});
