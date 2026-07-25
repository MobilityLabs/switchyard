// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ActorWithStatus } from "../../types";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listActors: vi.fn(() => Promise.resolve([] as ActorWithStatus[])),
    createActor: vi.fn(),
    rotateActorToken: vi.fn(),
    revokeActorToken: vi.fn(),
    mintLoginLink: vi.fn(),
  };
});

import {
  listActors,
  createActor,
  rotateActorToken,
  revokeActorToken,
  mintLoginLink,
} from "../../api";
import ActorsTab from "./ActorsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTORS: ActorWithStatus[] = [
  { id: 1, name: "sean", type: "human", createdAt: 1751900000, hasToken: false },
  { id: 2, name: "claude/dev", type: "agent", createdAt: 1751900000, hasToken: true },
];

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ActorsTab />);
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
  vi.mocked(listActors).mockReset().mockResolvedValue([]);
  vi.mocked(createActor).mockReset();
  vi.mocked(rotateActorToken).mockReset();
  vi.mocked(revokeActorToken).mockReset();
  vi.mocked(mintLoginLink).mockReset();
  vi.unstubAllGlobals();
});

describe("ActorsTab (SYD-158)", () => {
  it("renders actors with type badge and token status", async () => {
    vi.mocked(listActors).mockResolvedValue(ACTORS);
    const container = await render();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("sean");
    expect(rows[0].textContent).toContain("human");
    expect(rows[0].textContent).toContain("no token");
    expect(rows[1].textContent).toContain("claude/dev");
    expect(rows[1].textContent).toContain("has token");
  });

  it("creates an agent and shows the token exactly once", async () => {
    vi.mocked(createActor).mockResolvedValue({
      actor: { id: 3, name: "claude/new", type: "agent" },
      token: "syd_plaintext_once",
    });
    const container = await render();

    await type(
      container.querySelector<HTMLInputElement>('input[placeholder="claude/worker"]')!,
      "claude/new",
    );
    await click(buttonIn(container, "Create agent"));

    expect(createActor).toHaveBeenCalledWith({ name: "claude/new", type: "agent" });
    expect(container.textContent).toContain("syd_plaintext_once");

    // The token-once callout survives only in local state: a fresh render
    // (refetch) must not know it.
    const container2 = await render();
    expect(container2.textContent).not.toContain("syd_plaintext_once");
  });

  it("rotates a token behind a confirm and shows the new token once", async () => {
    vi.mocked(listActors).mockResolvedValue(ACTORS);
    vi.mocked(rotateActorToken).mockResolvedValue({ token: "syd_rotated_once" });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const container = await render();

    const agentRow = [...container.querySelectorAll("tbody tr")][1];
    await click(buttonIn(agentRow, "Rotate token"));

    expect(rotateActorToken).toHaveBeenCalledWith(2);
    expect(container.textContent).toContain("syd_rotated_once");
  });

  it("does not rotate when the confirm is declined", async () => {
    vi.mocked(listActors).mockResolvedValue(ACTORS);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const container = await render();

    await click(buttonIn([...container.querySelectorAll("tbody tr")][1], "Rotate token"));
    expect(rotateActorToken).not.toHaveBeenCalled();
  });

  it("revokes a token behind a confirm", async () => {
    vi.mocked(listActors).mockResolvedValue(ACTORS);
    vi.mocked(revokeActorToken).mockResolvedValue({ ok: true });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const container = await render();

    await click(buttonIn([...container.querySelectorAll("tbody tr")][1], "Revoke token"));
    expect(revokeActorToken).toHaveBeenCalledWith(2);
  });

  it("mints a login link on human rows only and shows the URL", async () => {
    vi.mocked(listActors).mockResolvedValue(ACTORS);
    vi.mocked(mintLoginLink).mockResolvedValue({ url: "http://x/auth/login/tok" });
    const container = await render();

    const [humanRow, agentRow] = [...container.querySelectorAll("tbody tr")];
    expect([...agentRow.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Mint login link",
    );
    await click(buttonIn(humanRow, "Mint login link"));
    expect(mintLoginLink).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain("http://x/auth/login/tok");
  });
});
