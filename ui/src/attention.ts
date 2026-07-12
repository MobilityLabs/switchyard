import type { Issue } from "./types";

// Single source of truth for how an attention flag renders as a chip. Hard
// errors (delivery_failed) stay red danger; process deviations (SYD-188) render
// as a softer warn nudge.
export function attentionChip(
  attention: Issue["attention"],
): { label: string; className: string } | null {
  if (!attention) return null;
  switch (attention.reason) {
    case "delivery_failed":
      return { label: "⛔ delivery failed", className: "badge danger" };
    case "merged_pr_not_done":
      return { label: "⚠ merged — stamp done", className: "badge warn" };
    case "open_pr_not_in_review":
      return { label: "⚠ PR open — move to review", className: "badge warn" };
    case "stale_claim":
      return { label: "⚠ claim going stale", className: "badge warn" };
  }
}
