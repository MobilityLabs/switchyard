import { useRef, useState } from "react";
import { createIssue, listProjects, updateIssue } from "../api";
import { usePoll } from "../usePoll";
import { useDeferredPasteUpload } from "../usePasteUpload";
import { Composer } from "../Composer";
import { issueRoute, navigate } from "../router";
import { PRIORITIES, SUMMARY_MAX_LENGTH, WORKER_PREFERENCES, type Priority } from "../types";
import { parseLabels } from "../labels";

type SavedFields = {
  title: string;
  summary: string | null;
  description: string;
  priority: Priority;
  workerPreference: string | null;
  parentRef: string | null;
};
type CreatedIssue = { ref: string; projectKey: string; saved: SavedFields };

export default function NewIssue({ defaultProject }: { defaultProject: string | null }) {
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
  const [createdIssue, setCreatedIssue] = useState<CreatedIssue | null>(null);
  const submittingRef = useRef(false);

  const paste = useDeferredPasteUpload(setDescription);
  const { uploading, uploadPending } = paste;

  // Until the user picks explicitly: the URL scope's project (SYD-254),
  // else the first loaded project — same pattern as Shell's board fallback.
  const effectiveProjectKey =
    createdIssue?.projectKey || projectKey || defaultProject || availableProjects[0]?.key || "";
  const trimmedTitle = title.trim();

  async function submit() {
    if (!trimmedTitle || !effectiveProjectKey || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const labels = parseLabels(labelsInput);
    const fields: SavedFields = {
      title: trimmedTitle,
      summary: summary.trim() || null,
      description: description.trim(),
      priority,
      workerPreference: workerPreference || null,
      parentRef: parentRef.trim() || null,
    };

    try {
      let created = createdIssue;
      if (!created) {
        const issue = await createIssue({
          projectKey: effectiveProjectKey,
          ...fields,
          summary: fields.summary ?? undefined,
          parentRef: fields.parentRef ?? undefined,
        });
        created = { ref: issue.ref, projectKey: effectiveProjectKey, saved: fields };
        setCreatedIssue(created);
      }
      const desired = {
        ...fields,
        description: (await uploadPending(created.ref, description)).trim(),
      };
      // Uploads replace the editor's placeholders before the PATCH can succeed.
      // Compare with the last persisted fields, never that updated local draft.
      // This also preserves edits made after a partial creation failed.
      const patch: Parameters<typeof updateIssue>[1] = Object.fromEntries(
        Object.entries(desired).filter(
          ([key, value]) => created.saved[key as keyof SavedFields] !== value,
        ),
      );
      if (labels.length > 0) patch.labels = labels;
      if (startInTodo) patch.status = "todo";
      if (Object.keys(patch).length > 0) {
        await updateIssue(created.ref, patch);
        setCreatedIssue({ ...created, saved: desired });
      }
      navigate(issueRoute(created.ref));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="new-issue">
      <h2>New issue</h2>
      {error && (
        <p className="error-bar">
          {createdIssue && (
            <>Issue {createdIssue.ref} was created. Retry to save the remaining changes. </>
          )}
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
          <select
            disabled={submitting || createdIssue !== null}
            value={effectiveProjectKey}
            onChange={(e) => setProjectKey(e.target.value)}
          >
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
            disabled={submitting}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary"
            required
          />
        </label>

        <label>
          Summary
          <input
            disabled={submitting}
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
            disabled={submitting}
          />
        </label>

        <label>
          Priority
          <select
            disabled={submitting}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
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
            disabled={submitting}
            value={labelsInput}
            onChange={(e) => setLabelsInput(e.target.value)}
            placeholder="comma, separated, labels"
          />
        </label>

        <label>
          Preferred worker
          <select
            disabled={submitting}
            value={workerPreference}
            onChange={(e) => setWorkerPreference(e.target.value)}
          >
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
            disabled={submitting}
            value={parentRef}
            onChange={(e) => setParentRef(e.target.value)}
            placeholder="e.g. SYD-1 — nest this as a story under an epic"
          />
        </label>

        <label className="checkbox-row">
          <input
            disabled={submitting}
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
