import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { getIssue, listActors } from "./api";
import type { IssueDetail as IssueDetailType } from "./types";

// Delay before a hovered ref triggers the lazy fetch + popover, so a mouse
// merely passing over ref text (not lingering) doesn't fire a network call.
const HOVER_DELAY_MS = 300;

// Session-lifetime cache keyed by ref (SYD-223) — hovering the same ref
// again, even from a different comment, reuses the first fetch rather than
// re-requesting. A failed/unknown ref caches to null so repeat hovers over a
// bad ref don't keep re-fetching either.
const issueCache = new Map<string, Promise<IssueDetailType | null>>();
function fetchIssueCached(ref: string): Promise<IssueDetailType | null> {
  let entry = issueCache.get(ref);
  if (!entry) {
    entry = getIssue(ref).catch(() => null);
    issueCache.set(ref, entry);
  }
  return entry;
}

let actorNamesPromise: Promise<Map<number, string>> | null = null;
function fetchActorNamesCached(): Promise<Map<number, string>> {
  if (!actorNamesPromise) {
    actorNamesPromise = listActors()
      .then((actors) => new Map(actors.map((a) => [a.id, a.name])))
      .catch(() => new Map<number, string>());
  }
  return actorNamesPromise;
}

// Test-only escape hatch — the caches above are session-lifetime by design,
// but per-test isolation needs a way to clear them between cases.
export function resetIssuePopoverCaches(): void {
  issueCache.clear();
  actorNamesPromise = null;
}

export type HoverTarget = { ref: string; rect: DOMRect };

// Delegated hover handling for the `[data-issue-ref]` anchors the Markdown
// autolinker produces — a single listener pair on the rendered-markdown
// container covers every ref in the text, rather than one listener per ref.
export function useIssueRefHover(): {
  hover: HoverTarget | null;
  onMouseOver: (e: MouseEvent) => void;
  onMouseOut: (e: MouseEvent) => void;
} {
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const onMouseOver = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.("[data-issue-ref]") as HTMLElement | null;
    if (!target) return;
    const ref = target.dataset.issueRef;
    if (!ref || hover?.ref === ref) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      setHover({ ref, rect: target.getBoundingClientRect() });
    }, HOVER_DELAY_MS);
  };

  const onMouseOut = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.("[data-issue-ref]") as HTMLElement | null;
    if (!target) return;
    const related = e.relatedTarget as Node | null;
    if (related && target.contains(related)) return;
    clearTimer();
    setHover(null);
  };

  return { hover, onMouseOver, onMouseOut };
}

// At-a-glance card (title/status/priority/assignee) for a hovered issue ref.
// Fetches lazily and degrades to a plain "not found" line for unknown or
// cross-project refs instead of erroring.
export function IssueRefPopover({ refId, rect }: { refId: string; rect: DOMRect }) {
  const [issue, setIssue] = useState<IssueDetailType | "loading" | "error">("loading");
  const [assigneeName, setAssigneeName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIssue("loading");
    setAssigneeName(null);
    fetchIssueCached(refId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setIssue("error");
        return;
      }
      setIssue(result);
      if (result.assigneeId != null) {
        fetchActorNamesCached().then((names) => {
          if (!cancelled) setAssigneeName(names.get(result.assigneeId!) ?? null);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refId]);

  const style: CSSProperties = {
    position: "fixed",
    top: rect.bottom + 6,
    left: rect.left,
  };

  return (
    <div className="ref-popover" style={style} role="tooltip">
      {issue === "loading" && <p className="ref-popover-status">Loading…</p>}
      {issue === "error" && <p className="ref-popover-status">{refId} not found</p>}
      {issue !== "loading" && issue !== "error" && (
        <>
          <p className="ref-popover-title">{issue.title}</p>
          <p className="ref-popover-meta">
            <span className={`badge status-chip status-${issue.status}`}>
              {issue.status.replace(/_/g, " ")}
            </span>
            <span className={`badge prio prio-${issue.priority}`}>{issue.priority}</span>
            <span className="ref-popover-assignee">{assigneeName ?? "unassigned"}</span>
          </p>
        </>
      )}
    </div>
  );
}
