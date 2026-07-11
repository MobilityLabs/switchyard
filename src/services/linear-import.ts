import type { Status, Priority } from "../db/schema.js";
import { SwitchyardError } from "./errors.js";

/**
 * Linear workflow-state *types* map 1:1 onto Switchyard statuses, except:
 * Linear has no dedicated review type (review columns are `started` states
 * named "In Review" etc.), and `duplicate` has no Switchyard equivalent so it
 * lands in `canceled`.
 */
const STATE_TYPE_TO_STATUS: Record<string, Status> = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
  duplicate: "canceled",
};

export function mapStateToStatus(state: { name: string; type: string }): Status {
  const status = STATE_TYPE_TO_STATUS[state.type];
  if (!status) {
    throw new SwitchyardError(
      `Linear state "${state.name}" has unknown type "${state.type}" — the importer maps: ${Object.keys(STATE_TYPE_TO_STATUS).join(", ")}.`,
    );
  }
  if (state.type === "started" && /review/i.test(state.name)) return "in_review";
  return status;
}

/** Linear priorities are numbers: 0=none, 1=urgent, 2=high, 3=medium, 4=low. */
const PRIORITY_MAP: Record<number, Priority> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

export function mapPriority(priority: number): Priority {
  return PRIORITY_MAP[priority] ?? "none";
}
