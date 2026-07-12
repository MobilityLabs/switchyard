import { useState } from "react";
import { ApiError, createProject, listProjects, updateProject } from "../../api";
import { usePoll } from "../../usePoll";
import { PollErrorBar } from "../../PollErrorBar";

// Mirrors the server's createProject rule exactly — a laxer client regex
// would accept keys the server then rejects.
const KEY_PATTERN = /^[A-Z]{2,10}$/;

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

function RenameCell(props: { projectKey: string; name: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <>
        {props.name}{" "}
        <button
          onClick={() => {
            setName(props.name);
            setError(null);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </>
    );
  }
  return (
    <>
      <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <button
        className="primary"
        disabled={saving || name.trim() === ""}
        onClick={() => {
          setSaving(true);
          setError(null);
          updateProject(props.projectKey, { name: name.trim() }).then(
            () => {
              setSaving(false);
              setEditing(false);
              props.onSaved();
            },
            (e) => {
              setSaving(false);
              setError(errorMessage(e));
            },
          );
        }}
      >
        Save
      </button>
      <button onClick={() => setEditing(false)}>Cancel</button>
      {error && <span className="error-bar">{error}</span>}
    </>
  );
}

function NewProjectForm(props: { existingKeys: string[]; onCreated: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyValid = KEY_PATTERN.test(key);
  const keyTaken = props.existingKeys.includes(key);
  const canSubmit = keyValid && !keyTaken && name.trim().length > 0 && !submitting;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        createProject({ key, name: name.trim() }).then(
          () => {
            setSubmitting(false);
            setKey("");
            setName("");
            props.onCreated();
          },
          (err) => {
            setSubmitting(false);
            setError(errorMessage(err));
          },
        );
      }}
    >
      <h3>New project</h3>
      <label>
        Key
        <input
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="ACME"
          maxLength={10}
        />
      </label>
      {key.length > 0 && !keyValid && <p className="hint">2–10 uppercase letters, e.g. “ACME”.</p>}
      {keyValid && keyTaken && <p className="hint">A project with key “{key}” already exists.</p>}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
      </label>
      <p className="banner warn">
        The key is permanent — issue refs like {key || "KEY"}-1 can never be changed later.
      </p>
      {error && <p className="error-bar">{error}</p>}
      <button className="primary" type="submit" disabled={!canSubmit}>
        {submitting ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}

export default function ProjectsTab() {
  const projects = usePoll(listProjects, []);
  return (
    <section>
      <PollErrorBar error={projects.error} />
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Next issue #</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {(projects.data ?? []).map((p) => (
            <tr key={p.key}>
              <td>{p.key}</td>
              <td>
                <RenameCell projectKey={p.key} name={p.name} onSaved={projects.reload} />
              </td>
              <td>{p.nextIssueNumber}</td>
              <td>{new Date(p.createdAt * 1000).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <NewProjectForm
        existingKeys={(projects.data ?? []).map((p) => p.key)}
        onCreated={projects.reload}
      />
    </section>
  );
}
