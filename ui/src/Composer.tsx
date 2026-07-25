import type { ReactNode } from "react";
import type { useDeferredPasteUpload, usePasteUpload } from "./usePasteUpload";

/** Comment composer shared by IssueDetail/Triage/Review/NewIssue (SYD-132):
 * textarea + paste-upload wiring + its error bar. `children` renders inline
 * after the textarea for view-specific submit button(s) — Review renders none
 * here since its Approve/Send back/Comment buttons live in a separate row. */
export function Composer({
  value,
  onChange,
  placeholder,
  paste,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  paste: ReturnType<typeof usePasteUpload> | ReturnType<typeof useDeferredPasteUpload>;
  children?: ReactNode;
}) {
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = paste;
  return (
    <>
      {uploadError && (
        <p className="error-bar">
          {uploadError} <button onClick={() => setUploadError(null)}>×</button>
        </p>
      )}
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
        />
        {children}
        {uploading && <span className="uploading-note">uploading…</span>}
      </div>
    </>
  );
}
