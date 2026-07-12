import { useState } from "react";
import {
  ApiError,
  addGithubRepo,
  addWebhook,
  listGithubRepos,
  listProjects,
  listWebhooks,
  removeGithubRepo,
  removeWebhook,
  setWebhookActive,
} from "../../api";
import type { Project } from "../../types";
import { usePoll } from "../../usePoll";
import { PollErrorBar } from "../../PollErrorBar";

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

function projectLabel(projects: Project[], projectId: number | null): string {
  if (projectId === null) return "all projects";
  return projects.find((p) => p.id === projectId)?.key ?? `#${projectId}`;
}

/** Shared add-form footer: optional project scope + optional (write-only) secret. */
function ScopeAndSecret(props: {
  projects: Project[];
  projectKey: string;
  onProjectKey: (v: string) => void;
  secret: string;
  onSecret: (v: string) => void;
}) {
  return (
    <>
      <label>
        Project
        <select value={props.projectKey} onChange={(e) => props.onProjectKey(e.target.value)}>
          <option value="">All projects</option>
          {props.projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} — {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Secret (optional, write-only)
        <input
          type="password"
          value={props.secret}
          onChange={(e) => props.onSecret(e.target.value)}
        />
      </label>
    </>
  );
}

function WebhooksPanel({ projects }: { projects: Project[] }) {
  const hooks = usePoll(listWebhooks, []);
  const [url, setUrl] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="panel">
      <h3>Webhooks</h3>
      <PollErrorBar error={hooks.error} />
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Scope</th>
            <th>Signed</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(hooks.data ?? []).map((h) => (
            <tr key={h.id}>
              <td>{h.url}</td>
              <td>{projectLabel(projects, h.projectId)}</td>
              <td>{h.hasSecret ? "signed" : "unsigned"}</td>
              <td>{h.active ? "active" : "disabled"}</td>
              <td>
                <button
                  onClick={() =>
                    setWebhookActive(h.id, !h.active).then(
                      () => hooks.reload(),
                      (e) => setError(errorMessage(e)),
                    )
                  }
                >
                  {h.active ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => {
                    if (!confirm(`Delete the webhook for ${h.url}?`)) return;
                    removeWebhook(h.id).then(
                      () => hooks.reload(),
                      (e) => setError(errorMessage(e)),
                    );
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          setError(null);
          addWebhook({
            url: url.trim(),
            projectKey: projectKey || undefined,
            secret: secret || undefined,
          }).then(
            () => {
              setUrl("");
              setSecret("");
              hooks.reload();
            },
            (err) => setError(errorMessage(err)),
          );
        }}
      >
        <label>
          URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hook"
          />
        </label>
        <ScopeAndSecret
          projects={projects}
          projectKey={projectKey}
          onProjectKey={setProjectKey}
          secret={secret}
          onSecret={setSecret}
        />
        {error && <p className="error-bar">{error}</p>}
        <button className="primary" type="submit" disabled={!url.trim()}>
          Add webhook
        </button>
      </form>
    </section>
  );
}

function ReposPanel({ projects }: { projects: Project[] }) {
  const repos = usePoll(listGithubRepos, []);
  const [fullName, setFullName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="panel">
      <h3>GitHub repos</h3>
      <PollErrorBar error={repos.error} />
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>Scope</th>
            <th>Secret</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(repos.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{r.fullName}</td>
              <td>{projectLabel(projects, r.projectId)}</td>
              <td>{r.hasSecret ? "own secret" : "shared secret"}</td>
              <td>
                <button
                  onClick={() => {
                    if (!confirm(`Unlink ${r.fullName}?`)) return;
                    removeGithubRepo(r.id).then(
                      () => repos.reload(),
                      (e) => setError(errorMessage(e)),
                    );
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!fullName.trim()) return;
          setError(null);
          addGithubRepo({
            fullName: fullName.trim(),
            projectKey: projectKey || undefined,
            secret: secret || undefined,
          }).then(
            () => {
              setFullName("");
              setSecret("");
              repos.reload();
            },
            (err) => setError(errorMessage(err)),
          );
        }}
      >
        <label>
          Repo
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="owner/repo"
          />
        </label>
        <ScopeAndSecret
          projects={projects}
          projectKey={projectKey}
          onProjectKey={setProjectKey}
          secret={secret}
          onSecret={setSecret}
        />
        {error && <p className="error-bar">{error}</p>}
        <button className="primary" type="submit" disabled={!fullName.trim()}>
          Link repo
        </button>
      </form>
    </section>
  );
}

export default function IntegrationsTab() {
  const projects = usePoll(listProjects, []);
  return (
    <>
      <WebhooksPanel projects={projects.data ?? []} />
      <ReposPanel projects={projects.data ?? []} />
    </>
  );
}
