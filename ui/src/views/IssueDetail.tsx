import { useState } from "react";
import {
  addComment,
  addDependency,
  getIssue,
  listAgentSessions,
  redeliverIssue,
  removeDependency,
  updateIssue,
} from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import {
  PRIORITIES,
  STATUSES,
  type Activity,
  type Attachment,
  type DependencyRef,
  type DeployResult,
  type Issue,
  type Priority,
  type Status,
} from "../types";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";
import { useActorNames } from "../useActorNames";
import { formatElapsed } from "./Agents";
import { projectKeyFromRef } from "../refs";
import { Composer } from "../Composer";
import { safeHref } from "../safeHref";

const SUMMARY_FALLBACK_LENGTH = 200;

// Old issues have no summary — fall back to a truncated description so
// collapsed triage rows don't regress to a wall of text.
export function summaryText(issue: { summary: string | null; description: string }): string {
  if (issue.summary) return issue.summary;
  const d = issue.description.trim();
  if (d.length <= SUMMARY_FALLBACK_LENGTH) return d;
  return `${d.slice(0, SUMMARY_FALLBACK_LENGTH).trimEnd()}…`;
}

export function DescriptionSection({
  issue,
  projectKey,
  knownActorNames,
}: {
  issue: { summary: string | null; description: string };
  projectKey: string;
  knownActorNames: readonly string[];
}) {
  if (!issue.description.trim()) return <p className="empty">No description.</p>;
  return (
    <div className="description panel">
      <Markdown
        text={issue.description}
        projectKey={projectKey}
        knownActorNames={knownActorNames}
      />
      <DesignEmbeds text={issue.description} />
    </div>
  );
}

export type DeliveryStatus = {
  prNumber: number | null;
  url: string | null;
  state: "open" | "merged" | "closed";
  mergeSha: string | null;
  deploy: DeployResult | null;
  failedMessage: string | null;
  checks: "passed" | "failed" | null;
};

/**
 * Delivery strip (SYD-54, extended by SYD-64): folds the structured
 * pr_opened/delivered/delivery_failed events deliver.ts and the worker
 * record, plus the gh_pr_opened/gh_pr_merged/gh_pr_closed/gh_checks_*
 * events the GitHub webhook receiver records (src/services/github-webhook.ts),
 * over the activity feed (oldest-first) into the latest known PR + delivery
 * state. A delivery_failed only surfaces if nothing has delivered
 * successfully since it fired — a later delivered/gh_pr_merged event (e.g. a
 * re-stamp after a fix) clears it.
 */
export function computeDeliveryStatus(activity: Activity[]): DeliveryStatus | null {
  let prNumber: number | null = null;
  let url: string | null = null;
  let state: "open" | "merged" | "closed" = "open";
  let mergeSha: string | null = null;
  let deploy: DeployResult | null = null;
  let failedMessage: string | null = null;
  let checks: "passed" | "failed" | null = null;
  let lastDeliveredAt = -Infinity;
  let lastFailedAt = -Infinity;

  for (const ev of activity) {
    if (ev.type === "pr_opened" || ev.type === "gh_pr_opened" || ev.type === "gh_pr_reopened") {
      prNumber = Number(ev.payload.prNumber);
      url = String(ev.payload.url ?? "") || url;
      state = "open";
    } else if (ev.type === "delivered" || ev.type === "gh_pr_merged") {
      prNumber = Number(ev.payload.prNumber);
      url = String(ev.payload.url ?? "") || url;
      mergeSha = String(ev.payload.mergeSha ?? "") || mergeSha;
      deploy = (ev.payload.deploy as DeployResult | undefined) ?? deploy;
      state = "merged";
      lastDeliveredAt = ev.createdAt;
    } else if (ev.type === "gh_pr_closed") {
      prNumber = Number(ev.payload.prNumber);
      url = String(ev.payload.url ?? "") || url;
      state = "closed";
    } else if (ev.type === "delivery_failed") {
      failedMessage = String(ev.payload.message ?? "delivery failed");
      lastFailedAt = ev.createdAt;
    } else if (ev.type === "gh_checks_passed") {
      checks = "passed";
    } else if (ev.type === "gh_checks_failed") {
      checks = "failed";
    }
  }
  if (prNumber === null && failedMessage === null) return null;
  return {
    prNumber,
    url,
    state,
    mergeSha,
    deploy,
    checks,
    failedMessage: lastFailedAt > lastDeliveredAt ? failedMessage : null,
  };
}

export function attachmentUrl(id: number, filename: string): string {
  return `/api/attachments/${id}/${filename}`;
}

/**
 * attachment_added events recorded before SYD-63 have no `id` in their payload
 * (just filename/size), so the activity row has nothing to link to. Backfill
 * those by matching against the issue's attachment list — oldest event to
 * oldest same-named attachment, consuming each match once so two events with
 * the same filename don't both point at one row.
 */
export function withAttachmentIds(activity: Activity[], attachments: Attachment[]): Activity[] {
  const remaining = [...attachments];
  return activity.map((ev) => {
    if (ev.type !== "attachment_added" || ev.payload.id !== undefined) return ev;
    const filename = String(ev.payload.filename ?? "");
    const idx = remaining.findIndex((a) => a.filename === filename);
    if (idx === -1) return ev;
    const [match] = remaining.splice(idx, 1);
    return { ...ev, payload: { ...ev.payload, id: match.id, contentType: match.contentType } };
  });
}

/**
 * Groups consecutive progress_note events (SYD-104) — a chatty session posts
 * 10-20 of them per issue, and rendering each as its own line drowns the
 * actual comments in the feed. Non-progress_note events, and progress_notes
 * separated by another event type, each stay their own single-element group.
 */
export function groupProgressNotes(activity: Activity[]): Activity[][] {
  const groups: Activity[][] = [];
  for (const ev of activity) {
    const current = groups[groups.length - 1];
    if (ev.type === "progress_note" && current?.[0]?.type === "progress_note") {
      current.push(ev);
    } else {
      groups.push([ev]);
    }
  }
  return groups;
}

function ProgressNoteGroup({
  notes,
  projectKey,
  knownActorNames,
}: {
  notes: Activity[];
  projectKey: string;
  knownActorNames: readonly string[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <div className="progress-note-group expanded">
        {notes.map((ev, i) => (
          <Event key={i} ev={ev} projectKey={projectKey} knownActorNames={knownActorNames} />
        ))}
        <button className="link-button" onClick={() => setExpanded(false)}>
          Show less
        </button>
      </div>
    );
  }
  const hiddenCount = notes.length - 1;
  return (
    <div className="progress-note-group">
      <Event
        ev={notes[notes.length - 1]}
        projectKey={projectKey}
        knownActorNames={knownActorNames}
      />
      <button className="link-button" onClick={() => setExpanded(true)}>
        + {hiddenCount} earlier progress note{hiddenCount === 1 ? "" : "s"}
      </button>
    </div>
  );
}

/** Activity feed shared by IssueDetail/Triage/Review — collapses runs of progress_note events. */
export function ActivityFeed({
  activity,
  projectKey,
  knownActorNames = [],
}: {
  activity: Activity[];
  projectKey: string;
  knownActorNames?: readonly string[];
}) {
  return (
    <>
      {groupProgressNotes(activity).map((group, i) =>
        group.length > 1 ? (
          <ProgressNoteGroup
            key={i}
            notes={group}
            projectKey={projectKey}
            knownActorNames={knownActorNames}
          />
        ) : (
          <Event key={i} ev={group[0]} projectKey={projectKey} knownActorNames={knownActorNames} />
        ),
      )}
    </>
  );
}

export function AttentionBanner({
  attention,
  onRetry,
}: {
  attention: Issue["attention"];
  onRetry?: () => void;
}) {
  if (!attention) return null;
  const isError = attention.reason === "delivery_failed";
  return (
    <p className={`banner ${isError ? "danger" : "warn"} issue-attention`}>
      {isError ? "⛔" : "⚠"} {attention.message}
      {isError && onRetry && (
        <button className="retry-delivery" onClick={onRetry}>
          Retry delivery
        </button>
      )}
    </p>
  );
}

function DeliveryStrip({ status }: { status: DeliveryStatus }) {
  return (
    <div className="delivery-strip panel">
      {status.prNumber !== null && (
        <span className="delivery-pr">
          {status.url ? (
            <a href={safeHref(status.url)} target="_blank" rel="noreferrer">
              PR #{status.prNumber}
            </a>
          ) : (
            `PR #${status.prNumber}`
          )}{" "}
          <span className={`badge delivery-state delivery-${status.state}`}>{status.state}</span>
        </span>
      )}
      {status.mergeSha && (
        <span className="delivery-sha">
          merged <code>{status.mergeSha.slice(0, 7)}</code>
        </span>
      )}
      {status.deploy && (
        <span
          className={`badge delivery-deploy delivery-deploy-${status.deploy.ran ? (status.deploy.ok ? "ok" : "failed") : "skipped"}`}
        >
          {status.deploy.ran
            ? status.deploy.ok
              ? "deploy ok"
              : "deploy FAILED"
            : "deploy skipped"}
        </span>
      )}
      {status.checks && (
        <span className={`badge delivery-checks delivery-checks-${status.checks}`}>
          checks {status.checks}
        </span>
      )}
      {status.failedMessage && (
        <p className="banner danger delivery-failed">⛔ delivery failed: {status.failedMessage}</p>
      )}
    </div>
  );
}

/** Live agent-session strip (SYD-43): while the dispatch worker has a session
 * running on this issue, show liveness + the session's latest progress note.
 * Server-side `active` filtering also hides zombie sessions a dead worker
 * never closed out. */
export function AgentSessionStrip({ refId }: { refId: string }) {
  const { data } = usePoll(() => listAgentSessions({ ref: refId, active: true }), [refId]);
  if (!data || data.length === 0) return null;
  return (
    <div className="agent-session-strip panel">
      {data.map((s) => (
        <span key={s.id}>
          🤖 agent session running ({s.mode}) · {formatElapsed(s.startedAt, null)} elapsed
          {s.lastNote && (
            <>
              {" "}
              · <em>{s.lastNote.note}</em>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

export default function IssueDetail({ refId }: { refId: string }) {
  const { data, error, reload } = usePoll(() => getIssue(refId), [refId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(
    refId,
    draft,
    setDraft,
  );
  const actorNames = useActorNames();

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const projectKey = projectKeyFromRef(data.ref);
  const delivery = computeDeliveryStatus(data.activity);
  const activity = withAttachmentIds(data.activity, data.attachments);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(
      () => {
        setActionError(null);
        reload();
      },
      (e) => setActionError(e.message),
    );

  const setLabels = (labels: string[]) => act(() => updateIssue(refId, { labels }));
  const isAuto = data.labels.includes("auto");
  const toggleAuto = () =>
    setLabels(isAuto ? data.labels.filter((l) => l !== "auto") : [...data.labels, "auto"]);
  const removeLabel = (label: string) => setLabels(data.labels.filter((l) => l !== label));
  const addLabel = (raw: string) => {
    const label = raw.trim();
    if (!label || data.labels.includes(label)) return;
    setLabels([...data.labels, label]);
  };
  const otherLabels = data.labels.filter((l) => l !== "auto");

  return (
    <section className="issue">
      <header className="issue-head">
        <span className="ref">{data.ref}</span>
        <h2>{data.title}</h2>
        <select
          value={data.status}
          onChange={(e) => act(() => updateIssue(refId, { status: e.target.value as Status }))}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={data.priority}
          onChange={(e) => act(() => updateIssue(refId, { priority: e.target.value as Priority }))}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          className={`pill auto-pill${isAuto ? " active" : ""}`}
          title="Opt this issue into unattended agent dispatch (label: auto)"
          onClick={toggleAuto}
        >
          🤖 auto
        </button>
      </header>
      <AttentionBanner
        attention={data.attention}
        onRetry={() => act(() => redeliverIssue(refId))}
      />
      <div className="labels-row">
        {otherLabels.map((label) => (
          <span key={label} className="chip label-chip">
            {label}
            <button
              className="chip-remove"
              title={`Remove label "${label}"`}
              onClick={() => removeLabel(label)}
            >
              ×
            </button>
          </span>
        ))}
        <LabelInput onAdd={addLabel} />
      </div>
      {actionError && (
        <p className="error-bar">
          {actionError} <button onClick={() => setActionError(null)}>×</button>
        </p>
      )}
      <PollErrorBar error={error} />
      {delivery && <DeliveryStrip status={delivery} />}
      <AgentSessionStrip refId={refId} />
      {data.sourceType && (
        <div className="provenance panel">
          Filed from: {data.sourceType} · {data.sourceDetail ?? ""}
          {data.sourceUrl && (
            <>
              {" "}
              ·{" "}
              <a href={safeHref(data.sourceUrl)} target="_blank" rel="noreferrer">
                link
              </a>
            </>
          )}
        </div>
      )}
      {data.needsInput && (
        <p className="banner warn">
          ⚠ An agent is waiting on a human answer — reply in a comment below.
        </p>
      )}
      <DescriptionSection issue={data} projectKey={projectKey} knownActorNames={actorNames} />

      <Dependencies refId={refId} deps={data.dependencies} act={act} />

      {data.attachments.length > 0 && <AttachmentsStrip attachments={data.attachments} />}

      <h3>Activity</h3>
      <div className="activity">
        <ActivityFeed activity={activity} projectKey={projectKey} knownActorNames={actorNames} />
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        placeholder="Write a comment… (paste an image or video to attach it, or lead with @agent to ask an agent)"
        paste={{ onPaste, uploading, uploadError, setUploadError, textareaRef }}
      >
        <button
          className="primary"
          disabled={!draft.trim() || uploading}
          onClick={() => act(() => addComment(refId, draft).then(() => setDraft("")))}
        >
          Send
        </button>
      </Composer>
    </section>
  );
}

/** Every attachment on the issue, regardless of whether a comment embeds it —
 * covers orphans (SYD-63), e.g. an agent's attach_file upload nobody linked. */
function AttachmentsStrip({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="attachments-strip panel">
      <h3>Attachments</h3>
      <ul className="attachment-list">
        {attachments.map((a) => {
          const url = attachmentUrl(a.id, a.filename);
          return (
            <li key={a.id}>
              {a.contentType.startsWith("image/") ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt={a.filename} className="attachment-thumb" />
                </a>
              ) : (
                <a href={url} target="_blank" rel="noreferrer">
                  {a.filename}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const OPEN_STATUSES: Status[] = ["triage", "backlog", "todo", "in_progress", "in_review"];

function Dependencies({
  refId,
  deps,
  act,
}: {
  refId: string;
  deps: { blockedBy: DependencyRef[]; blocks: DependencyRef[] };
  act: (fn: () => Promise<unknown>) => void;
}) {
  const [direction, setDirection] = useState<"blocked-by" | "blocks">("blocked-by");
  const [other, setOther] = useState("");
  const openBlockers = deps.blockedBy.filter((d) => OPEN_STATUSES.includes(d.status));

  const add = () => {
    const ref = other.trim().toUpperCase();
    if (!ref) return;
    act(() =>
      (direction === "blocked-by" ? addDependency(ref, refId) : addDependency(refId, ref)).then(
        () => setOther(""),
      ),
    );
  };

  const row = (d: DependencyRef, dir: "blocked-by" | "blocks") => (
    <li key={`${dir}-${d.ref}`}>
      <a className="ref" href={href({ view: "issue", ref: d.ref })}>
        {d.ref}
      </a>{" "}
      {d.title}{" "}
      <span className={`badge dep-status dep-${d.status}`}>{d.status.replace(/_/g, " ")}</span>
      <button
        className="chip-remove"
        title="Remove this dependency"
        onClick={() =>
          act(() =>
            dir === "blocked-by" ? removeDependency(d.ref, refId) : removeDependency(refId, d.ref),
          )
        }
      >
        ×
      </button>
    </li>
  );

  return (
    <div className="dependencies panel">
      <h3>Dependencies</h3>
      {openBlockers.length > 0 && (
        <p className="banner warn">
          ⛔ Blocked — {openBlockers.map((d) => d.ref).join(", ")} must finish first. Agents can&apos;t
          claim this issue.
        </p>
      )}
      {deps.blockedBy.length > 0 && (
        <>
          <h4>Blocked by</h4>
          <ul className="dep-list">{deps.blockedBy.map((d) => row(d, "blocked-by"))}</ul>
        </>
      )}
      {deps.blocks.length > 0 && (
        <>
          <h4>Blocks</h4>
          <ul className="dep-list">{deps.blocks.map((d) => row(d, "blocks"))}</ul>
        </>
      )}
      {deps.blockedBy.length === 0 && deps.blocks.length === 0 && (
        <p className="empty">No dependencies.</p>
      )}
      <div className="dep-add">
        <span>This issue is</span>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as "blocked-by" | "blocks")}
        >
          <option value="blocked-by">blocked by</option>
          <option value="blocks">blocking</option>
        </select>
        <input
          className="label-input"
          value={other}
          placeholder="SYD-12"
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <button disabled={!other.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

function LabelInput({ onAdd }: { onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      className="label-input"
      value={value}
      placeholder="+ label"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onAdd(value);
        setValue("");
      }}
    />
  );
}

export function Event({
  ev,
  projectKey,
  knownActorNames = [],
}: {
  ev: Activity;
  projectKey: string;
  knownActorNames?: readonly string[];
}) {
  const when = new Date(ev.createdAt * 1000).toLocaleString();
  if (ev.type === "comment") {
    return (
      <article className="comment panel">
        <header>
          <strong>{ev.actorName}</strong> <time>{when}</time>
        </header>
        <Markdown
          text={String(ev.payload.body ?? "")}
          projectKey={projectKey}
          knownActorNames={knownActorNames}
        />
      </article>
    );
  }
  if (ev.type === "pr_opened") {
    const url = String(ev.payload.url ?? "");
    return (
      <p className="event">
        <strong>{ev.actorName}</strong> opened{" "}
        {url ? (
          <a href={safeHref(url)} target="_blank" rel="noreferrer">
            PR #{String(ev.payload.prNumber)}
          </a>
        ) : (
          `PR #${String(ev.payload.prNumber)}`
        )}{" "}
        <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "delivered") {
    const sha = String(ev.payload.mergeSha ?? "");
    const deploy = ev.payload.deploy as DeployResult | undefined;
    const deployText = !deploy?.ran
      ? "deploy skipped"
      : deploy.ok
        ? "deploy succeeded"
        : "deploy FAILED";
    return (
      <p className="event">
        <strong>{ev.actorName}</strong> delivered PR #{String(ev.payload.prNumber)} at{" "}
        <code>{sha.slice(0, 7)}</code> · {deployText} <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "delivery_failed") {
    return (
      <p className="event delivery-failed">
        <strong>{ev.actorName}</strong> delivery failed: {String(ev.payload.message ?? "")}{" "}
        <time>{when}</time>
      </p>
    );
  }
  if (
    ev.type === "gh_pr_opened" ||
    ev.type === "gh_pr_merged" ||
    ev.type === "gh_pr_closed" ||
    ev.type === "gh_pr_reopened"
  ) {
    const url = String(ev.payload.url ?? "");
    const verb =
      ev.type === "gh_pr_opened"
        ? "opened"
        : ev.type === "gh_pr_merged"
          ? "merged"
          : ev.type === "gh_pr_reopened"
            ? "reopened"
            : "closed";
    return (
      <p className="event">
        GitHub: {verb}{" "}
        {url ? (
          <a href={safeHref(url)} target="_blank" rel="noreferrer">
            PR #{String(ev.payload.prNumber)}
          </a>
        ) : (
          `PR #${String(ev.payload.prNumber)}`
        )}
        {ev.type === "gh_pr_merged" && ev.payload.mergeSha ? (
          <>
            {" "}
            at <code>{String(ev.payload.mergeSha).slice(0, 7)}</code>
          </>
        ) : null}{" "}
        <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "gh_checks_passed" || ev.type === "gh_checks_failed") {
    return (
      <p className={`event ${ev.type === "gh_checks_failed" ? "delivery-failed" : ""}`}>
        GitHub: checks {ev.type === "gh_checks_passed" ? "passed" : "failed"} <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "gh_pushed") {
    const count = Number(ev.payload.commitCount ?? 0);
    const url = String(ev.payload.url ?? "");
    const sha = String(ev.payload.headSha ?? "");
    const label = `${count} commit${count === 1 ? "" : "s"}`;
    return (
      <p className="event">
        GitHub: pushed{" "}
        {url ? (
          <a href={safeHref(url)} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          label
        )}
        {sha && (
          <>
            {" "}
            (<code>{sha.slice(0, 7)}</code>)
          </>
        )}{" "}
        <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "progress_note") {
    return (
      <p className="event progress-note">
        <strong>{ev.actorName}</strong> ⏱ {String(ev.payload.note ?? "")} <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "attachment_added") {
    const filename = String(ev.payload.filename ?? "");
    const id = ev.payload.id;
    const contentType = String(ev.payload.contentType ?? "");
    if (typeof id !== "number") {
      // No id to link to — pre-SYD-63 event with no matching attachment left
      // to backfill from (e.g. the row was deleted). Don't break the row.
      return (
        <p className="event">
          <strong>{ev.actorName}</strong> attached {filename || "a file"} <time>{when}</time>
        </p>
      );
    }
    const url = attachmentUrl(id, filename);
    return (
      <p className="event attachment-event">
        <strong>{ev.actorName}</strong> attached{" "}
        {contentType.startsWith("image/") ? (
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={filename} className="attachment-thumb" />
          </a>
        ) : (
          <a href={url} target="_blank" rel="noreferrer">
            {filename}
          </a>
        )}{" "}
        <time>{when}</time>
      </p>
    );
  }
  const fromTo =
    ev.payload.from !== undefined || ev.payload.to !== undefined
      ? ` (${ev.payload.from ?? "…"} → ${ev.payload.to ?? "…"})`
      : ev.payload.blocker !== undefined
        ? ` (${ev.payload.blocker})`
        : "";
  return (
    <p className="event">
      <strong>{ev.actorName}</strong> {ev.type.replace(/_/g, " ")}
      {fromTo} <time>{when}</time>
    </p>
  );
}
