// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GithubRepoView, Project, WebhookView } from "../../types";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listProjects: vi.fn(() => Promise.resolve([] as Project[])),
    listWebhooks: vi.fn(() => Promise.resolve([] as WebhookView[])),
    addWebhook: vi.fn(),
    setWebhookActive: vi.fn(),
    removeWebhook: vi.fn(),
    listGithubRepos: vi.fn(() => Promise.resolve([] as GithubRepoView[])),
    addGithubRepo: vi.fn(),
    removeGithubRepo: vi.fn(),
  };
});

import {
  listProjects,
  listWebhooks,
  addWebhook,
  setWebhookActive,
  removeWebhook,
  listGithubRepos,
  addGithubRepo,
  removeGithubRepo,
} from "../../api";
import IntegrationsTab from "./IntegrationsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECTS: Project[] = [
  { id: 1, key: "SYD", name: "Switchyard", nextIssueNumber: 9, createdAt: 1751900000 },
];
const WEBHOOKS: WebhookView[] = [
  {
    id: 7,
    url: "https://hooks.example/x",
    projectId: 1,
    active: true,
    createdAt: 1,
    hasSecret: true,
  },
];
const REPOS: GithubRepoView[] = [
  { id: 3, fullName: "acme/widgets", projectId: null, createdAt: 1, hasSecret: false },
];

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<IntegrationsTab />);
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

function buttonIn(scope: Element, label: string): HTMLButtonElement {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

afterEach(() => {
  for (const m of [
    listProjects,
    listWebhooks,
    addWebhook,
    setWebhookActive,
    removeWebhook,
    listGithubRepos,
    addGithubRepo,
    removeGithubRepo,
  ]) {
    vi.mocked(m as ReturnType<typeof vi.fn>).mockReset();
  }
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listWebhooks).mockResolvedValue([]);
  vi.mocked(listGithubRepos).mockResolvedValue([]);
  vi.unstubAllGlobals();
});

describe("IntegrationsTab (SYD-158)", () => {
  it("renders both panels with project scope and secret status, never a secret value", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(listWebhooks).mockResolvedValue(WEBHOOKS);
    vi.mocked(listGithubRepos).mockResolvedValue(REPOS);
    const container = await render();

    expect(container.textContent).toContain("https://hooks.example/x");
    expect(container.textContent).toContain("SYD");
    expect(container.textContent).toContain("signed");
    expect(container.textContent).toContain("acme/widgets");
    expect(container.textContent).toContain("all projects");
  });

  it("adds a webhook with optional project scope and secret", async () => {
    vi.mocked(listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(addWebhook).mockResolvedValue(WEBHOOKS[0]);
    const container = await render();

    await type(
      container.querySelector<HTMLInputElement>('input[placeholder="https://example.com/hook"]')!,
      "https://hooks.example/x",
    );
    await click(buttonIn(container, "Add webhook"));
    expect(addWebhook).toHaveBeenCalledWith({
      url: "https://hooks.example/x",
      projectKey: undefined,
      secret: undefined,
    });
  });

  it("toggles a webhook's active flag", async () => {
    vi.mocked(listWebhooks).mockResolvedValue(WEBHOOKS);
    vi.mocked(setWebhookActive).mockResolvedValue({ ...WEBHOOKS[0], active: false });
    const container = await render();

    await click(buttonIn(container, "Disable"));
    expect(setWebhookActive).toHaveBeenCalledWith(7, false);
  });

  it("deletes a webhook behind a confirm", async () => {
    vi.mocked(listWebhooks).mockResolvedValue(WEBHOOKS);
    vi.mocked(removeWebhook).mockResolvedValue({ ok: true });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const container = await render();

    const webhookRow = [...container.querySelectorAll("tbody tr")][0];
    await click(buttonIn(webhookRow, "Delete"));
    expect(removeWebhook).toHaveBeenCalledWith(7);
  });

  it("adds and deletes a github repo link", async () => {
    vi.mocked(listGithubRepos).mockResolvedValue(REPOS);
    vi.mocked(addGithubRepo).mockResolvedValue(REPOS[0]);
    vi.mocked(removeGithubRepo).mockResolvedValue({ ok: true });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const container = await render();

    await type(
      container.querySelector<HTMLInputElement>('input[placeholder="owner/repo"]')!,
      "acme/widgets",
    );
    await click(buttonIn(container, "Link repo"));
    expect(addGithubRepo).toHaveBeenCalledWith({
      fullName: "acme/widgets",
      projectKey: undefined,
      secret: undefined,
    });

    const repoRows = [...container.querySelectorAll("tbody")].at(-1)!.querySelectorAll("tr");
    await click(buttonIn(repoRows[0], "Delete"));
    expect(removeGithubRepo).toHaveBeenCalledWith(3);
  });
});
