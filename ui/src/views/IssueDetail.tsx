import { useState } from "react";
import { addComment, getIssue, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import { PRIORITIES, STATUSES, type Activity, type Priority, type Status } from "../types";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";

export function projectKeyFromRef(ref: string): string {
  return ref.split("-")[0] ?? "";
}

export default function IssueDetail({ refId }: { refId: string }) {
  const { data, error, reload } = usePoll(() => getIssue(refId), [refId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(refId, draft, setDraft);

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const projectKey = projectKeyFromRef(data.ref);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

  const setLabels = (labels: string[]) => act(() => updateIssue(refId, { labels }));
  const isAuto = data.labels.includes("auto");
  const toggleAuto = () => setLabels(isAuto ? data.labels.filter((l) => l !== "auto") : [...data.labels, "auto"]);
  const removeLabel = (label: string) => setLabels(data.labels.filter((l) => l !== label));
  const addLabel = (raw: string) => {
    const label = raw.trim();
    if (!label || data.labels.includes(label)) return;
    setLabels([...data.labels, label]);
  };
  const otherLabels = data.labels.filter((l) => l !== "auto");

  return (
    <section className="issue">
      <header className="issue-head">
        <span className="ref">{data.ref}</span>
        <h2>{data.title}</h2>
        <select value={data.status} onChange={(e) => act(() => updateIssue(refId, { status: e.target.value as Status }))}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={data.priority} onChange={(e) => act(() => updateIssue(refId, { priority: e.target.value as Priority }))}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          className={`pill auto-pill${isAuto ? " active" : ""}`}
          title="Opt this issue into unattended agent dispatch (label: auto)"
          onClick={toggleAuto}
        >
          🤖 auto
        </button>
      </header>
      <div className="labels-row">
        {otherLabels.map((label) => (
          <span key={label} className="chip label-chip">
            {label}
            <button
              className="chip-remove"
              title={`Remove label "${label}"`}
              onClick={() => removeLabel(label)}
            >
              ×
            </button>
          </span>
        ))}
        <LabelInput onAdd={addLabel} />
      </div>
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />
      {data.sourceType && (
        <div className="provenance panel">
          Filed from: {data.sourceType} · {data.sourceDetail ?? ""}
          {data.sourceUrl && <> · <a href={data.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
        </div>
      )}
      {data.needsInput && (
        <p className="banner warn">⚠ An agent is waiting on a human answer — reply in a comment below.</p>
      )}
      {data.description
        ? <div className="description panel"><Markdown text={data.description} projectKey={projectKey} /></div>
        : <p className="empty">No description.</p>}
      {data.description && <DesignEmbeds text={data.description} />}

      <h3>Activity</h3>
      <div className="activity">
        {data.activity.map((ev, i) => <Event key={i} ev={ev} projectKey={projectKey} />)}
      </div>

      {uploadError && (
        <p className="error-bar">{uploadError} <button onClick={() => setUploadError(null)}>×</button></p>
      )}
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder="Write a comment… (paste an image or video to attach it)"
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
        />
        <button
          className="primary"
          disabled={!draft.trim() || uploading}
          onClick={() => act(() => addComment(refId, draft).then(() => setDraft("")))}
        >
          Send
        </button>
        {uploading && <span className="uploading-note">uploading…</span>}
      </div>
    </section>
  );
}

function LabelInput({ onAdd }: { onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      className="label-input"
      value={value}
      placeholder="+ label"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onAdd(value);
        setValue("");
      }}
    />
  );
}

export function Event({ ev, projectKey }: { ev: Activity; projectKey: string }) {
  const when = new Date(ev.createdAt * 1000).toLocaleString();
  if (ev.type === "comment") {
    return (
      <article className="comment panel">
        <header><strong>{ev.actorName}</strong> <time>{when}</time></header>
        <Markdown text={String(ev.payload.body ?? "")} projectKey={projectKey} />
      </article>
    );
  }
  const fromTo =
    ev.payload.from !== undefined || ev.payload.to !== undefined
      ? ` (${ev.payload.from ?? "…"} → ${ev.payload.to ?? "…"})`
      : "";
  return (
    <p className="event">
      <strong>{ev.actorName}</strong> {ev.type.replace(/_/g, " ")}{fromTo} <time>{when}</time>
    </p>
  );
}
