// @vitest-environment jsdom
//
// NewIssue's create flow: pick a project (defaulting to the first loaded
// one), submit creates the issue, then optionally patches labels/startInTodo
// before navigating to the new issue's page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../api", () => ({
  createIssue: vi.fn(),
  listProjects: vi.fn(),
  updateIssue: vi.fn(),
  uploadAttachment: vi.fn(),
}));
vi.mock("../router", () => ({
  navigate: vi.fn(),
  issueRoute: (ref: string) => ({ view: "issue", scope: ref.split("-")[0], ref }),
}));

import { createIssue, listProjects, updateIssue, uploadAttachment } from "../api";
import { navigate } from "../router";
import NewIssue from "./NewIssue";
import type { Issue, Project } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECTS: Project[] = [
  { id: 1, key: "SYD", name: "Switchyard", nextIssueNumber: 1, createdAt: 1751900000 },
  { id: 2, key: "ACME", name: "Acme", nextIssueNumber: 1, createdAt: 1751900000 },
];

function issue(o: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    ref: "SYD-9",
    title: "t",
    description: "",
    summary: null,
    status: "triage",
    priority: "none",
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
    updatedAt: 0,
    attention: null,
    openPr: null,
    ...o,
  };
}

function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function render(defaultProject: string | null = null): Promise<HTMLElement> {
  vi.mocked(listProjects).mockResolvedValue(PROJECTS);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<NewIssue defaultProject={defaultProject} />);
  });
  await act(async () => {}); // flush listProjects()
  return container;
}

async function submitForm(container: HTMLElement): Promise<void> {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("NewIssue", () => {
  afterEach(() => {
    vi.mocked(createIssue).mockReset();
    vi.mocked(listProjects).mockReset();
    vi.mocked(updateIssue).mockReset();
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(navigate).mockReset();
  });

  it("renders project options and defaults to the first loaded project", async () => {
    const container = await render();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("SYD");
    const optionLabels = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toEqual(["SYD — Switchyard", "ACME — Acme"]);
  });

  // SYD-254: /ACME/new pre-selects the URL scope's project.
  it("pre-selects the scoped project over the first-loaded fallback", async () => {
    const container = await render("ACME");
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("ACME");
  });

  it("submits with the scoped project when the user never touches the select", async () => {
    vi.mocked(createIssue).mockResolvedValueOnce(issue({ ref: "ACME-1" }));
    const container = await render("ACME");
    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "Scoped filing");
    });
    await submitForm(container);
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: "ACME", title: "Scoped filing" }),
    );
  });

  it("disables submit until a title is entered", async () => {
    const container = await render();
    const submit = container.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "Fix the thing");
    });
    expect(submit.disabled).toBe(false);
  });

  it("submits the trimmed fields and navigates to the created issue", async () => {
    vi.mocked(createIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    const container = await render();

    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "  Fix the thing  ");
    });
    const description = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setValue(description, "  details  ");
    });

    await submitForm(container);

    expect(createIssue).toHaveBeenCalledWith({
      projectKey: "SYD",
      title: "Fix the thing",
      summary: undefined,
      description: "details",
      priority: "none",
      workerPreference: null,
      parentRef: undefined,
    });
    expect(updateIssue).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ view: "issue", scope: "SYD", ref: "SYD-9" });
  });

  it("patches labels and startInTodo status after creation, then navigates", async () => {
    vi.mocked(createIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    vi.mocked(updateIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    const container = await render();

    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "Fix the thing");
    });
    const labelsInput = container.querySelector(
      "input[placeholder='comma, separated, labels']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(labelsInput, "bug, ui, bug");
    });
    const startInTodo = container.querySelector("input[type=checkbox]") as HTMLInputElement;
    await act(async () => {
      startInTodo.click();
    });

    await submitForm(container);

    expect(updateIssue).toHaveBeenCalledWith("SYD-9", { labels: ["bug", "ui"], status: "todo" });
    expect(navigate).toHaveBeenCalledWith({ view: "issue", scope: "SYD", ref: "SYD-9" });
  });

  it("buffers pasted files, then uploads and replaces their placeholders after creation", async () => {
    vi.mocked(createIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    vi.mocked(uploadAttachment).mockResolvedValueOnce({
      id: 1,
      url: "/attachments/1",
      markdown: "![diagram.png](/attachments/1)",
    });
    vi.mocked(updateIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    const container = await render();
    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setValue(titleInput, "Paste works");
      setValue(textarea, "See");
    });

    const file = new File(["image"], "diagram.png", { type: "image/png" });
    await act(async () => {
      textarea.dispatchEvent(
        Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
          clipboardData: { files: [file] },
        }),
      );
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(textarea.value).toContain("![pending upload: diagram.png]");

    await submitForm(container);

    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("attachment-pending:1") }),
    );
    expect(uploadAttachment).toHaveBeenCalledWith("SYD-9", file);
    expect(updateIssue).toHaveBeenCalledWith("SYD-9", {
      description: "See ![diagram.png](/attachments/1)",
    });
    expect(navigate).toHaveBeenCalledWith({ view: "issue", scope: "SYD", ref: "SYD-9" });
  });

  it("retries a failed deferred upload without creating a duplicate issue", async () => {
    vi.mocked(createIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    vi.mocked(uploadAttachment)
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValueOnce({ id: 1, url: "/a", markdown: "![image](/a)" });
    vi.mocked(updateIssue).mockResolvedValueOnce(issue({ ref: "SYD-9" }));
    const container = await render();
    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setValue(titleInput, "Retry upload");
    });
    const file = new File(["image"], "image.png", { type: "image/png" });
    await act(async () => {
      textarea.dispatchEvent(
        Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
          clipboardData: { files: [file] },
        }),
      );
    });

    await submitForm(container);
    expect(container.textContent).toContain("upload failed");
    expect(navigate).not.toHaveBeenCalled();

    await submitForm(container);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(updateIssue).toHaveBeenCalledWith("SYD-9", { description: "![image](/a)" });
    expect(navigate).toHaveBeenCalledWith({ view: "issue", scope: "SYD", ref: "SYD-9" });
  });

  it("shows the error bar and re-enables the form when createIssue rejects", async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new Error("title already exists"));
    const container = await render();

    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "Fix the thing");
    });

    await submitForm(container);

    expect(container.textContent).toContain("title already exists");
    expect(navigate).not.toHaveBeenCalled();
    const submit = container.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Create issue");
  });

  it("dismisses the error bar when its close button is clicked", async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new Error("boom"));
    const container = await render();
    const titleInput = container.querySelector(
      "input[placeholder='Short summary']",
    ) as HTMLInputElement;
    await act(async () => {
      setValue(titleInput, "Fix the thing");
    });
    await submitForm(container);
    expect(container.textContent).toContain("boom");

    const dismiss = container.querySelector(".error-bar button") as HTMLButtonElement;
    await act(async () => {
      dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".error-bar")).toBeNull();
  });
});
