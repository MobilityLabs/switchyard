import { useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { uploadAttachment } from "./api";

// Shared paste-to-upload behavior for comment composers (IssueDetail, Review):
// intercept pasted image/video files, upload each, and splice the returned
// markdown snippet into the draft at the cursor position (falling back to
// append when the textarea ref isn't mounted yet).
export function usePasteUpload(ref: string, draft: string, setDraft: (value: string) => void) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    setUploading(true);
    setUploadError(null);
    try {
      let next = draft;
      const el = textareaRef.current;
      let cursor = el ? el.selectionStart ?? next.length : next.length;
      for (const file of files) {
        const { markdown } = await uploadAttachment(ref, file);
        const insert = `${next.slice(0, cursor).trimEnd() ? " " : ""}${markdown} `;
        next = next.slice(0, cursor) + insert + next.slice(cursor);
        cursor += insert.length;
      }
      setDraft(next);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return { onPaste, uploading, uploadError, setUploadError, textareaRef };
}
