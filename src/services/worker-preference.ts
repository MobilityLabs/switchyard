// The `issues.worker_preference` vocabulary, in a leaf module with no imports
// so both the server (nextTask's affinity sort) and the worker host
// (scripts/worker-select.ts's dispatch skip) can share it. It was a literal in
// worker-select alone until SYD-294 gave the server a second reader — and a
// load-bearing string duplicated across two consumers is the drift class this
// codebase keeps paying for (SYD-176/177/178/202).

/**
 * Reserved `workerPreference` value: an issue that must be handled by a
 * human-attended interactive session, never auto-dispatched to a headless
 * worker (e.g. it needs live credentials, a real provider CLI, or a mid-task
 * human decision — the exact case that stranded SYD-220/225's headless workers).
 * Disjoint from the engine names the soft-affinity sort understands.
 */
export const INTERACTIVE_PREFERENCE = "interactive";

/**
 * The `workerPreference` value a caller matches, for the soft-affinity sort.
 *
 * A human IS the interactive worker, so a human asking for work matches
 * exactly the issues the dispatcher refuses to hand a container. An agent's
 * engine is its actor-name prefix — the actors are `claude/dev`, `codex/dev`,
 * `gemini/dev`, so the prefix is the same classification
 * `scripts/worker-select.ts` derives from its own `config.engine`.
 *
 * Kept as a function rather than inlined because "which worker is asking" is a
 * question two subsystems now answer, and they must answer it identically.
 */
export function callerClassification(actor: { name: string; type: string }): string {
  if (actor.type === "human") return INTERACTIVE_PREFERENCE;
  return actor.name.split("/")[0];
}
