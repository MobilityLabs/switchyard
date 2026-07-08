import { useState } from "react";
import { listActors, listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { PRIORITIES, type Issue, type Priority } from "../types";

function age(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Triage() {
  const { data, error, reload } = usePoll(() => listIssues({ status: "triage" }), []);
  const actors = usePoll(listActors, [], 60000);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const actorNames = new Map((actors.data ?? []).map((a) => [a.id, a.name]));

  return (
    <section className="triage">
      <h2>Triage inbox <span className="badge">{data.length}</span></h2>
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />
      {data.length === 0
        ? <p className="empty">Nothing in triage. The yard is clear.</p>
        : data.map((issue) => (
            <TriageRow key={issue.ref} issue={issue} act={act} creatorName={actorNames.get(issue.creatorId)} />
          ))}
    </section>
  );
}

function TriageRow({
  issue, act, creatorName,
}: { issue: Issue; act: (fn: () => Promise<unknown>) => void; creatorName?: string }) {
  return (
    <article className="triage-row">
      <div className="triage-main">
        <a className="ref" href={`#/issue/${issue.ref}`}>{issue.ref}</a>
        <span className="title">{issue.title}</span>
        <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
      </div>
      {issue.description && <p className="triage-desc">{issue.description}</p>}
      <div className="provenance">
        filed by {creatorName ?? "?"} · {age(issue.createdAt)}
        {issue.sourceType && <> · {issue.sourceType} · {issue.sourceDetail ?? ""}</>}
        {issue.sourceUrl && <> · <a href={issue.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
      </div>
      <div className="triage-actions">
        <button className="primary" onClick={() => act(() => updateIssue(issue.ref, { status: "todo" }))}>
          Accept → todo
        </button>
        <button onClick={() => act(() => updateIssue(issue.ref, { status: "backlog" }))}>
          Accept → backlog
        </button>
        <select
          value={issue.priority}
          onChange={(e) => act(() => updateIssue(issue.ref, { priority: e.target.value as Priority }))}
        >
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          className="danger"
          onClick={() => { if (confirm(`Dismiss ${issue.ref}?`)) act(() => updateIssue(issue.ref, { status: "canceled" })); }}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
