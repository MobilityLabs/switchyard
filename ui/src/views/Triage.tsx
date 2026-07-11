import { useState } from "react";
import {
  addComment,
  getIssue,
  listActors,
  listIssues,
  markDuplicate,
  snoozeIssue,
  updateIssue,
} from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import { Composer } from "../Composer";
import { ConfirmModal, PromptModal } from "../Modal";
import { href } from "../router";
import { PRIORITIES, type Issue, type IssueDetail, type Priority } from "../types";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";
import { ActivityFeed, DescriptionSection, summaryText } from "./IssueDetail";
import { projectKeyFromRef } from "../refs";
import { safeHref } from "../safeHref";

// Issues routinely leave triage with priority "none" (SYD-65) — default
// accept-to-todo to "medium" unless a human already set something more
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

export default function Triage({ project }: { project: string | null }) {
  const { data, error, reload } = usePoll(
    () => listIssues({ project: project ?? undefined, status: "triage", excludeSnoozed: true }),
    [project],
  );
  const needsInput = usePoll(
    () => listIssues({ project: project ?? undefined, needsInput: true }),
    [project],
  );
  const actors = usePoll(listActors, [], 60000);
  const [actionError, setActionError] = useState<string | null>(null);
  // Single expanded row at a time; clicking the same ref again collapses it.
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const toggleExpanded = (ref: string) => setExpandedRef((cur) => (cur === ref ? null : ref));

  const act = (fn: () => Promise<unknown>) =>
    fn().then(
      () => {
        setActionError(null);
        reload();
        needsInput.reload();
      },
      (e) => setActionError(e.message),
    );

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const actorNames = new Map((actors.data ?? []).map((a) => [a.id, a.name]));
  const actorNameList = (actors.data ?? []).map((a) => a.name);

  return (
    <section className="triage">
      {actionError && (
        <p className="error-bar">
          {actionError} <button onClick={() => setActionError(null)}>×</button>
        </p>
      )}
      <PollErrorBar error={error} />

      {needsInput.data && needsInput.data.length > 0 && (
        <section className="needs-input-lane">
          <h2>
            Waiting on humans <span className="badge warn">{needsInput.data.length}</span>
          </h2>
          {needsInput.data.map((issue) => (
            <a
              key={issue.ref}
              className="needs-input-row"
              href={href({ view: "issue", ref: issue.ref })}
            >
              <span className="ref">{issue.ref}</span>
              <span className="title">{issue.title}</span>
              <span className="hint">has a question — open to answer</span>
              <span className="assignee">
                {actorNames.get(issue.assigneeId ?? -1) ?? "unassigned"}
              </span>
              <span className="age">{age(issue.updatedAt)}</span>
            </a>
          ))}
        </section>
      )}

      <h2>
        Triage inbox <span className="badge">{data.length}</span>
      </h2>
      {data.length === 0 ? (
        <p className="empty">Nothing in triage. The yard is clear.</p>
      ) : (
        data.map((issue) => (
          <TriageRow
            key={issue.ref}
            issue={issue}
            act={act}
            creatorName={actorNames.get(issue.creatorId)}
            knownActorNames={actorNameList}
            expanded={expandedRef === issue.ref}
            onToggleExpand={() => toggleExpanded(issue.ref)}
          />
        ))
      )}
    </section>
  );
}

export function TriageRow({
  issue,
  act,
  creatorName,
  knownActorNames,
  expanded,
  onToggleExpand,
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
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(
    issue.ref,
    draft,
    setDraft,
  );
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);

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
      () => {
        setCommentError(null);
        setDraft("");
        detail.reload();
      },
      (e) => setCommentError(e.message),
    );
  }

  return (
    <article
      className={`triage-row${expanded ? " expanded" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
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
      onKeyDown={(e) => {
        // Same interactive-descendant exclusions as onClick, so Tab-ing to
        // a button/select/link and pressing Enter/Space triggers that
        // control instead of also toggling the row.
        const target = e.target as HTMLElement;
        if (target.closest("button, select, a, textarea, input")) return;
        if (target.closest(".triage-expanded")) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleExpand();
        }
      }}
    >
      <div className="triage-main">
        <a className="ref" href={href({ view: "issue", ref: issue.ref })}>
          {issue.ref}
        </a>
        <span className="title">{issue.title}</span>
        <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
        {issue.labels.length > 0 && (
          <div className="label-chips-ro">
            {issue.labels.map((l) => (
              <span key={l} className="badge label-badge">
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      {!expanded && summaryText(issue) && <div className="triage-desc">{summaryText(issue)}</div>}
      <div className="provenance">
        filed by {creatorName ?? "?"} · {age(issue.createdAt)}
        {issue.sourceType && (
          <>
            {" "}
            · {issue.sourceType} · {issue.sourceDetail ?? ""}
          </>
        )}
        {issue.sourceUrl && (
          <>
            {" "}
            ·{" "}
            <a href={safeHref(issue.sourceUrl)} target="_blank" rel="noreferrer">
              link
            </a>
          </>
        )}
      </div>

      {expanded && (
        <div className="triage-expanded">
          <DescriptionSection
            issue={issue}
            projectKey={projectKey}
            knownActorNames={knownActorNames}
          />

          <h4>Activity</h4>
          <div className="activity triage-activity">
            {detail.data ? (
              <ActivityFeed
                activity={detail.data.activity}
                projectKey={projectKey}
                knownActorNames={knownActorNames}
              />
            ) : (
              <p className="empty">Loading activity…</p>
            )}
          </div>

          {commentError && (
            <p className="error-bar">
              {commentError} <button onClick={() => setCommentError(null)}>×</button>
            </p>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            placeholder="Write a comment… (paste an image or video to attach it)"
            paste={{ onPaste, uploading, uploadError, setUploadError, textareaRef }}
          >
            <button disabled={!draft.trim() || uploading} onClick={postComment}>
              Comment
            </button>
          </Composer>
        </div>
      )}

      <div className="triage-actions">
        <button
          className="primary"
          onClick={() =>
            act(() =>
              updateIssue(issue.ref, {
                status: "todo",
                priority: defaultAcceptPriority(issue.priority),
              }),
            )
          }
        >
          Accept → todo
        </button>
        <button onClick={() => act(() => updateIssue(issue.ref, { status: "backlog" }))}>
          Accept → backlog
        </button>
        <select
          value={issue.priority}
          onChange={(e) =>
            act(() => updateIssue(issue.ref, { priority: e.target.value as Priority }))
          }
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          onClick={() => act(() => snoozeIssue(issue.ref, Math.floor(Date.now() / 1000) + 86400))}
        >
          Snooze 1d
        </button>
        <button
          onClick={() => act(() => snoozeIssue(issue.ref, Math.floor(Date.now() / 1000) + 604800))}
        >
          Snooze 1w
        </button>
        <button onClick={() => setDuplicateOpen(true)}>Duplicate…</button>
        <button className="danger" onClick={() => setDismissOpen(true)}>
          Dismiss
        </button>
      </div>

      {duplicateOpen && (
        <PromptModal
          title={`Mark ${issue.ref} as a duplicate of which ref?`}
          placeholder="SYD-12"
          onCancel={() => setDuplicateOpen(false)}
          onSubmit={(of) => {
            setDuplicateOpen(false);
            act(() => markDuplicate(issue.ref, of));
          }}
        />
      )}
      {dismissOpen && (
        <ConfirmModal
          title={`Dismiss ${issue.ref}?`}
          confirmLabel="Dismiss"
          onCancel={() => setDismissOpen(false)}
          onConfirm={() => {
            setDismissOpen(false);
            act(() => updateIssue(issue.ref, { status: "canceled" }));
          }}
        />
      )}
    </article>
  );
}
