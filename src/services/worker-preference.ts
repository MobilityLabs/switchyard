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

/**
 * Whether a person is watching this caller — the question the `interactive`
 * hard skip actually wants answered.
 *
 * It used to ask `actor.type !== "human"`, which conflates "is this a person"
 * with "is a person watching". An interactive Claude session is type=agent and
 * human-attended, and it is precisely the caller `interactive` work exists for;
 * routing it away meant the top of the curated queue was invisible to the only
 * non-human caller that could act on it. A human is attended by definition, so
 * `attended` is set at creation for them and no caller has to remember.
 *
 * Reads as false when the flag is absent, so an Actor projection that forgot
 * the column withholds work rather than handing a headless worker something it
 * cannot finish. This is routing only — it grants no authority, and
 * requireHuman never consults it.
 */
export function isAttendedCaller(actor: { type: string; attended?: boolean }): boolean {
  return actor.type === "human" || actor.attended === true;
}
