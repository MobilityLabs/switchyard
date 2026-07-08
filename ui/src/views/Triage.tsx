import { useState } from "react";
import { listActors, listIssues, markDuplicate, snoozeIssue, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { PRIORITIES, type Issue, type Priority } from "../types";
import { Markdown } from "../Markdown";
import { projectKeyFromRef } from "./IssueDetail";

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
  const { data, error, reload } = usePoll(() => listIssues({ status: "triage", excludeSnoozed: true }), []);
  const needsInput = usePoll(() => listIssues({ needsInput: true }), []);
  const actors = usePoll(listActors, [], 60000);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); needsInput.reload(); }, (e) => setActionError(e.message));

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const actorNames = new Map((actors.data ?? []).map((a) => [a.id, a.name]));

  return (
    <section className="triage">
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />

      {needsInput.data && needsInput.data.length > 0 && (
        <section className="needs-input-lane">
          <h2>Waiting on humans <span className="badge warn">{needsInput.data.length}</span></h2>
          {needsInput.data.map((issue) => (
            <article key={issue.ref} className="needs-input-row">
              <a className="ref" href={`#/issue/${issue.ref}`}>{issue.ref}</a>
              <span className="title">{issue.title}</span>
              <span className="hint">has a question — open to answer</span>
              <span className="assignee">{actorNames.get(issue.assigneeId ?? -1) ?? "unassigned"}</span>
              <span className="age">{age(issue.updatedAt)}</span>
            </article>
          ))}
        </section>
      )}

      <h2>Triage inbox <span className="badge">{data.length}</span></h2>
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
      {issue.description && (
        <div className="triage-desc">
          <Markdown text={issue.description} projectKey={projectKeyFromRef(issue.ref)} />
        </div>
      )}
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
        <button onClick={() => act(() => snoozeIssue(issue.ref, Math.floor(Date.now() / 1000) + 86400))}>
          Snooze 1d
        </button>
        <button onClick={() => act(() => snoozeIssue(issue.ref, Math.floor(Date.now() / 1000) + 604800))}>
          Snooze 1w
        </button>
        <button
          onClick={() => {
            const of = prompt(`Mark ${issue.ref} as a duplicate of which ref?`);
            if (of) act(() => markDuplicate(issue.ref, of));
          }}
        >
          Duplicate…
        </button>
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
