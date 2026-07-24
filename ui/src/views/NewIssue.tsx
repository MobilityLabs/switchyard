import { useRef, useState } from "react";
import { createIssue, listProjects, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { useDeferredPasteUpload } from "../usePasteUpload";
import { Composer } from "../Composer";
import { issueRoute, navigate } from "../router";
import { PRIORITIES, SUMMARY_MAX_LENGTH, WORKER_PREFERENCES, type Priority } from "../types";
import { parseLabels } from "../labels";

export default function NewIssue(_props: { defaultProject: string | null }) {
  const projects = usePoll(listProjects, []);
  const availableProjects = projects.data ?? [];

  const [projectKey, setProjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [labelsInput, setLabelsInput] = useState("");
  const [workerPreference, setWorkerPreference] = useState("");
  const [parentRef, setParentRef] = useState("");
  const [startInTodo, setStartInTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef<string | null>(null);

  const paste = useDeferredPasteUpload(setDescription);
  const { uploading, uploadPending } = paste;

  // Falls back to the first loaded project until the user picks one
  // explicitly, same pattern as Shell's board-project fallback.
  const effectiveProjectKey = projectKey || availableProjects[0]?.key || "";
  const trimmedTitle = title.trim();

  function submit() {
    if (!trimmedTitle || !effectiveProjectKey || submitting) return;
    setSubmitting(true);
    setError(null);

    const labels = parseLabels(labelsInput);

    const create = createdRef.current
      ? Promise.resolve({ ref: createdRef.current })
      : createIssue({
          projectKey: effectiveProjectKey,
          title: trimmedTitle,
          summary: summary.trim() || undefined,
          description: description.trim(),
          priority,
          workerPreference: workerPreference || null,
          parentRef: parentRef.trim() || undefined,
        }).then((issue) => {
          createdRef.current = issue.ref;
          return issue;
        });

    create
      .then(async (issue) => {
        const uploadedDescription = (await uploadPending(issue.ref, description)).trim();
        const patch: Partial<{ labels: string[]; status: "todo" }> = {};
        if (labels.length > 0) patch.labels = labels;
        if (startInTodo) patch.status = "todo";
        const descriptionChanged = uploadedDescription !== description.trim();
        const fullPatch: typeof patch & { description?: string } = patch;
        if (descriptionChanged) fullPatch.description = uploadedDescription;
        if (Object.keys(fullPatch).length > 0) await updateIssue(issue.ref, fullPatch);
        return issue;
      })
      .then(
        (issue) => navigate(issueRoute(issue.ref)),
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
            paste={paste}
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

        <label>
          Preferred worker
          <select value={workerPreference} onChange={(e) => setWorkerPreference(e.target.value)}>
            <option value="">Any</option>
            {WORKER_PREFERENCES.map((w) => (
              <option key={w} value={w}>
                {w === "interactive" ? "interactive (no headless dispatch)" : w}
              </option>
            ))}
          </select>
        </label>

        <label>
          Parent (epic)
          <input
            value={parentRef}
            onChange={(e) => setParentRef(e.target.value)}
            placeholder="e.g. SYD-1 — nest this as a story under an epic"
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
