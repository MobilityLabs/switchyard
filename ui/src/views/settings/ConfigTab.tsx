import { useEffect, useRef, useState } from "react";
import { ApiError, listSettings, putSetting, resetSetting } from "../../api";
import type { SettingView } from "../../types";
import { usePoll } from "../../usePoll";
import { PollErrorBar } from "../../PollErrorBar";

const GROUP_LABELS: Record<string, string> = {
  instance: "Instance",
  sessions: "Sessions & claims",
  claims: "Sessions & claims",
  auth: "Auth",
  webhooks: "Webhooks",
  dispatch: "Dispatch",
};

type Kind = "string" | "number" | "string[]";

// GET /api/settings carries values, not editor types — infer from the
// registry default, which is always the canonical shape for its key.
function kindOf(s: SettingView): Kind {
  if (Array.isArray(s.default)) return "string[]";
  if (typeof s.default === "number") return "number";
  return "string";
}

function display(value: unknown, kind: Kind): string {
  if (kind === "string[]") return (value as string[]).join(", ");
  return String(value);
}

/** Parses the editor text back to the setting's real type; null = invalid. */
function parse(text: string, kind: Kind): unknown | null {
  if (kind === "number") {
    const n = Number(text.trim());
    return Number.isFinite(n) && text.trim() !== "" ? n : null;
  }
  if (kind === "string[]") {
    return text
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return text;
}

function SettingField({ setting, onChanged }: { setting: SettingView; onChanged: () => void }) {
  const kind = kindOf(setting);
  const [text, setText] = useState(() => display(setting.value, kind));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Baseline the editor was last synced to — lets the resync effect below
  // tell "user hasn't touched this since the last known value" apart from
  // "user has an unsaved edit", instead of comparing against the new value.
  const syncedTextRef = useRef(text);

  // A poll refresh (or someone else's save) changes the underlying value —
  // resync the editor unless the user is mid-edit of the same value.
  useEffect(() => {
    const next = display(setting.value, kind);
    setText((current) => (current === syncedTextRef.current ? next : current));
    syncedTextRef.current = next;
  }, [setting.value, kind]);

  const parsed = parse(text, kind);
  const dirty = text !== display(setting.value, kind);
  const canSave = dirty && parsed !== null && !saving;

  return (
    <div className="setting-field" data-setting={setting.key}>
      <label>
        <code>{setting.key}</code>
        {setting.isDefault && <span className="badge">default</span>}
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {setting.description && <p className="hint">{setting.description}</p>}
      {kind === "number" && dirty && parsed === null && <p className="hint">Must be a number.</p>}
      {error && <p className="error-bar">{error}</p>}
      <button
        className="primary"
        disabled={!canSave}
        onClick={() => {
          setSaving(true);
          setError(null);
          putSetting(setting.key, parsed).then(
            () => {
              setSaving(false);
              onChanged();
            },
            (e) => {
              setSaving(false);
              setError(e instanceof ApiError ? e.message : String(e));
            },
          );
        }}
      >
        Save
      </button>
      <button
        disabled={setting.isDefault}
        onClick={() => {
          setError(null);
          resetSetting(setting.key).then(
            () => onChanged(),
            (e) => setError(e instanceof ApiError ? e.message : String(e)),
          );
        }}
      >
        Reset
      </button>
    </div>
  );
}

export default function ConfigTab() {
  const settings = usePoll(listSettings, [], 30000);

  const groups = new Map<string, SettingView[]>();
  for (const s of settings.data ?? []) {
    const prefix = s.key.split(".")[0];
    const label = GROUP_LABELS[prefix] ?? prefix;
    groups.set(label, [...(groups.get(label) ?? []), s]);
  }

  return (
    <section>
      <PollErrorBar error={settings.error} />
      {[...groups.entries()].map(([label, entries]) => (
        <section className="panel" key={label}>
          <h3>{label}</h3>
          {entries.map((s) => (
            <SettingField key={s.key} setting={s} onChanged={settings.reload} />
          ))}
        </section>
      ))}
    </section>
  );
}
