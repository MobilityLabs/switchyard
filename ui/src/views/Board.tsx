import { useState } from "react";
import { listBoard, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href, issueRoute, navigate } from "../router";
import type { BoardCard, BoardStatus, DoneFilter, Status } from "../types";
import { attentionChip } from "../attention";

const BOARD_COLUMNS: BoardStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];
const LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

// SYD-171: the done column is where delivery problems surface — bounced
// (delivery_failed) or not-yet-merged (open PR) cards are otherwise
// indistinguishable from cleanly-shipped ones without opening each issue.
// SYD-175: the actionable view is the DEFAULT (during a queue recovery the
// actionable set was 9 of 150+ cards); the full history sits behind an
// explicit "all" pill, and an explicit choice persists per browser.
// SYD-290: "unlinked" is the third, and the one with a backlog behind it —
// ~46 done issues carry an unresolved done_without_merged_pr and none of them
// had a live PR link, because declaring and confirming were CLI-only. Clearing
// them is per-issue by design (Sean's call: click through them, no bulk
// script), so the filter that finds them is what makes that a queue rather than
// an archaeology exercise.

const DONE_FILTERS_STORAGE_KEY = "switchyard:done-filters";
const DEFAULT_DONE_FILTERS: DoneFilter[] = ["errors", "not_merged"];

function loadDoneFilters(): Set<DoneFilter> {
  try {
    const stored = localStorage.getItem(DONE_FILTERS_STORAGE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (
        Array.isArray(parsed) &&
        parsed.every((value) => ["errors", "not_merged", "unlinked"].includes(value))
      ) {
        return new Set(parsed as DoneFilter[]);
      }
    }
  } catch {
    // Storage disabled or corrupted — fall through to the default.
  }
  return new Set(DEFAULT_DONE_FILTERS);
}

function storeDoneFilters(filters: Set<DoneFilter>): void {
  try {
    localStorage.setItem(DONE_FILTERS_STORAGE_KEY, JSON.stringify([...filters]));
  } catch {
    // Storage disabled — the choice just won't stick.
  }
}

export default function Board({ project }: { project: string }) {
  return <ProjectBoard key={project} project={project} />;
}

function ProjectBoard({ project }: { project: string }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [doneFilters, setDoneFilters] = useState<Set<DoneFilter>>(loadDoneFilters);
  const [pages, setPages] = useState<Partial<Record<BoardStatus, number[]>>>({});
  const before = Object.fromEntries(
    Object.entries(pages).flatMap(([status, cursors]) =>
      cursors.length ? [[status, cursors[cursors.length - 1]]] : [],
    ),
  );
  const filterKey = [...doneFilters].sort().join(",");
  const cursorKey = JSON.stringify(before);
  const requestKey = `${project}:${filterKey}:${cursorKey}`;
  const {
    data: response,
    error,
    reload,
  } = usePoll(
    async () => ({ requestKey, board: await listBoard(project, [...doneFilters], before) }),
    [requestKey],
  );
  // A failed/slow filter or page request must not leave cards from the old
  // selection actionable beneath the new controls.
  const data = response?.board;
  const loading = response?.requestKey !== requestKey;

  if (error && !data)
    return (
      <div>
        <p className="error-bar">{error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!data) return <p>Loading…</p>;

  const move = (ref: string, status: Status) => {
    if (loading) return;
    const issue = Object.values(data.columns)
      .flatMap((page) => page.items)
      .find((i) => i.ref === ref);
    return updateIssue(ref, {
      status,
      expectedHeadSha: status === "done" ? (issue?.openPr?.headSha ?? undefined) : undefined,
    }).then(
      () => {
        setActionError(null);
        reload();
      },
      (e) => setActionError(e.message),
    );
  };

  const toggleDoneFilter = (f: DoneFilter) => {
    setPages((prev) => ({ ...prev, done: [] }));
    setDoneFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      storeDoneFilters(next);
      return next;
    });
  };

  const showAllDone = () => {
    setPages((prev) => ({ ...prev, done: [] }));
    setDoneFilters(() => {
      const next = new Set<DoneFilter>();
      storeDoneFilters(next);
      return next;
    });
  };

  return (
    <section className="board-view">
      {actionError && (
        <p className="error-bar">
          {actionError} <button onClick={() => setActionError(null)}>×</button>
        </p>
      )}
      <PollErrorBar error={error} />
      {loading &&
        (error ? (
          <button type="button" onClick={reload}>
            Retry
          </button>
        ) : (
          <p role="status">Loading cards…</p>
        ))}
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          const page = data.columns[col];
          const cards = loading ? [] : page.items;
          const badgeText =
            col === "done" && page.matching !== page.total
              ? `${page.matching}/${page.total}`
              : String(page.total);
          return (
            <div
              key={col}
              className="column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const ref = e.dataTransfer.getData("text/plain");
                if (ref && !loading) move(ref, col);
              }}
            >
              <h3>
                {LABELS[col]}{" "}
                <span className="badge" title={col === "done" ? "visible / total done" : undefined}>
                  {loading ? "…" : badgeText}
                </span>
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
                    <button
                      type="button"
                      className={`pill filter-pill filter-warn${doneFilters.has("unlinked") ? " active" : ""}`}
                      aria-pressed={doneFilters.has("unlinked")}
                      title="Show only done cards with no merged PR on record — declare or confirm their PR link"
                      onClick={() => toggleDoneFilter("unlinked")}
                    >
                      🔗 unlinked
                    </button>
                    <button
                      type="button"
                      className={`pill filter-pill${doneFilters.size === 0 ? " active" : ""}`}
                      aria-pressed={doneFilters.size === 0}
                      title="Show the full done history"
                      onClick={showAllDone}
                    >
                      all
                    </button>
                  </span>
                )}
              </h3>
              <div className="column-cards">
                {cards.map((issue) => (
                  <Card key={issue.ref} issue={issue} onMove={move} />
                ))}
                {((pages[col]?.length ?? 0) > 0 || page.nextBeforeId !== null) && (
                  <div className="board-pagination" aria-label={`${LABELS[col]} pages`}>
                    <span>
                      {cards.length} shown · {page.matching} matching
                    </span>{" "}
                    <button
                      type="button"
                      disabled={loading || !pages[col]?.length}
                      onClick={() =>
                        setPages((prev) => ({ ...prev, [col]: prev[col]?.slice(0, -1) ?? [] }))
                      }
                    >
                      Newer
                    </button>{" "}
                    <button
                      type="button"
                      disabled={loading || page.nextBeforeId === null}
                      onClick={() => {
                        const next = page.nextBeforeId;
                        if (next !== null)
                          setPages((prev) => {
                            const cursors = prev[col] ?? [];
                            if (cursors[cursors.length - 1] === next) return prev;
                            return { ...prev, [col]: [...cursors, next] };
                          });
                      }}
                    >
                      Older
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Card({
  issue,
  onMove,
}: {
  issue: BoardCard;
  onMove?: (ref: string, status: Status) => void;
}) {
  const open = () => navigate(issueRoute(issue.ref));
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
      <a className="ref" href={href(issueRoute(issue.ref))}>
        {issue.ref}
      </a>
      <p>{issue.title}</p>
      <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
      {issue.attention &&
        (() => {
          const chip = attentionChip(issue.attention);
          return chip ? (
            <span className={chip.className} title={issue.attention.message}>
              {chip.label}
            </span>
          ) : null;
        })()}
      {issue.needsInput && <span className="badge warn">⚠ input</span>}
      {issue.workerPreference === "interactive" ? (
        <span
          className="badge worker-pref interactive"
          title="Interactive session only — not headless-dispatched"
        >
          👤 interactive
        </span>
      ) : (
        issue.workerPreference && (
          <span className="badge worker-pref" title={`Preferred worker: ${issue.workerPreference}`}>
            {issue.workerPreference}
          </span>
        )
      )}
      {!!issue.childCount && (
        <span className="badge epic-badge" title="Child stories under this epic">
          {issue.childCount} {issue.childCount === 1 ? "story" : "stories"}
        </span>
      )}
      {issue.labels.length > 0 && (
        <div className="label-chips-ro">
          {issue.labels.map((l) => (
            <span key={l} className="badge label-badge">
              {l}
            </span>
          ))}
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
          {BOARD_COLUMNS.map((c) => (
            <option key={c} value={c}>
              {LABELS[c]}
            </option>
          ))}
        </select>
      )}
    </article>
  );
}
