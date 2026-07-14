import { useState } from "react";
import { createIssue, listProjects, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { usePasteUpload } from "../usePasteUpload";
import { Composer } from "../Composer";
import { navigate } from "../router";
import { PRIORITIES, SUMMARY_MAX_LENGTH, type Priority } from "../types";
import { parseLabels } from "../labels";

export default function NewIssue() {
  const projects = usePoll(listProjects, []);
  const availableProjects = projects.data ?? [];

  const [projectKey, setProjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [labelsInput, setLabelsInput] = useState("");
  const [startInTodo, setStartInTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same shape as Triage/IssueDetail/Review, but there's no issue ref yet —
  // paste-to-upload only works once the issue exists, so usePasteUpload
  // short-circuits with a clear uploadError instead of hitting the API
  // (which 404s on an empty ref) if someone pastes before submitting.
  const { onPaste, uploading, uploadError, setUploadError, textareaRef } = usePasteUpload(
    "",
    description,
    setDescription,
  );

  // Falls back to the first loaded project until the user picks one
  // explicitly, same pattern as Shell's board-project fallback.
  const effectiveProjectKey = projectKey || availableProjects[0]?.key || "";
  const trimmedTitle = title.trim();

  function submit() {
    if (!trimmedTitle || !effectiveProjectKey || submitting) return;
    setSubmitting(true);
    setError(null);

    const labels = parseLabels(labelsInput);

    createIssue({
      projectKey: effectiveProjectKey,
      title: trimmedTitle,
      summary: summary.trim() || undefined,
      description: description.trim(),
      priority,
    })
      .then((issue) => {
        const patch: Partial<{ labels: string[]; status: "todo" }> = {};
        if (labels.length > 0) patch.labels = labels;
        if (startInTodo) patch.status = "todo";
        if (Object.keys(patch).length === 0) return issue;
        return updateIssue(issue.ref, patch).then(() => issue);
      })
      .then(
        (issue) => navigate({ view: "issue", ref: issue.ref }),
        (e) => {
          setSubmitting(false);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
  }

  return (
    <section className="new-issue">
      <h2>New issue</h2>
      {error && (
        <p className="error-bar">
          {error} <button onClick={() => setError(null)}>×</button>
        </p>
      )}
      <form
        className="panel new-issue-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          Project
          <select value={effectiveProjectKey} onChange={(e) => setProjectKey(e.target.value)}>
            {availableProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary"
            required
          />
        </label>

        <label>
          Summary
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One or two sentences a human can triage from at a glance"
            maxLength={SUMMARY_MAX_LENGTH}
          />
        </label>

        <label>
          Description
          <Composer
            value={description}
            onChange={setDescription}
            placeholder="Details… (paste an image or video to attach it)"
            paste={{ onPaste, uploading, uploadError, setUploadError, textareaRef }}
          />
        </label>

        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label>
          Labels
          <input
            value={labelsInput}
            onChange={(e) => setLabelsInput(e.target.value)}
            placeholder="comma, separated, labels"
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={startInTodo}
            onChange={(e) => setStartInTodo(e.target.checked)}
          />
          Start in todo (skip backlog)
        </label>

        <button
          className="primary"
          type="submit"
          disabled={submitting || !trimmedTitle || uploading}
        >
          {submitting ? "Creating…" : "Create issue"}
        </button>
      </form>
    </section>
  );
}
