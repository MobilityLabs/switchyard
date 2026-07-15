import { useState } from "react";
import { affirmPendingAction, listIssues, listPendingActions } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import type { PendingAction } from "../types";

// "42m ago" / "3h ago" / "2d ago" — same granularity as Triage's row-age
// label; duplicated locally rather than exported from Triage.tsx to avoid
// widening that view's surface for a one-line helper (SYD phase 1 task 8).
function age(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ApprovalRow({
  action,
  issueRef,
  onAffirmed,
}: {
  action: PendingAction;
  issueRef: string | null;
  onAffirmed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [affirming, setAffirming] = useState(false);

  function approve() {
    setAffirming(true);
    setError(null);
    affirmPendingAction(action.id).then(
      () => {
        setAffirming(false);
        onAffirmed();
      },
      (e) => {
        setAffirming(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }

  return (
    <li className="session-row panel">
      {issueRef ? (
        <a className="ref" href={href({ view: "issue", ref: issueRef })}>
          {issueRef}
        </a>
      ) : (
        <span className="ref">issue #{action.issueId}</span>
      )}
      <span className="badge">→ {action.actionType}</span>
      <span className="badge">session #{action.sessionId}</span>
      <span className="age">{age(action.createdAt)}</span>
      <button className="primary" onClick={approve} disabled={affirming}>
        {affirming ? "Approving…" : "Approve"}
      </button>
      {error && (
        <span className="error-bar">
          {error} <button onClick={() => setError(null)}>×</button>
        </span>
      )}
    </li>
  );
}

// The human-presence surface for supervised sessions (SYD phase 1 task 8):
// full absorption lets the bound human pass every human-only guard, so the
// hard-gate claws back the one that matters most — a "done" stamp — by
// parking it here until this exact click affirms it. Approve POSTs
// /api/pending-actions/:id/affirm, authenticated by the browser's session
// cookie (never a bearer — see api.ts). No policy lives here: this view
// renders what the endpoint returns and posts the affirm, nothing else.
export default function Approvals() {
  const queue = usePoll(() => listPendingActions("pending"), []);
  // Unfiltered issue list, polled at a slower cadence than the queue itself —
  // used only to resolve issueId -> ref for display. If this fails or an id
  // isn't found, the row falls back to the honest "issue #<id>" rather than
  // fabricating a ref.
  const issues = usePoll(() => listIssues({}), [], 60000);

  if (queue.error && !queue.data) return <p className="error-bar">{queue.error}</p>;
  if (!queue.data) return <p>Loading…</p>;

  const refById = new Map((issues.data ?? []).map((i) => [i.id, i.ref]));

  return (
    <section className="approvals">
      <PollErrorBar error={queue.error} />
      <h2>
        Pending approvals <span className="badge">{queue.data.length}</span>
      </h2>
      {queue.data.length === 0 ? (
        <p className="empty">Nothing waiting on a human.</p>
      ) : (
        <ul className="session-list">
          {queue.data.map((action) => (
            <ApprovalRow
              key={action.id}
              action={action}
              issueRef={refById.get(action.issueId) ?? null}
              onAffirmed={() => queue.reload()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
