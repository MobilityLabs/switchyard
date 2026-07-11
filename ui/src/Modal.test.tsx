// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmModal, PromptModal } from "./Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

describe("ConfirmModal", () => {
  it("renders the title and confirm label", async () => {
    const container = await render(
      <ConfirmModal title="Dismiss SYD-1?" confirmLabel="Dismiss" onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(container.textContent).toContain("Dismiss SYD-1?");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Dismiss")).toBe(true);
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    const container = await render(
      <ConfirmModal title="Dismiss SYD-1?" confirmLabel="Dismiss" onConfirm={onConfirm} onCancel={() => {}} />
    );
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Dismiss")!;
    await act(async () => confirmButton.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const container = await render(
      <ConfirmModal title="Dismiss SYD-1?" onConfirm={() => {}} onCancel={onCancel} />
    );
    const cancelButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancelButton.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Mirrors how Triage nests the modal inside the row's own onClick (row
  // click toggles expansion) — the backdrop click must not also fire that
  // ancestor handler, or dismissing the modal would toggle the row.
  it("calls onCancel when clicking the backdrop, without bubbling to an ancestor onClick", async () => {
    const onCancel = vi.fn();
    const ancestorClick = vi.fn();
    const container = await render(
      <div onClick={ancestorClick}>
        <ConfirmModal title="Dismiss SYD-1?" onConfirm={() => {}} onCancel={onCancel} />
      </div>
    );
    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(ancestorClick).not.toHaveBeenCalled();
  });

  it("does not dismiss when clicking inside the modal panel itself", async () => {
    const onCancel = vi.fn();
    const container = await render(
      <ConfirmModal title="Dismiss SYD-1?" onConfirm={() => {}} onCancel={onCancel} />
    );
    const panel = container.querySelector(".modal") as HTMLElement;
    await act(async () => {
      panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("PromptModal", () => {
  it("submits the trimmed input value", async () => {
    const onSubmit = vi.fn();
    const container = await render(
      <PromptModal title="Duplicate of?" onSubmit={onSubmit} onCancel={() => {}} />
    );
    const input = container.querySelector("input")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(input, "  SYD-12  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const okButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "OK")!;
    await act(async () => okButton.click());
    expect(onSubmit).toHaveBeenCalledWith("SYD-12");
  });

  it("submits on Enter", async () => {
    const onSubmit = vi.fn();
    const container = await render(
      <PromptModal title="Duplicate of?" onSubmit={onSubmit} onCancel={() => {}} />
    );
    const input = container.querySelector("input")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(input, "SYD-5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("SYD-5");
  });

  it("does not submit an empty or whitespace-only value", async () => {
    const onSubmit = vi.fn();
    const container = await render(
      <PromptModal title="Duplicate of?" onSubmit={onSubmit} onCancel={() => {}} />
    );
    const okButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "OK")! as HTMLButtonElement;
    expect(okButton.disabled).toBe(true);
    await act(async () => okButton.click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape", async () => {
    const onCancel = vi.fn();
    const container = await render(
      <PromptModal title="Duplicate of?" onSubmit={() => {}} onCancel={onCancel} />
    );
    const input = container.querySelector("input")!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
