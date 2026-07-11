import { listAgentSessions } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import type { AgentSession } from "../types";

// Exported for the issue-detail live strip (SYD-43). "42s", "7m", "1h 12m".
export function formatElapsed(
  startedAt: number,
  endedAt: number | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const secs = Math.max(0, (endedAt ?? nowSeconds) - startedAt);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function SessionRow({ s }: { s: AgentSession }) {
  const elapsed = formatElapsed(s.startedAt, s.endedAt);
  return (
    <li className="session-row panel">
      <a className="ref" href={href({ view: "issue", ref: s.ref })}>
        {s.ref}
      </a>{" "}
      {s.issueTitle}
      <span className="badge">{s.mode}</span>
      {s.status === "running" ? (
        <span className="badge session-live">live · {elapsed}</span>
      ) : (
        <span className="badge">
          exit {s.exitCode ?? "?"} · ran {elapsed}
        </span>
      )}
      {s.lastNote && <span className="session-note">“{s.lastNote.note}”</span>}
    </li>
  );
}

// The Agents panel (SYD-43): live worker sessions, then recently-exited ones.
// One unfiltered poll, split client-side — the nav badge (Shell) uses the
// server's active filter, which also drops zombie sessions; here a zombie
// showing hours of "live" elapsed is itself useful signal.
export default function Agents() {
  const { data, error } = usePoll(() => listAgentSessions(), []);
  if (error && !data) return <p className="error-bar">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const running = data.filter((s) => s.status === "running");
  const exited = data.filter((s) => s.status === "exited");
  return (
    <section className="agents">
      <PollErrorBar error={error} />
      <h2>Active sessions</h2>
      {running.length === 0 && <p className="empty">No agent sessions running.</p>}
      {running.length > 0 && (
        <ul className="session-list">
          {running.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </ul>
      )}
      <h2>Recent</h2>
      {exited.length === 0 && <p className="empty">No finished sessions yet.</p>}
      {exited.length > 0 && (
        <ul className="session-list">
          {exited.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </section>
  );
}
