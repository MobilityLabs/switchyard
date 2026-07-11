// Shared by router.ts (review route scoping) and every view that needs an
// issue ref's project key (IssueDetail, Triage, Review, Search) — was
// implemented twice (SYD-132) before this consolidation.
export function projectKeyFromRef(ref: string): string {
  return ref.split("-")[0] ?? "";
}
