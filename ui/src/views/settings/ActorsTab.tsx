import { useState } from "react";
import {
  ApiError,
  createActor,
  listActors,
  mintLoginLink,
  revokeActorToken,
  rotateActorToken,
} from "../../api";
import { usePoll } from "../../usePoll";
import { PollErrorBar } from "../../PollErrorBar";

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

/** Shown exactly once, from local state only — the server never returns a
 * plaintext token again (existing invariant), so a refetch/re-render that
 * loses this state loses the token for good. */
function ShowOnceCallout(props: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner warn token-callout">
      <p>
        {props.label} — shown once, store it now: <code>{props.value}</code>
      </p>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(props.value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={props.onDismiss}>Dismiss</button>
    </div>
  );
}

function NewAgentForm(props: { onToken: (label: string, token: string) => void }) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = name.trim().length > 0 && !submitting;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        createActor({ name: name.trim(), type: "agent" }).then(
          ({ actor, token }) => {
            setSubmitting(false);
            setName("");
            props.onToken(`Token for ${actor.name}`, token);
          },
          (err) => {
            setSubmitting(false);
            setError(errorMessage(err));
          },
        );
      }}
    >
      <h3>New agent</h3>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="claude/worker"
        />
      </label>
      {error && <p className="error-bar">{error}</p>}
      <button className="primary" type="submit" disabled={!canSubmit}>
        {submitting ? "Creating…" : "Create agent"}
      </button>
    </form>
  );
}

export default function ActorsTab() {
  const actors = usePoll(listActors, []);
  const [callout, setCallout] = useState<{ label: string; value: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const showToken = (label: string, value: string) => {
    setRowError(null);
    setCallout({ label, value });
  };
  const fail = (e: unknown) => setRowError(errorMessage(e));

  return (
    <section>
      <PollErrorBar error={actors.error} />
      {callout && (
        <ShowOnceCallout
          label={callout.label}
          value={callout.value}
          onDismiss={() => setCallout(null)}
        />
      )}
      {rowError && <p className="error-bar">{rowError}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Created</th>
            <th>Token</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(actors.data ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>
                <span className={`badge ${a.type}`}>{a.type}</span>
              </td>
              <td>{new Date(a.createdAt * 1000).toLocaleDateString()}</td>
              <td>{a.hasToken ? "has token" : "no token"}</td>
              <td>
                <button
                  onClick={() => {
                    if (!confirm(`Rotate ${a.name}'s token? The old token stops working immediately.`))
                      return;
                    rotateActorToken(a.id).then(
                      ({ token }) => {
                        showToken(`New token for ${a.name}`, token);
                        actors.reload();
                      },
                      fail,
                    );
                  }}
                >
                  Rotate token
                </button>
                {a.hasToken && (
                  <button
                    onClick={() => {
                      if (!confirm(`Revoke ${a.name}'s token? It can no longer authenticate.`))
                        return;
                      revokeActorToken(a.id).then(() => actors.reload(), fail);
                    }}
                  >
                    Revoke token
                  </button>
                )}
                {a.type === "human" && (
                  <button
                    onClick={() =>
                      mintLoginLink(a.id).then(
                        ({ url }) => showToken(`Login link for ${a.name} (single use, 15 min)`, url),
                        fail,
                      )
                    }
                  >
                    Mint login link
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <NewAgentForm onToken={showToken} />
    </section>
  );
}
