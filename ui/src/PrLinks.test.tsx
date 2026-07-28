// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("./api", () => ({
  listGithubRepos: vi.fn(() => Promise.resolve([])),
  declarePrLink: vi.fn(() => Promise.resolve({})),
  confirmPrLink: vi.fn(() => Promise.resolve({})),
  revokePrLink: vi.fn(() => Promise.resolve({})),
}));

import { confirmPrLink, declarePrLink, listGithubRepos } from "./api";
import PrLinks, { linkState, prUrl, repoOptions, suggestedPrNumbers } from "./PrLinks";
import type { Activity, Actor, GithubRepoView, PrLinkView } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUMAN: Actor = { id: 1, name: "sean", type: "human" };
const AGENT: Actor = { id: 2, name: "claude/dev", type: "agent" };

function link(o: Partial<PrLinkView> = {}): PrLinkView {
  return {
    id: 1,
    issueId: 1,
    repo: "mobilitylabs/switchyard",
    prNumber: 226,
    role: "delivers",
    declaredBy: 2,
    declaredByName: "claude/dev",
    declaredAt: 1_785_000_000,
    confirmedBy: null,
    confirmedByName: null,
    confirmedByHuman: false,
    confirmedAt: null,
    revokedAt: null,
    observed: { status: "merged", url: null, ghUpdatedAt: 1_785_000_100 },
    provesLanded: false,
    ...o,
  };
}

function ev(type: string, prNumber: number, createdAt = 0): Activity {
  return { type, actorName: "github", viaAgentName: null, payload: { prNumber }, createdAt };
}

async function render(props: {
  links: PrLinkView[];
  me: Actor;
  activity?: Activity[];
}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PrLinks
        refId="SYD-290"
        projectId={1}
        links={props.links}
        activity={props.activity ?? []}
        me={props.me}
        onChanged={() => {}}
      />,
    );
  });
  await act(async () => {}); // flush the listGithubRepos poll
  return container;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.mocked(listGithubRepos).mockResolvedValue([
    { id: 1, fullName: "mobilitylabs/switchyard", projectId: 1, createdAt: 0, hasSecret: true },
  ] as GithubRepoView[]);
  vi.mocked(declarePrLink).mockClear();
  vi.mocked(confirmPrLink).mockClear();
});

describe("linkState — the two halves read as one status", () => {
  // The distinction the whole panel exists for. "Nothing ever observed this
  // PR" is not "this PR did not merge", and only the second is something a
  // human can fix by clicking Confirm.
  it("separates never-observed from merged-but-unproven", () => {
    expect(linkState(link({ observed: null })).label).toBe("⚪ never observed");
    expect(linkState(link({ provesLanded: false })).label).toBe("🔒 merged, unproven");
    expect(linkState(link({ provesLanded: true })).label).toBe("✅ merged");
  });

  it("reports what GitHub last saw for a PR that never merged", () => {
    expect(
      linkState(link({ observed: { status: "open", url: null, ghUpdatedAt: null } })).label,
    ).toBe("🔀 open");
    expect(
      linkState(link({ observed: { status: "closed", url: null, ghUpdatedAt: null } })).label,
    ).toBe("🚫 closed");
  });

  // Three different reasons a merged PR can fail to prove landing, and the
  // human needs to know which one they are looking at.
  it("explains WHY a merged PR is unproven", () => {
    expect(linkState(link({ role: "references" })).title).toMatch(/never proves/i);
    expect(linkState(link({ confirmedBy: null })).title).toMatch(/nobody has confirmed/i);
    expect(linkState(link({ confirmedBy: 3, confirmedByName: "deliver" })).title).toMatch(
      /recency binding/i,
    );
  });
});

describe("suggestedPrNumbers — the 'did you mean?' affordance", () => {
  it("offers PR numbers from the issue's own timeline, newest first", () => {
    const activity = [ev("gh_pr_opened", 100, 1), ev("gh_pr_merged", 226, 2)];
    expect(suggestedPrNumbers(activity, [])).toEqual([226, 100]);
  });

  it("omits PRs already linked, so the form never suggests a no-op", () => {
    const activity = [ev("gh_pr_merged", 226, 1), ev("gh_pr_opened", 100, 2)];
    expect(suggestedPrNumbers(activity, [link({ prNumber: 226 })])).toEqual([100]);
  });

  it("ignores events that name no PR", () => {
    const activity: Activity[] = [
      { type: "comment", actorName: "sean", viaAgentName: null, payload: {}, createdAt: 1 },
      ev("gh_pushed", 5, 2),
    ];
    expect(suggestedPrNumbers(activity, [])).toEqual([]);
  });
});

describe("repoOptions", () => {
  it("keeps repos bound to this project and unscoped ones, drops other projects'", () => {
    const repos = [
      { id: 1, fullName: "a/mine", projectId: 1, createdAt: 0, hasSecret: false },
      { id: 2, fullName: "a/theirs", projectId: 2, createdAt: 0, hasSecret: false },
      { id: 3, fullName: "a/global", projectId: null, createdAt: 0, hasSecret: false },
    ] as GithubRepoView[];
    expect(repoOptions(repos, 1)).toEqual(["a/mine", "a/global"]);
  });
});

describe("prUrl", () => {
  it("prefers the observed URL and falls back to a constructed one", () => {
    expect(
      prUrl(link({ observed: { status: "open", url: "https://gh/x", ghUpdatedAt: null } })),
    ).toBe("https://gh/x");
    expect(prUrl(link({ observed: null }))).toBe(
      "https://github.com/mobilitylabs/switchyard/pull/226",
    );
  });
});

describe("who may act", () => {
  // Hidden, not disabled-and-400: an agent should never be shown the one act
  // the model reserves for a person.
  it("hides Confirm and the declare form from a non-human", async () => {
    const root = await render({ links: [link()], me: AGENT });
    expect(buttonByText(root, "Confirm")).toBeUndefined();
    expect(root.querySelector(".pr-link-declare")).toBeNull();
  });

  it("offers Confirm to a human on an unconfirmed delivers link", async () => {
    const root = await render({ links: [link()], me: HUMAN });
    const button = buttonByText(root, "Confirm");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(confirmPrLink).toHaveBeenCalledWith("SYD-290", {
      repo: "mobilitylabs/switchyard",
      prNumber: 226,
    });
  });

  it("offers no Confirm once the link is confirmed", async () => {
    const root = await render({
      links: [link({ confirmedBy: 1, confirmedByName: "sean", confirmedByHuman: true })],
      me: HUMAN,
    });
    expect(buttonByText(root, "Confirm")).toBeUndefined();
  });

  // confirmPrLink refuses a `references` link server-side (confirming a
  // suggestion would prove nothing), so the panel must offer the verb that
  // works — declaring, which supersedes the suggestion and confirms in one go.
  it("offers promotion, not Confirm, on a references suggestion", async () => {
    const root = await render({ links: [link({ role: "references" })], me: HUMAN });
    expect(buttonByText(root, "Confirm")).toBeUndefined();
    const promote = buttonByText(root, "This one carries the work");
    expect(promote).toBeDefined();
    await act(async () => promote!.click());
    expect(declarePrLink).toHaveBeenCalledWith("SYD-290", {
      repo: "mobilitylabs/switchyard",
      prNumber: 226,
      role: "delivers",
    });
  });
});

describe("what the panel says when it cannot help", () => {
  // The trap: declaring and confirming a link to a PR nothing ever observed is
  // a valid statement that leaves done_without_merged_pr lit. Saying so here is
  // what stops the panel contradicting the banner beside it.
  it("warns that an unobserved PR can't prove landing however it is confirmed", async () => {
    const root = await render({
      links: [link({ observed: null, confirmedBy: 1, confirmedByName: "sean" })],
      me: HUMAN,
    });
    const note = root.querySelector(".pr-link-note");
    expect(note?.textContent).toMatch(/can't prove the work landed/i);
    expect(note?.textContent).toMatch(/Mark resolved/i);
  });

  it("says nothing is declared rather than showing an empty list", async () => {
    const root = await render({ links: [], me: HUMAN });
    expect(root.querySelector(".empty")?.textContent).toMatch(/No PR is declared/i);
  });

  it("refuses to declare when no repo is bound, instead of posting a bad request", async () => {
    vi.mocked(listGithubRepos).mockResolvedValue([]);
    const root = await render({ links: [], me: HUMAN });
    const input = root.querySelector(".pr-link-input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText(root, "Declare")!.click());
    expect(declarePrLink).not.toHaveBeenCalled();
    expect(root.querySelector(".error-bar")?.textContent).toMatch(/No GitHub repo is bound/i);
  });
});
