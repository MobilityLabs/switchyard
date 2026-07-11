// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./Composer";
import type { usePasteUpload } from "./usePasteUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PasteUpload = ReturnType<typeof usePasteUpload>;

function paste(overrides: Partial<PasteUpload> = {}): PasteUpload {
  return {
    onPaste: vi.fn(() => Promise.resolve()),
    uploading: false,
    uploadError: null,
    setUploadError: vi.fn(),
    textareaRef: { current: null },
    ...overrides,
  };
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

describe("Composer", () => {
  it("renders the textarea with the given value and placeholder", async () => {
    const container = await render(
      <Composer value="draft text" onChange={() => {}} placeholder="Say something" paste={paste()} />
    );
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("draft text");
    expect(textarea.placeholder).toBe("Say something");
  });

  it("calls onChange as the textarea is edited", async () => {
    const onChange = vi.fn();
    const container = await render(
      <Composer value="" onChange={onChange} placeholder="" paste={paste()} />
    );
    const textarea = container.querySelector("textarea")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(textarea, "hello");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("renders children (the submit button) after the textarea", async () => {
    const container = await render(
      <Composer value="" onChange={() => {}} placeholder="" paste={paste()}>
        <button>Send</button>
      </Composer>
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Send");
  });

  it("shows a dismissible upload error bar when uploadError is set", async () => {
    const setUploadError = vi.fn();
    const container = await render(
      <Composer
        value=""
        onChange={() => {}}
        placeholder=""
        paste={paste({ uploadError: "upload failed", setUploadError })}
      />
    );
    expect(container.textContent).toContain("upload failed");
    const dismiss = container.querySelector(".error-bar button") as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(setUploadError).toHaveBeenCalledWith(null);
  });

  it("shows the uploading indicator while an upload is in flight", async () => {
    const container = await render(
      <Composer value="" onChange={() => {}} placeholder="" paste={paste({ uploading: true })} />
    );
    expect(container.querySelector(".uploading-note")).not.toBeNull();
  });

  it("wires the paste handler onto the textarea", async () => {
    const onPaste = vi.fn();
    const container = await render(
      <Composer value="" onChange={() => {}} placeholder="" paste={paste({ onPaste })} />
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new Event("paste", { bubbles: true }));
    });
    expect(onPaste).toHaveBeenCalled();
  });
});
