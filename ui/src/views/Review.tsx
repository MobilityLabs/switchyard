import { useEffect, useState } from "react";
import { addComment, getIssue, listIssues, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import type { Issue, IssueDetail as IssueDetailType } from "../types";
import { Event, projectKeyFromRef } from "./IssueDetail";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";
import { useActorNames } from "../useActorNames";
import { navigate, redirect } from "../router";
import { countNewArrivals, firstRef, pickAdjacentRef } from "./reviewQueue";

export default function Review({ project, currentRef }: { project: string | null; currentRef: string | null }) {
  const { data, error, reload } = usePoll(
    () => listIssues({ project: project ?? undefined, status: "in_review" }),
    [project],
  );
  const actorNames = useActorNames();

  // The reviewer's working order — a snapshot of refs, distinct from the
  // live-polled `data`. It only catches up to `data` when the reviewer
  // moves (next/prev/approve/send back/jump), so a new arrival or reorder
  // mid-poll never swaps the item on screen out from under them.
  const [queue, setQueue] = useState<Issue[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Switching the project scope invalidates the snapshot so the reviewer
  // starts fresh in the new scope instead of carrying over a queue whose
  // refs may not even belong to the newly selected project. This resets
  // synchronously during render (React's "adjusting state on prop change"
  // pattern) rather than in an effect, so `queue` is already empty by the
  // time the effects below run in this same commit — an effect-based reset
  // would still leave those effects reading the stale, pre-reset queue.
  const [scopeProject, setScopeProject] = useState(project);
  if (project !== scopeProject) {
    setScopeProject(project);
    setQueue([]);
  }

  useEffect(() => {
    if (!data || queue.length !== 0) return;
    // `data` can still be the previous scope's response for a render or two
    // after `project` changes (the poll hasn't caught up yet) — backfilling
    // from it here would repopulate the just-cleared queue with the wrong
    // project's issues. Only accept it once every item actually belongs to
    // the current scope (vacuously true for "All" or an empty response).
    const belongsToScope = project === null || data.every((i) => projectKeyFromRef(i.ref) === project);
    if (belongsToScope) setQueue(data);
  }, [data, queue.length, project]);

  // Bare `/review` or `/review/:project` redirects to the first queued issue.
  useEffect(() => {
    if (currentRef === null && queue.length > 0) redirect({ view: "review", project, ref: firstRef(queue) });
  }, [currentRef, project, queue]);

  const list = data ?? [];
  const current = list.find((i) => i.ref === currentRef) ?? null;
  const leftReview = currentRef !== null && data !== null && !current;
  const newArrivals = data ? countNewArrivals(data, queue) : 0;

  const { onPaste, uploading, uploadError, setUploadError, textareaRef } =
    usePasteUpload(current?.ref ?? "", draft, setDraft);

  const detail = usePoll<IssueDetailType | null>(
    () => (current ? getIssue(current.ref) : Promise.resolve(null)),
    [current?.ref],
  );

  // Every issue switch — prev/next, approve, send back, or a direct
  // /review/:ref navigation — starts the reviewer at the top of the panel
  // rather than wherever the previous issue's scroll position landed
  // (SYD-70). Keyed on currentRef so it covers every path that changes it,
  // including router-driven navigation, without patching each call site.
  useEffect(() => {
    document.querySelector(".content")?.scrollTo(0, 0);
  }, [currentRef]);

  function moveTo(ref: string | null) {
    if (data) setQueue(data);
    setDraft("");
    navigate({ view: "review", project, ref });
  }
  function next() {
    moveTo(pickAdjacentRef(queue, currentRef, 1));
  }
  function prev() {
    moveTo(pickAdjacentRef(queue, currentRef, -1));
  }
  function jumpToNext() {
    moveTo(pickAdjacentRef(queue, currentRef, 1) ?? firstRef(list));
  }
  function approve() {
    if (!current) return;
    const nextRef = pickAdjacentRef(queue, currentRef, 1);
    updateIssue(current.ref, { status: "done" }).then(
      () => { setActionError(null); reload(); moveTo(nextRef); },
      (e) => setActionError(e.message),
    );
  }
  function sendBack() {
    if (!current) return;
    const body = draft.trim();
    if (!body) { setActionError("A comment is required to send an issue back — write what needs to change."); return; }
    const nextRef = pickAdjacentRef(queue, currentRef, 1);
    addComment(current.ref, body)
      .then(() => updateIssue(current.ref, { status: "todo" }))
      .then(
        () => { setActionError(null); reload(); moveTo(nextRef); },
        (e) => setActionError(e.message),
      );
  }

  function postComment() {
    if (!current) return;
    const body = draft.trim();
    if (!body) return;
    addComment(current.ref, body).then(
      () => { setActionError(null); setDraft(""); detail.reload(); },
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
  }, [current, currentRef, draft, queue]);

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  if (!currentRef && list.length === 0) {
    return (
      <section className="review">
        <PollErrorBar error={error} />
        <p className="empty">Review column is clear.</p>
      </section>
    );
  }

  const position = current ? queue.findIndex((i) => i.ref === current.ref) : -1;

  return (
    <section className="review">
      {actionError && (
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      {uploadError && (
        <p className="error-bar">{uploadError} <button onClick={() => setUploadError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />

      <header className="review-head">
        <h2>{position >= 0 ? `Reviewing ${position + 1} of ${queue.length}` : "Reviewing"}</h2>
        <div className="review-nav">
          {newArrivals > 0 && <span className="badge warn review-new-arrivals">{newArrivals} new</span>}
          <button onClick={prev} disabled={!pickAdjacentRef(queue, currentRef, -1)}>‹ Prev</button>
          <button onClick={next} disabled={!pickAdjacentRef(queue, currentRef, 1)}>Next ›</button>
        </div>
      </header>

      {leftReview && (
        <div className="banner warn review-left">
          <p>{currentRef} is no longer in review — someone else may have moved it.</p>
          <button onClick={jumpToNext}>Jump to next</button>
        </div>
      )}

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
            ? (
              <div className="description panel">
                <Markdown
                  text={current.description}
                  projectKey={projectKeyFromRef(current.ref)}
                  knownActorNames={actorNames}
                />
              </div>
            )
            : <p className="empty">No description.</p>}
          {current.description && <DesignEmbeds text={current.description} />}

          <h4>Activity</h4>
          <div className="activity">
            {detail.data
              ? detail.data.activity.map((ev, i) => (
                <Event key={i} ev={ev} projectKey={projectKeyFromRef(current.ref)} knownActorNames={actorNames} />
              ))
              : <p className="empty">Loading activity…</p>}
          </div>

          <div className="composer">
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder="Write a comment… (Comment posts it; required for Send back; paste an image or video to attach it)"
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
            />
            {uploading && <span className="uploading-note">uploading…</span>}
          </div>

          <div className="review-verdicts">
            <button className="primary" disabled={uploading} onClick={approve}>Approve → done <kbd>a</kbd></button>
            <button disabled={uploading} onClick={sendBack}>Send back → todo <kbd>s</kbd></button>
            <button disabled={!draft.trim() || uploading} onClick={postComment}>Comment</button>
          </div>
        </article>
      )}
    </section>
  );
}
