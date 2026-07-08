import { useEffect, useState } from "react";
import { addComment, getIssue, listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import type { IssueDetail as IssueDetailType } from "../types";
import { Event, projectKeyFromRef } from "./IssueDetail";
import { Markdown } from "../Markdown";

export default function Review() {
  const { data, error, reload } = usePoll(() => listIssues({ status: "in_review" }), []);
  const [index, setIndex] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const list = data ?? [];
  const clampedIndex = list.length ? Math.min(index, list.length - 1) : 0;

  useEffect(() => {
    if (index !== clampedIndex) setIndex(clampedIndex);
  }, [clampedIndex, index]);

  const current = list[clampedIndex];

  const detail = usePoll<IssueDetailType | null>(
    () => (current ? getIssue(current.ref) : Promise.resolve(null)),
    [current?.ref],
  );

  function next() {
    setIndex((i) => (list.length ? Math.min(i + 1, list.length - 1) : 0));
  }
  function prev() {
    setIndex((i) => Math.max(i - 1, 0));
  }
  function approve() {
    if (!current) return;
    updateIssue(current.ref, { status: "done" }).then(
      () => { setActionError(null); reload(); },
      (e) => setActionError(e.message),
    );
  }
  function sendBack() {
    if (!current) return;
    const body = draft.trim();
    if (!body) { setActionError("A comment is required to send an issue back — write what needs to change."); return; }
    addComment(current.ref, body)
      .then(() => updateIssue(current.ref, { status: "todo" }))
      .then(
        () => { setActionError(null); setDraft(""); reload(); },
        (e) => setActionError(e.message),
      );
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "a") { e.preventDefault(); approve(); }
      else if (e.key === "s") { e.preventDefault(); sendBack(); }
      else if (e.key === "j" || e.key === "ArrowRight") { e.preventDefault(); next(); }
      else if (e.key === "k" || e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, draft, list.length]);

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  if (list.length === 0) {
    return (
      <section className="review">
        <PollErrorBar error={error} />
        <p className="empty">Review column is clear.</p>
      </section>
    );
  }

  return (
    <section className="review">
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />

      <header className="review-head">
        <h2>Reviewing {clampedIndex + 1} of {list.length}</h2>
        <div className="review-nav">
          <button onClick={prev} disabled={clampedIndex === 0}>‹ Prev</button>
          <button onClick={next} disabled={clampedIndex === list.length - 1}>Next ›</button>
        </div>
      </header>

      {current && (
        <article className="review-issue panel">
          <div className="issue-head">
            <span className="ref">{current.ref}</span>
            <h3>{current.title}</h3>
            <span className={`badge prio prio-${current.priority}`}>{current.priority}</span>
          </div>

          {current.sourceType && (
            <div className="provenance panel">
              Filed from: {current.sourceType} · {current.sourceDetail ?? ""}
              {current.sourceUrl && <> · <a href={current.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
            </div>
          )}

          {current.description
            ? <div className="description panel"><Markdown text={current.description} projectKey={projectKeyFromRef(current.ref)} /></div>
            : <p className="empty">No description.</p>}

          <h4>Activity</h4>
          <div className="activity">
            {detail.data
              ? detail.data.activity.map((ev, i) => <Event key={i} ev={ev} projectKey={projectKeyFromRef(current.ref)} />)
              : <p className="empty">Loading activity…</p>}
          </div>

          <div className="composer">
            <textarea
              value={draft}
              placeholder="Write a comment… (required to send back)"
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>

          <div className="review-verdicts">
            <button className="primary" onClick={approve}>Approve → done <kbd>a</kbd></button>
            <button onClick={sendBack}>Send back → todo <kbd>s</kbd></button>
          </div>
        </article>
      )}
    </section>
  );
}
