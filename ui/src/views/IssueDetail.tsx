import { useState } from "react";
import { addComment, getIssue, updateIssue } from "../api";
import { usePoll } from "../usePoll";
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

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const projectKey = projectKeyFromRef(data.ref);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

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
      </header>
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

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Write a comment…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="primary"
          disabled={!draft.trim()}
          onClick={() => act(() => addComment(refId, draft).then(() => setDraft("")))}
        >
          Send
        </button>
      </div>
    </section>
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
