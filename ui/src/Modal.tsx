import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

/** Native prompt()/confirm() are unstyleable, block the JS thread, and can't
 * be driven from tests (SYD-132) — this overlay replaces both for Triage's
 * Duplicate/Dismiss flows. */
function Overlay({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
    >
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <p className="modal-title">{title}</p>
      <div className="modal-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="danger" onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}

export function PromptModal({
  title,
  placeholder,
  onSubmit,
  onCancel,
}: {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <Overlay onDismiss={onCancel}>
      <p className="modal-title">{title}</p>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="modal-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!value.trim()} onClick={submit}>
          OK
        </button>
      </div>
    </Overlay>
  );
}
