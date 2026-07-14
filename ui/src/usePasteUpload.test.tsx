// @vitest-environment jsdom
//
// usePasteUpload intercepts pasted files, uploads each in turn, and splices
// the returned markdown into the draft at the textarea's cursor position
// (falling back to appending at the end when no textarea is mounted yet).
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ClipboardEvent } from "react";

vi.mock("./api", () => ({ uploadAttachment: vi.fn() }));
import { uploadAttachment } from "./api";
import { usePasteUpload } from "./usePasteUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type State = ReturnType<typeof usePasteUpload> & { draft: string };

function Harness({ initialDraft, expose }: { initialDraft: string; expose: (s: State) => void }) {
  const [draft, setDraft] = useState(initialDraft);
  const paste = usePasteUpload("SYD-1", setDraft);
  expose({ draft, ...paste });
  return (
    <textarea ref={paste.textareaRef} value={draft} onChange={(e) => setDraft(e.target.value)} />
  );
}

function HarnessNoTextarea({
  initialDraft,
  expose,
}: {
  initialDraft: string;
  expose: (s: State) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const paste = usePasteUpload("SYD-1", setDraft);
  expose({ draft, ...paste });
  return null;
}

function fakePaste(files: File[]): {
  event: ClipboardEvent<HTMLTextAreaElement>;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const event = {
    clipboardData: { files },
    preventDefault,
  } as unknown as ClipboardEvent<HTMLTextAreaElement>;
  return { event, preventDefault };
}

describe("usePasteUpload", () => {
  afterEach(() => {
    vi.mocked(uploadAttachment).mockReset();
  });

  it("ignores a paste with no files", async () => {
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft="hi"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const { event, preventDefault } = fakePaste([]);
    await act(async () => {
      await state!.onPaste(event);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(state!.draft).toBe("hi");
  });

  it("uploads a pasted file and splices its markdown in at the cursor", async () => {
    vi.mocked(uploadAttachment).mockResolvedValueOnce({ id: 1, url: "/a", markdown: "![img](u)" });
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft="hello world"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const textarea = container.querySelector("textarea")!;
    textarea.selectionStart = textarea.selectionEnd = 5; // right after "hello"

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event, preventDefault } = fakePaste([file]);
    await act(async () => {
      await state!.onPaste(event);
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledWith("SYD-1", file);
    expect(state!.draft).toBe("hello ![img](u)  world");
    expect(state!.uploading).toBe(false);
    expect(state!.uploadError).toBeNull();
  });

  it("appends at the end when the textarea ref isn't mounted", async () => {
    vi.mocked(uploadAttachment).mockResolvedValueOnce({ id: 1, url: "/a", markdown: "![img](u)" });
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HarnessNoTextarea
          initialDraft="hello"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event } = fakePaste([file]);
    await act(async () => {
      await state!.onPaste(event);
    });

    expect(state!.draft).toBe("hello ![img](u) ");
  });

  it("uploads multiple pasted files in order, advancing the cursor between them", async () => {
    vi.mocked(uploadAttachment)
      .mockResolvedValueOnce({ id: 1, url: "/a", markdown: "![a](1)" })
      .mockResolvedValueOnce({ id: 2, url: "/b", markdown: "![b](2)" });
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft=""
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const textarea = container.querySelector("textarea")!;
    textarea.selectionStart = textarea.selectionEnd = 0;

    const fileA = new File(["a"], "a.png", { type: "image/png" });
    const fileB = new File(["b"], "b.png", { type: "image/png" });
    const { event } = fakePaste([fileA, fileB]);
    await act(async () => {
      await state!.onPaste(event);
    });

    expect(uploadAttachment).toHaveBeenNthCalledWith(1, "SYD-1", fileA);
    expect(uploadAttachment).toHaveBeenNthCalledWith(2, "SYD-1", fileB);
    expect(state!.draft).toBe("![a](1)  ![b](2) ");
  });

  it("sets uploading while the request is in flight", async () => {
    let resolve: ((v: { id: number; url: string; markdown: string }) => void) | null = null;
    vi.mocked(uploadAttachment).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft=""
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event } = fakePaste([file]);
    let pastePromise!: Promise<void>;
    await act(async () => {
      pastePromise = state!.onPaste(event);
    });
    expect(state!.uploading).toBe(true);

    await act(async () => {
      resolve!({ id: 1, url: "/a", markdown: "![a](1)" });
      await pastePromise;
    });
    expect(state!.uploading).toBe(false);
  });

  it("preserves text typed while the upload is in flight (SYD-195)", async () => {
    let resolve: ((v: { id: number; url: string; markdown: string }) => void) | null = null;
    vi.mocked(uploadAttachment).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft="hello"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const textarea = container.querySelector("textarea")!;

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event } = fakePaste([file]);
    let pastePromise!: Promise<void>;
    await act(async () => {
      pastePromise = state!.onPaste(event);
    });
    expect(state!.uploading).toBe(true);

    // Simulate the user continuing to type while the upload is still pending:
    // this is the exact race the old implementation lost — its stale `next`
    // snapshot from before the await would later overwrite this edit.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "hello there");
      textarea.selectionStart = textarea.selectionEnd = 11; // cursor at the end, after typing
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(state!.draft).toBe("hello there");

    await act(async () => {
      resolve!({ id: 1, url: "/a", markdown: "![a](1)" });
      await pastePromise;
    });

    // The typed suffix must survive, with the markdown spliced in against
    // the latest draft rather than the whole draft being clobbered by the
    // stale pre-upload snapshot.
    expect(state!.draft).toBe("hello there ![a](1) ");
    expect(state!.uploading).toBe(false);
  });

  it("sets uploadError and turns off uploading when the upload rejects, leaving the draft untouched", async () => {
    vi.mocked(uploadAttachment).mockRejectedValueOnce(new Error("upload failed"));
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft="hello"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event } = fakePaste([file]);
    await act(async () => {
      await state!.onPaste(event);
    });

    expect(state!.uploading).toBe(false);
    expect(state!.uploadError).toBe("upload failed");
    expect(state!.draft).toBe("hello");
  });

  it("clears the upload error via setUploadError", async () => {
    vi.mocked(uploadAttachment).mockRejectedValueOnce(new Error("upload failed"));
    let state: State | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness
          initialDraft="hello"
          expose={(s) => {
            state = s;
          }}
        />,
      );
    });

    const file = new File(["x"], "x.png", { type: "image/png" });
    const { event } = fakePaste([file]);
    await act(async () => {
      await state!.onPaste(event);
    });
    expect(state!.uploadError).toBe("upload failed");

    await act(async () => {
      state!.setUploadError(null);
    });
    expect(state!.uploadError).toBeNull();
  });
});
