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
                {cards.map((issue) => <Card key={issue.ref} issue={issue} />)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Card({ issue }: { issue: Issue }) {
  return (
    <article
      className="card"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", issue.ref)}
      onClick={(e) => {
        // Whole card opens the issue; anchors inside keep native behavior
        // (the App-level interceptor handles the ref link itself).
        if ((e.target as HTMLElement).closest("a")) return;
        navigate({ view: "issue", ref: issue.ref });
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
    </article>
  );
}
