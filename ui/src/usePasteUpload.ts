import { useRef, useState } from "react";
import type { ClipboardEvent, Dispatch, SetStateAction } from "react";
import { uploadAttachment } from "./api";

// Shared paste-to-upload behavior for comment composers (IssueDetail, Review):
// intercept pasted image/video files, upload each, and splice the returned
// markdown snippet into the draft at the cursor position (falling back to
// append when the textarea ref isn't mounted yet).
export function usePasteUpload(ref: string, setDraft: Dispatch<SetStateAction<string>>) {
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
      const markdowns: string[] = [];
      for (const file of files) {
        const { markdown } = await uploadAttachment(ref, file);
        markdowns.push(markdown);
      }
      // Apply against the latest draft via a functional update, rather than
      // the `draft` snapshot captured when the paste started — otherwise text
      // typed while the upload was in flight gets clobbered (SYD-195).
      setDraft((prev) => {
        const el = textareaRef.current;
        let cursor = el ? (el.selectionStart ?? prev.length) : prev.length;
        let next = prev;
        for (const markdown of markdowns) {
          const insert = `${next.slice(0, cursor).trimEnd() ? " " : ""}${markdown} `;
          next = next.slice(0, cursor) + insert + next.slice(cursor);
          cursor += insert.length;
        }
        return next;
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return { onPaste, uploading, uploadError, setUploadError, textareaRef };
}
