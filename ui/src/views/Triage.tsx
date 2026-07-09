import { useState } from "react";
import { addComment, getIssue, listActors, listIssues, markDuplicate, snoozeIssue, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import { PRIORITIES, type Issue, type IssueDetail, type Priority } from "../types";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";
import { parseLabels } from "../labels";
import { Event, projectKeyFromRef } from "./IssueDetail";

// Issues routinely leave triage with priority "none" (SYD-65) — default the
// accept-to-todo prompt to "medium" unless a human already set something more
// specific while triaging.
export function defaultAcceptPriority(current: Priority): Priority {
  return current === "none" ? "medium" : current;
}

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
  // Single expanded row at a time; clicking the same ref again collapses it.
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const toggleExpanded = (ref: string) => setExpandedRef((cur) => (cur === ref ? null : ref));

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); needsInput.reload(); }, (e) => setActionError(e.message));

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const actorNames = new Map((actors.data ?? []).map((a) => [a.id, a.name]));
  const actorNameList = (actors.data ?? []).map((a) => a.name);

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
            <a key={issue.ref} className="needs-input-row" href={href({ view: "issue", ref: issue.ref })}>
              <span className="ref">{issue.ref}</span>
              <span className="title">{issue.title}</span>
              <span className="hint">has a question — open to answer</span>
              <span className="assignee">{actorNames.get(issue.assigneeId ?? -1) ?? "unassigned"}</span>
              <span className="age">{age(issue.updatedAt)}</span>
            </a>
          ))}
        </section>
      )}

      <h2>Triage inbox <span className="badge">{data.length}</span></h2>
      {data.length === 0
        ? <p className="empty">Nothing in triage. The yard is clear.</p>
        : data.map((issue) => (
            <TriageRow
              key={issue.ref}
              issue={issue}
              act={act}
              creatorName={actorNames.get(issue.creatorId)}
              knownActorNames={actorNameList}
              expanded={expandedRef === issue.ref}
              onToggleExpand={() => toggleExpanded(issue.ref)}
            />
          ))}
    </section>
  );
}

export function TriageRow({
  issue, act, creatorName, knownActorNames, expanded, onToggleExpand,
}: {
  issue: Issue;
  act: (fn: () => Promise<unknown>) => void;
  creatorName?: string;
  knownActorNames: readonly string[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const projectKey = projectKeyFromRef(issue.ref);
  const [draft, setDraft] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(issue.ref, draft, setDraft);

  // Accept → todo prompt (SYD-65): one extra click gets a sane default
  // (existing priority, or "medium" if unset) without forcing a form.
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [acceptPriority, setAcceptPriority] = useState<Priority>(defaultAcceptPriority(issue.priority));
  const [acceptLabelsInput, setAcceptLabelsInput] = useState(issue.labels.join(", "));

  function openAccept() {
    setAcceptPriority(defaultAcceptPriority(issue.priority));
    setAcceptLabelsInput(issue.labels.join(", "));
    setAcceptOpen(true);
  }

  function confirmAccept() {
    const labels = parseLabels(acceptLabelsInput);
    act(() => updateIssue(issue.ref, { status: "todo", priority: acceptPriority, labels }));
    setAcceptOpen(false);
  }

  // Only fetches while this row is the expanded one; collapsed rows resolve
  // to null immediately, same shape as Review's per-issue detail poll.
  const detail = usePoll<IssueDetail | null>(
    () => (expanded ? getIssue(issue.ref) : Promise.resolve(null)),
    [expanded, issue.ref],
  );

  function postComment() {
    const body = draft.trim();
    if (!body) return;
    addComment(issue.ref, body).then(
      () => { setCommentError(null); setDraft(""); detail.reload(); },
      (e) => setCommentError(e.message),
    );
  }

  return (
    <article
      className={`triage-row${expanded ? " expanded" : ""}`}
      onClick={(e) => {
        // Row toggles expansion, but interactive controls inside it (row
        // actions, the ref/source links, the composer) keep native behavior,
        // and clicks inside the expanded body itself (reading activity,
        // description text) don't collapse it out from under you.
        const target = e.target as HTMLElement;
        if (target.closest("button, select, a, textarea, input")) return;
        if (target.closest(".triage-expanded")) return;
        onToggleExpand();
      }}
    >
      <div className="triage-main">
        <a className="ref" href={href({ view: "issue", ref: issue.ref })}>{issue.ref}</a>
        <span className="title">{issue.title}</span>
        <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
        {issue.labels.length > 0 && (
          <div className="label-chips-ro">
            {issue.labels.map((l) => <span key={l} className="badge label-badge">{l}</span>)}
          </div>
        )}
      </div>
      {issue.description && (
        <div className="triage-desc">
          <Markdown text={issue.description} projectKey={projectKey} knownActorNames={knownActorNames} />
        </div>
      )}
      <div className="provenance">
        filed by {creatorName ?? "?"} · {age(issue.createdAt)}
        {issue.sourceType && <> · {issue.sourceType} · {issue.sourceDetail ?? ""}</>}
        {issue.sourceUrl && <> · <a href={issue.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
      </div>

      {expanded && (
        <div className="triage-expanded">
          {issue.description
            ? (
              <div className="description panel">
                <Markdown text={issue.description} projectKey={projectKey} knownActorNames={knownActorNames} />
              </div>
            )
            : <p className="empty">No description.</p>}
          {issue.description && <DesignEmbeds text={issue.description} />}

          <h4>Activity</h4>
          <div className="activity triage-activity">
            {detail.data
              ? detail.data.activity.map((ev, i) => (
                <Event key={i} ev={ev} projectKey={projectKey} knownActorNames={knownActorNames} />
              ))
              : <p className="empty">Loading activity…</p>}
          </div>

          {commentError && (
            <p className="error-bar">{commentError} <button onClick={() => setCommentError(null)}>×</button></p>
          )}
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
            <button disabled={!draft.trim() || uploading} onClick={postComment}>Comment</button>
            {uploading && <span className="uploading-note">uploading…</span>}
          </div>
        </div>
      )}

      <div className="triage-actions">
        {acceptOpen ? (
          <span className="accept-prompt">
            <select value={acceptPriority} onChange={(e) => setAcceptPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input
              className="accept-labels"
              value={acceptLabelsInput}
              onChange={(e) => setAcceptLabelsInput(e.target.value)}
              placeholder="labels (comma, separated)"
            />
            <button className="primary" onClick={confirmAccept}>Confirm</button>
            <button onClick={() => setAcceptOpen(false)}>Cancel</button>
          </span>
        ) : (
          <button className="primary" onClick={openAccept}>Accept → todo</button>
        )}
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
