// @vitest-environment jsdom
//
// PollErrorBar is a dismissible error bar for transient poll failures. It
// resets its dismissed state whenever the error message changes (including
// clearing to null), so a fresh failure is never hidden by a stale dismissal.
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PollErrorBar } from "./PollErrorBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(error: string | null): Promise<{ container: HTMLElement; rerender: (e: string | null) => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<PollErrorBar error={error} />); });
  return {
    container,
    rerender: async (e) => { await act(async () => { root.render(<PollErrorBar error={e} />); }); },
  };
}

describe("PollErrorBar", () => {
  it("renders nothing when there is no error", async () => {
    const { container } = await render(null);
    expect(container.querySelector(".error-bar")).toBeNull();
  });

  it("renders the error message with a dismiss button", async () => {
    const { container } = await render("could not reach server");
    const bar = container.querySelector(".error-bar");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("could not reach server");
    expect(bar?.querySelector("button")).not.toBeNull();
  });

  it("hides the bar once the dismiss button is clicked", async () => {
    const { container } = await render("boom");
    const button = container.querySelector("button")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".error-bar")).toBeNull();
  });

  it("stays dismissed across a re-render with the same error message", async () => {
    const { container, rerender } = await render("boom");
    const button = container.querySelector("button")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".error-bar")).toBeNull();

    await rerender("boom");
    expect(container.querySelector(".error-bar")).toBeNull();
  });

  it("reappears once dismissed but a new, different error arrives", async () => {
    const { container, rerender } = await render("boom");
    const button = container.querySelector("button")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".error-bar")).toBeNull();

    await rerender("a different failure");
    const bar = container.querySelector(".error-bar");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("a different failure");
  });

  it("resets dismissed state when the poll recovers (error clears to null) and fails again later", async () => {
    const { container, rerender } = await render("boom");
    const button = container.querySelector("button")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    await rerender(null);
    expect(container.querySelector(".error-bar")).toBeNull();

    await rerender("boom");
    expect(container.querySelector(".error-bar")).not.toBeNull();
  });
});
