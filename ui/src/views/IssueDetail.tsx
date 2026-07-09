import { useState } from "react";
import { addComment, addDependency, getIssue, removeDependency, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import { PRIORITIES, STATUSES, type Activity, type DependencyRef, type DeployResult, type Priority, type Status } from "../types";
import { Markdown } from "../Markdown";
import { DesignEmbeds } from "../DesignEmbeds";
import { useActorNames } from "../useActorNames";

export function projectKeyFromRef(ref: string): string {
  return ref.split("-")[0] ?? "";
}

export type DeliveryStatus = {
  prNumber: number | null;
  url: string | null;
  state: "open" | "merged";
  mergeSha: string | null;
  deploy: DeployResult | null;
  failedMessage: string | null;
};

/**
 * Delivery strip (SYD-54): folds the structured pr_opened/delivered/
 * delivery_failed events deliver.ts and the worker record (over the activity
 * feed, oldest-first) into the latest known PR + delivery state. A
 * delivery_failed only surfaces if nothing has delivered successfully since
 * it fired — a later delivered event (e.g. a re-stamp after a fix) clears it.
 */
export function computeDeliveryStatus(activity: Activity[]): DeliveryStatus | null {
  let prNumber: number | null = null;
  let url: string | null = null;
  let state: "open" | "merged" = "open";
  let mergeSha: string | null = null;
  let deploy: DeployResult | null = null;
  let failedMessage: string | null = null;
  let lastDeliveredAt = -Infinity;
  let lastFailedAt = -Infinity;

  for (const ev of activity) {
    if (ev.type === "pr_opened") {
      prNumber = Number(ev.payload.prNumber);
      url = String(ev.payload.url ?? "") || null;
      state = "open";
    } else if (ev.type === "delivered") {
      prNumber = Number(ev.payload.prNumber);
      mergeSha = String(ev.payload.mergeSha ?? "") || null;
      deploy = (ev.payload.deploy as DeployResult | undefined) ?? null;
      state = "merged";
      lastDeliveredAt = ev.createdAt;
    } else if (ev.type === "delivery_failed") {
      failedMessage = String(ev.payload.message ?? "delivery failed");
      lastFailedAt = ev.createdAt;
    }
  }
  if (prNumber === null && failedMessage === null) return null;
  return {
    prNumber, url, state, mergeSha, deploy,
    failedMessage: lastFailedAt > lastDeliveredAt ? failedMessage : null,
  };
}

function DeliveryStrip({ status }: { status: DeliveryStatus }) {
  return (
    <div className="delivery-strip panel">
      {status.prNumber !== null && (
        <span className="delivery-pr">
          {status.url
            ? <a href={status.url} target="_blank" rel="noreferrer">PR #{status.prNumber}</a>
            : `PR #${status.prNumber}`}
          {" "}
          <span className={`badge delivery-state delivery-${status.state}`}>{status.state}</span>
        </span>
      )}
      {status.mergeSha && (
        <span className="delivery-sha">merged <code>{status.mergeSha.slice(0, 7)}</code></span>
      )}
      {status.deploy && (
        <span className={`badge delivery-deploy delivery-deploy-${status.deploy.ran ? (status.deploy.ok ? "ok" : "failed") : "skipped"}`}>
          {status.deploy.ran ? (status.deploy.ok ? "deploy ok" : "deploy FAILED") : "deploy skipped"}
        </span>
      )}
      {status.failedMessage && (
        <p className="banner warn delivery-failed">⚠ delivery failed: {status.failedMessage}</p>
      )}
    </div>
  );
}

export default function IssueDetail({ refId }: { refId: string }) {
  const { data, error, reload } = usePoll(() => getIssue(refId), [refId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(refId, draft, setDraft);
  const actorNames = useActorNames();

  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const projectKey = projectKeyFromRef(data.ref);
  const delivery = computeDeliveryStatus(data.activity);

  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => { setActionError(null); reload(); }, (e) => setActionError(e.message));

  const setLabels = (labels: string[]) => act(() => updateIssue(refId, { labels }));
  const isAuto = data.labels.includes("auto");
  const toggleAuto = () => setLabels(isAuto ? data.labels.filter((l) => l !== "auto") : [...data.labels, "auto"]);
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
        <select value={data.status} onChange={(e) => act(() => updateIssue(refId, { status: e.target.value as Status }))}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={data.priority} onChange={(e) => act(() => updateIssue(refId, { priority: e.target.value as Priority }))}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          className={`pill auto-pill${isAuto ? " active" : ""}`}
          title="Opt this issue into unattended agent dispatch (label: auto)"
          onClick={toggleAuto}
        >
          🤖 auto
        </button>
      </header>
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
        <p className="error-bar">{actionError} <button onClick={() => setActionError(null)}>×</button></p>
      )}
      <PollErrorBar error={error} />
      {delivery && <DeliveryStrip status={delivery} />}
      {data.sourceType && (
        <div className="provenance panel">
          Filed from: {data.sourceType} · {data.sourceDetail ?? ""}
          {data.sourceUrl && <> · <a href={data.sourceUrl} target="_blank" rel="noreferrer">link</a></>}
        </div>
      )}
      {data.needsInput && (
        <p className="banner warn">⚠ An agent is waiting on a human answer — reply in a comment below.</p>
      )}
      {data.description
        ? (
          <div className="description panel">
            <Markdown text={data.description} projectKey={projectKey} knownActorNames={actorNames} />
          </div>
        )
        : <p className="empty">No description.</p>}
      {data.description && <DesignEmbeds text={data.description} />}

      <Dependencies refId={refId} deps={data.dependencies} act={act} />

      <h3>Activity</h3>
      <div className="activity">
        {data.activity.map((ev, i) => <Event key={i} ev={ev} projectKey={projectKey} knownActorNames={actorNames} />)}
      </div>

      {uploadError && (
        <p className="error-bar">{uploadError} <button onClick={() => setUploadError(null)}>×</button></p>
      )}
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder="Write a comment… (paste an image or video to attach it, or lead with @agent to ask an agent)"
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
        />
        <button
          className="primary"
          disabled={!draft.trim() || uploading}
          onClick={() => act(() => addComment(refId, draft).then(() => setDraft("")))}
        >
          Send
        </button>
        {uploading && <span className="uploading-note">uploading…</span>}
      </div>
    </section>
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
      (direction === "blocked-by" ? addDependency(ref, refId) : addDependency(refId, ref))
        .then(() => setOther("")),
    );
  };

  const row = (d: DependencyRef, dir: "blocked-by" | "blocks") => (
    <li key={`${dir}-${d.ref}`}>
      <a className="ref" href={href({ view: "issue", ref: d.ref })}>{d.ref}</a>{" "}
      {d.title} <span className={`badge dep-status dep-${d.status}`}>{d.status.replace(/_/g, " ")}</span>
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
          ⛔ Blocked — {openBlockers.map((d) => d.ref).join(", ")} must finish first. Agents can't claim this issue.
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
        <select value={direction} onChange={(e) => setDirection(e.target.value as "blocked-by" | "blocks")}>
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
        <button disabled={!other.trim()} onClick={add}>Add</button>
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
        <header><strong>{ev.actorName}</strong> <time>{when}</time></header>
        <Markdown text={String(ev.payload.body ?? "")} projectKey={projectKey} knownActorNames={knownActorNames} />
      </article>
    );
  }
  if (ev.type === "pr_opened") {
    const url = String(ev.payload.url ?? "");
    return (
      <p className="event">
        <strong>{ev.actorName}</strong> opened{" "}
        {url ? <a href={url} target="_blank" rel="noreferrer">PR #{String(ev.payload.prNumber)}</a> : `PR #${String(ev.payload.prNumber)}`}
        {" "}<time>{when}</time>
      </p>
    );
  }
  if (ev.type === "delivered") {
    const sha = String(ev.payload.mergeSha ?? "");
    const deploy = ev.payload.deploy as DeployResult | undefined;
    const deployText = !deploy?.ran ? "deploy skipped" : deploy.ok ? "deploy succeeded" : "deploy FAILED";
    return (
      <p className="event">
        <strong>{ev.actorName}</strong> delivered PR #{String(ev.payload.prNumber)} at <code>{sha.slice(0, 7)}</code> · {deployText}{" "}
        <time>{when}</time>
      </p>
    );
  }
  if (ev.type === "delivery_failed") {
    return (
      <p className="event delivery-failed">
        <strong>{ev.actorName}</strong> delivery failed: {String(ev.payload.message ?? "")} <time>{when}</time>
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
      <strong>{ev.actorName}</strong> {ev.type.replace(/_/g, " ")}{fromTo} <time>{when}</time>
    </p>
  );
}
