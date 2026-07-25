import { useCallback, useRef, useState } from "react";
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
    if (!ref) {
      setUploadError(
        "Save the issue before pasting images or videos — attachments need an issue to attach to.",
      );
      return;
    }
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

type DeferredUpload = { token: string; file: File };

// NewIssue cannot upload until createIssue returns a ref. Keep pasted files in
// memory and put stable, human-readable tokens in the draft in the meantime.
export function useDeferredPasteUpload(setDraft: Dispatch<SetStateAction<string>>) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<DeferredUpload[]>([]);
  const nextId = useRef(1);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      setUploadError(null);

      const uploads = files.map((file) => ({
        file,
        token: `![pending upload: ${file.name}](attachment-pending:${nextId.current++})`,
      }));
      pending.current.push(...uploads);
      setDraft((prev) => {
        const el = textareaRef.current;
        let cursor = el ? (el.selectionStart ?? prev.length) : prev.length;
        let next = prev;
        for (const { token } of uploads) {
          const insert = `${next.slice(0, cursor).trimEnd() ? " " : ""}${token} `;
          next = next.slice(0, cursor) + insert + next.slice(cursor);
          cursor += insert.length;
        }
        return next;
      });
    },
    [setDraft],
  );

  const uploadPending = useCallback(
    async (ref: string, draft: string) => {
      setUploading(true);
      setUploadError(null);
      let next = draft;
      try {
        for (const upload of [...pending.current]) {
          // A user may remove a placeholder before submitting; do not create an
          // attachment that is no longer referenced by the description.
          if (!next.includes(upload.token)) {
            pending.current = pending.current.filter((item) => item !== upload);
            continue;
          }
          const { markdown } = await uploadAttachment(ref, upload.file);
          next = next.replace(upload.token, markdown);
          setDraft((prev) => prev.replace(upload.token, markdown));
          pending.current = pending.current.filter((item) => item !== upload);
        }
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setUploadError(message);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [setDraft],
  );

  return { onPaste, uploading, uploadError, setUploadError, textareaRef, uploadPending };
}
