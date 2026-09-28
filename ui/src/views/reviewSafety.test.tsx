// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Actor, IssueDetail as Detail, PrLinkView } from "../types";

vi.mock("../api", () => ({
  addComment: vi.fn(),
  getIssue: vi.fn(),
  listActors: vi.fn(),
  listIssues: vi.fn(),
  listProjects: vi.fn(),
  updateIssue: vi.fn(),
  createIssue: vi.fn(),
  uploadAttachment: vi.fn(),
  listAgentSessions: vi.fn(),
  listGithubRepos: vi.fn(),
  declarePrLink: vi.fn(),
  confirmPrLink: vi.fn(),
  revokePrLink: vi.fn(),
  redeliverIssue: vi.fn(),
  resolveDeliveryFailure: vi.fn(),
  resolveDeviation: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
}));
vi.mock("../router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  navigate: vi.fn(),
  redirect: vi.fn(),
}));
import * as api from "../api";
import { navigate } from "../router";
import IssueDetail from "./IssueDetail";
import Review from "./Review";
import NewIssue from "./NewIssue";
import PrLinks from "../PrLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ME: Actor = { id: 1, name: "sean", type: "human" };

function detail(ref: string): Detail {
  return {
    id: Number(ref.split("-")[1]),
    projectId: 1,
    ref,
    title: `Title ${ref}`,
    description: "",
    summary: null,
    status: "in_review",
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
    deliveryPin: null,
    children: [],
    parentRef: null,
    activity: [],
    dependencies: { blockedBy: [], blocks: [] },
    attachments: [],
    prLinks: [],
  };
}
function link(repo = "org/repo-b"): PrLinkView {
  return {
    id: 1,
    issueId: 1,
    repo,
    prNumber: 42,
    role: "references",
    declaredBy: 2,
    declaredByName: "agent",
    declaredAt: 0,
    confirmedBy: null,
    confirmedByName: null,
    confirmedByHuman: false,
    confirmedAt: null,
    revokedAt: null,
    observed: null,
    provesLanded: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getIssue).mockImplementation(async (ref) => detail(ref));
  vi.mocked(api.listActors).mockResolvedValue([]);
  vi.mocked(api.listAgentSessions).mockResolvedValue([]);
  vi.mocked(api.listGithubRepos).mockResolvedValue([]);
  vi.mocked(api.listIssues).mockResolvedValue([detail("SYD-1"), detail("SYD-2")]);
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 1, key: "SYD", name: "Switchyard", nextIssueNumber: 1, createdAt: 0 },
  ]);
  vi.mocked(api.createIssue).mockResolvedValue(detail("SYD-9"));
  vi.mocked(api.updateIssue).mockResolvedValue(detail("SYD-1"));
  vi.mocked(api.addComment).mockResolvedValue({ ok: true });
  vi.mocked(api.declarePrLink).mockResolvedValue(link());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function find<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error("No value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
async function type(selector: string, value: string) {
  await act(async () => setValue(find<HTMLInputElement | HTMLTextAreaElement>(selector), value));
}
async function submit() {
  await act(async () => {
    find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function paste(...files: File[]) {
  await act(async () => {
    find<HTMLTextAreaElement>("textarea").dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: { files },
      }),
    );
  });
}
async function key(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const review = (ref: string) => <Review project="SYD" currentRef={ref} me={ME} />;

describe("review shortcut safety", () => {
  it.each([
    { key: "a", ctrlKey: true },
    { key: "a", metaKey: true },
    { key: "s", ctrlKey: true },
    { key: "a", altKey: true },
    { key: "a", shiftKey: true },
    { key: "a", repeat: true },
    { key: "a", isComposing: true },
    { key: "ArrowLeft", altKey: true },
  ])("preserves native/modified key handling: %j", async (init) => {
    await render(review("SYD-1"));
    const event = await key(init);
    expect(event.defaultPrevented).toBe(false);
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores select type-ahead and contenteditable descendants", async () => {
    await render(review("SYD-1"));
    const select = document.createElement("select");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    container.append(select, editor);
    await key({ key: "a" }, select);
    await key({ key: "a" }, child);
    expect(api.updateIssue).not.toHaveBeenCalled();
  });

  it("keeps plain approval shortcuts, but submits only once while pending", async () => {
    const pending = deferred<Detail>();
    vi.mocked(api.updateIssue).mockReturnValue(pending.promise);
    await render(review("SYD-1"));
    await key({ key: "a" });
    await key({ key: "a" });
    expect(api.updateIssue).toHaveBeenCalledTimes(1);
    expect(api.updateIssue).toHaveBeenCalledWith("SYD-1", {
      status: "done",
      expectedHeadSha: undefined,
    });
    expect(find<HTMLButtonElement>(".review-verdicts button").disabled).toBe(true);
    await act(async () => pending.resolve(detail("SYD-1")));
    expect(navigate).toHaveBeenCalledWith({ view: "review", scope: "SYD", ref: "SYD-2" });
  });

  it("blocks keyboard verdicts until every concurrent attachment upload finishes", async () => {
    const upload = deferred<{ id: number; url: string; markdown: string }>();
    const second = deferred<{ id: number; url: string; markdown: string }>();
    vi.mocked(api.uploadAttachment)
      .mockReturnValueOnce(upload.promise)
      .mockReturnValueOnce(second.promise);
    await render(review("SYD-1"));
    await paste(new File(["x"], "image.png", { type: "image/png" }));
    await paste(new File(["y"], "second.png", { type: "image/png" }));
    await key({ key: "a" });
    await key({ key: "s" });
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(api.addComment).not.toHaveBeenCalled();
    await act(async () => upload.resolve({ id: 1, url: "/a", markdown: "![image](/a)" }));
    await key({ key: "a" });
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(find<HTMLButtonElement>(".review-verdicts button").disabled).toBe(true);
    await act(async () => second.resolve({ id: 2, url: "/b", markdown: "![second](/b)" }));
    expect(find<HTMLButtonElement>(".review-verdicts button").disabled).toBe(false);
  });
});

describe("issue identity across navigation", () => {
  it("hides previous controls while the next issue loads or fails", async () => {
    const pending = deferred<Detail>();
    vi.mocked(api.getIssue).mockResolvedValueOnce(detail("SYD-1")).mockReturnValue(pending.promise);
    await render(<IssueDetail refId="SYD-1" me={ME} />);
    await render(<IssueDetail refId="SYD-2" me={ME} />);
    expect(container.textContent).toBe("Loading…");
    expect(container.querySelector(".issue-head select")).toBeNull();
    await act(async () => pending.reject(new Error("unavailable")));
    expect(container.textContent).toBe("unavailable");
    expect(container.querySelector(".issue-head")).toBeNull();
    expect(api.updateIssue).not.toHaveBeenCalled();
  });

  it("resets the draft and parent editor after loading another issue", async () => {
    vi.mocked(api.getIssue).mockImplementation(async (ref) => ({
      ...detail(ref),
      parentRef: ref === "SYD-1" ? "SYD-10" : "SYD-20",
    }));
    await render(<IssueDetail refId="SYD-1" me={ME} />);
    await type("textarea", "Feedback for first issue");
    await type(".parent-row input", "SYD-99");
    await render(<IssueDetail refId="SYD-2" me={ME} />);
    expect(find<HTMLTextAreaElement>("textarea").value).toBe("");
    expect(find<HTMLInputElement>(".parent-row input").value).toBe("SYD-20");
    expect(find<HTMLButtonElement>(".composer button").disabled).toBe(true);
  });

  it("does not show old review PR links or draft while new detail is pending", async () => {
    const pending = deferred<Detail>();
    vi.mocked(api.getIssue)
      .mockResolvedValueOnce({ ...detail("SYD-1"), prLinks: [link()] })
      .mockReturnValue(pending.promise);
    await render(review("SYD-1"));
    expect(container.querySelector(".pr-link-row")).not.toBeNull();
    await type("textarea", "First issue's feedback");
    await render(review("SYD-2"));
    expect(find(".issue-head .ref").textContent).toBe("SYD-2");
    expect(container.querySelector(".pr-link-row")).toBeNull();
    expect(find<HTMLTextAreaElement>("textarea").value).toBe("");
    await act(async () => pending.resolve(detail("SYD-2")));
    expect(container.querySelector(".pr-link-row")).toBeNull();
  });

  it("late uploads and approval completion cannot change the next review", async () => {
    const upload = deferred<{ id: number; url: string; markdown: string }>();
    vi.mocked(api.uploadAttachment).mockReturnValue(upload.promise);
    await render(review("SYD-1"));
    await paste(new File(["x"], "image.png", { type: "image/png" }));
    await render(review("SYD-2"));
    await type("textarea", "Second issue's feedback");
    await act(async () => upload.resolve({ id: 1, url: "/a", markdown: "![image](/a)" }));
    expect(find<HTMLTextAreaElement>("textarea").value).toBe("Second issue's feedback");

    const mutation = deferred<Detail>();
    vi.mocked(api.updateIssue).mockReturnValue(mutation.promise);
    await key({ key: "a" });
    await render(review("SYD-1"));
    await act(async () => mutation.resolve(detail("SYD-2")));
    expect(navigate).not.toHaveBeenCalled();
    expect(find(".issue-head .ref").textContent).toBe("SYD-1");
  });
});

describe("partially created issue retries", () => {
  it("retries failed persistence without duplicating the issue/upload, including edited fields", async () => {
    vi.mocked(api.uploadAttachment).mockResolvedValue({
      id: 1,
      url: "/attachments/1",
      markdown: "![image](/attachments/1)",
    });
    vi.mocked(api.updateIssue)
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValue(detail("SYD-9"));
    await render(<NewIssue defaultProject="SYD" />);
    await type('input[placeholder="Short summary"]', "Initial title");
    await paste(new File(["x"], "image.png", { type: "image/png" }));
    await submit();
    expect(container.textContent).toContain("network failed");
    expect(find<HTMLSelectElement>("select").disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    await type('input[placeholder="Short summary"]', "Corrected title");
    await submit();
    expect(api.createIssue).toHaveBeenCalledTimes(1);
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(api.updateIssue).toHaveBeenCalledTimes(2);
    expect(api.updateIssue).toHaveBeenLastCalledWith("SYD-9", {
      title: "Corrected title",
      description: "![image](/attachments/1)",
    });
    expect(navigate).toHaveBeenCalledWith({ view: "issue", scope: "SYD", ref: "SYD-9" });
  });

  it("resumes a partly uploaded batch and persists every resolved placeholder", async () => {
    vi.mocked(api.uploadAttachment)
      .mockResolvedValueOnce({ id: 1, url: "/a", markdown: "![one](/a)" })
      .mockRejectedValueOnce(new Error("second upload failed"))
      .mockResolvedValueOnce({ id: 2, url: "/b", markdown: "![two](/b)" });
    await render(<NewIssue defaultProject="SYD" />);
    await type('input[placeholder="Short summary"]', "Two images");
    const one = new File(["x"], "one.png", { type: "image/png" });
    const two = new File(["y"], "two.png", { type: "image/png" });
    await paste(one, two);
    await submit();
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("second upload failed");
    await submit();
    expect(api.createIssue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.uploadAttachment).mock.calls.map(([, file]) => file)).toEqual([
      one,
      two,
      two,
    ]);
    expect(api.updateIssue).toHaveBeenCalledWith("SYD-9", {
      description: expect.stringMatching(/^!\[one\]\(\/a\)\s+!\[two\]\(\/b\)$/),
    });
  });
});

it("promotes the displayed reference's repository despite another manual selection", async () => {
  vi.mocked(api.listGithubRepos).mockResolvedValue([
    { id: 1, fullName: "org/repo-a", projectId: 1, createdAt: 0, hasSecret: false },
    { id: 2, fullName: "org/repo-b", projectId: 1, createdAt: 0, hasSecret: false },
  ]);
  await render(
    <PrLinks
      refId="SYD-1"
      projectId={1}
      links={[link()]}
      activity={[]}
      me={ME}
      onChanged={() => {}}
    />,
  );
  expect(find<HTMLSelectElement>("select").value).toBe("org/repo-a");
  expect(find(".pr-link-number").textContent).toBe("org/repo-b#42");
  await act(async () => find<HTMLButtonElement>(".pr-link-promote").click());
  expect(api.declarePrLink).toHaveBeenCalledWith("SYD-1", {
    repo: "org/repo-b",
    prNumber: 42,
    role: "delivers",
  });
});
