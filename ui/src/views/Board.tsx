import { useState } from "react";
import { listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href, navigate } from "../router";
import type { Issue, Status } from "../types";

const BOARD_COLUMNS: Status[] = ["backlog", "todo", "in_progress", "in_review", "done"];
const LABELS: Record<string, string> = {
  backlog: "Backlog", todo: "Todo", in_progress: "In progress",
  in_review: "In review", done: "Done",
};

export default function Board({ project }: { project: string }) {
  const { data, error, reload } = usePoll(() => listIssues({ project }), [project]);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const move = (ref: string, status: Status) =>
    updateIssue(ref, { status }).then(
      () => { setActionError(null); reload(); },
      (e) => setActionError(e.message),
    );

  return (
    <section className="board-view">
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          const cards = data.filter((i) => i.status === col);
          return (
            <div
              key={col}
              className="column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const ref = e.dataTransfer.getData("text/plain");
                if (ref) move(ref, col);
              }}
            >
              <h3>{LABELS[col]} <span className="badge">{cards.length}</span></h3>
              <div className="column-cards">
                {cards.map((issue) => <Card key={issue.ref} issue={issue} onMove={move} />)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Card({ issue, onMove }: { issue: Issue; onMove?: (ref: string, status: Status) => void }) {
  const open = () => navigate({ view: "issue", ref: issue.ref });
  return (
    <article
      className="card"
      draggable
      role="button"
      tabIndex={0}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", issue.ref)}
      onClick={(e) => {
        // Whole card opens the issue; anchors and the move select inside it
        // keep native behavior (the App-level interceptor handles the ref
        // link itself).
        if ((e.target as HTMLElement).closest("a, select")) return;
        open();
      }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("a, select")) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <a className="ref" href={href({ view: "issue", ref: issue.ref })}>{issue.ref}</a>
      <p>{issue.title}</p>
      <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
      {issue.attention && (
        <span className="badge danger" title={issue.attention.message}>⛔ delivery failed</span>
      )}
      {issue.needsInput && <span className="badge warn">⚠ input</span>}
      {issue.labels.length > 0 && (
        <div className="label-chips-ro">
          {issue.labels.map((l) => <span key={l} className="badge label-badge">{l}</span>)}
        </div>
      )}
      {onMove && (
        // Keyboard/AT path for the status move that's otherwise drag-only (SYD-131).
        <select
          className="card-move"
          aria-label={`Move ${issue.ref} to a different status`}
          value={issue.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMove(issue.ref, e.target.value as Status)}
        >
          {BOARD_COLUMNS.map((c) => <option key={c} value={c}>{LABELS[c]}</option>)}
        </select>
      )}
    </article>
  );
}
