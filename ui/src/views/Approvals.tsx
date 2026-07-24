import { useState } from "react";
import { affirmPendingAction, listPendingActions, listSettings } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href, issueRoute } from "../router";
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
  requiresSignature,
  onAffirmed,
}: {
  action: PendingAction;
  requiresSignature: boolean;
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
      {action.issueRef ? (
        <a className="ref" href={href(issueRoute(action.issueRef))}>
          {action.issueRef}
        </a>
      ) : (
        <span className="ref">issue #{action.issueId}</span>
      )}
      <span className="badge">→ {action.actionType}</span>
      <span className="badge">session #{action.sessionId}</span>
      {action.viaAgentName && <span className="badge">via {action.viaAgentName}</span>}
      <span className="age">{age(action.createdAt)}</span>
      {requiresSignature ? (
        // A click here would 403 (supervised.affirm_requires_signature is on
        // — see src/rest/pending-actions.ts) — offering a button that 403s is
        // worse than offering none, so the row explains the CLI path instead
        // (see the panel-level notice below).
        <span className="badge">signature required</span>
      ) : (
        <button className="primary" onClick={approve} disabled={affirming}>
          {affirming ? "Approving…" : "Approve"}
        </button>
      )}
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
export default function Approvals(_props: { project: string | null }) {
  const queue = usePoll(() => listPendingActions("pending"), []);
  // Whether supervised.affirm_requires_signature is on (phase 2): when it is,
  // POST /api/pending-actions/:id/affirm always 403s, so the click must not
  // be offered at all — see ApprovalRow. Polled at the same cadence as the
  // Config tab's settings poll.
  const settings = usePoll(listSettings, [], 30000);

  if (queue.error && !queue.data) return <p className="error-bar">{queue.error}</p>;
  if (!queue.data) return <p>Loading…</p>;

  const requiresSignature =
    settings.data?.find((s) => s.key === "supervised.affirm_requires_signature")?.value === true;

  return (
    <section className="approvals">
      <PollErrorBar error={queue.error} />
      <h2>
        Pending approvals <span className="badge">{queue.data.length}</span>
      </h2>
      {requiresSignature && (
        <p className="empty">
          These need a signed affirmation — run <code>npm run affirm -- &lt;REF&gt;</code> and touch
          your key. It will ask for a PIN or fingerprint, depending on your key.
        </p>
      )}
      {queue.data.length === 0 ? (
        <p className="empty">Nothing waiting on a human.</p>
      ) : (
        <ul className="session-list">
          {queue.data.map((action) => (
            <ApprovalRow
              key={action.id}
              action={action}
              requiresSignature={requiresSignature}
              onAffirmed={() => queue.reload()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
