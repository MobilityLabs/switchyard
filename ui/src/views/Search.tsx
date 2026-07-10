import { useState } from "react";
import { listIssues, listProjects } from "../api";
import { usePoll } from "../usePoll";
import { PollErrorBar } from "../PollErrorBar";
import { href } from "../router";
import { STATUSES, type Status } from "../types";
import { projectKeyFromRef } from "./IssueDetail";

function formatUpdatedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

export default function Search({ query }: { query: string }) {
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [label, setLabel] = useState("");
  const projects = usePoll(listProjects, [], 60000);

  const trimmed = query.trim();
  const { data, error } = usePoll(
    () =>
      trimmed
        ? listIssues({
            text: trimmed,
            project: project || undefined,
            status: status || undefined,
            label: label.trim() || undefined,
          })
        : Promise.resolve([]),
    [trimmed, project, status, label],
  );

  return (
    <section className="search-view">
      <h2>Search{trimmed && <span className="hint">for "{trimmed}"</span>}</h2>
      <div className="search-filters">
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.key} value={p.key}>{p.key} — {p.name}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label"
        />
      </div>
      <PollErrorBar error={error} />
      {!trimmed ? (
        <p className="empty">Type a search term.</p>
      ) : !data ? (
        <p>Searching…</p>
      ) : data.length === 0 ? (
        <p className="empty">No issues match "{trimmed}".</p>
      ) : (
        <div className="search-results">
          {data.map((issue) => (
            <a key={issue.ref} className="search-row" href={href({ view: "issue", ref: issue.ref })}>
              <span className="ref">{issue.ref}</span>
              <span className="title">{issue.title}</span>
              <span className={`badge status-chip status-${issue.status}`}>{issue.status.replace(/_/g, " ")}</span>
              <span className="project-key">{projectKeyFromRef(issue.ref)}</span>
              <span className="updated-at">{formatUpdatedAt(issue.updatedAt)}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
