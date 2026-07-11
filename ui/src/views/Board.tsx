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

// SYD-171: the done column is where delivery problems surface — bounced
// (delivery_failed) or not-yet-merged (open PR) cards are otherwise
// indistinguishable from cleanly-shipped ones without opening each issue.
type DoneFilter = "errors" | "not_merged";

export default function Board({ project }: { project: string }) {
  const { data, error, reload } = usePoll(() => listIssues({ project }), [project]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doneFilters, setDoneFilters] = useState<Set<DoneFilter>>(new Set());

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const move = (ref: string, status: Status) =>
    updateIssue(ref, { status }).then(
      () => { setActionError(null); reload(); },
      (e) => setActionError(e.message),
    );

  const toggleDoneFilter = (f: DoneFilter) =>
    setDoneFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });

  return (
    <section className="board-view">
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          let cards = data.filter((i) => i.status === col);
          if (col === "done" && doneFilters.size > 0) {
            cards = cards.filter((i) =>
              (doneFilters.has("errors") && i.attention?.reason === "delivery_failed") ||
              (doneFilters.has("not_merged") && i.openPr != null)
            );
          }
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
              <h3>
                {LABELS[col]} <span className="badge">{cards.length}</span>
                {col === "done" && (
                  <span className="done-filters">
                    <button
                      type="button"
                      className={`pill filter-pill filter-danger${doneFilters.has("errors") ? " active" : ""}`}
                      aria-pressed={doneFilters.has("errors")}
                      title="Show only done cards with an unresolved delivery error"
                      onClick={() => toggleDoneFilter("errors")}
                    >
                      ⛔ errors
                    </button>
                    <button
                      type="button"
                      className={`pill filter-pill filter-warn${doneFilters.has("not_merged") ? " active" : ""}`}
                      aria-pressed={doneFilters.has("not_merged")}
                      title="Show only done cards whose PR hasn't merged yet"
                      onClick={() => toggleDoneFilter("not_merged")}
                    >
                      🔀 not merged
                    </button>
                  </span>
                )}
              </h3>
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
