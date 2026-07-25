# Issue authoring quality + interactive routing + parent/child surfacing (design)

- **Date:** 2026-07-14
- **Status:** Draft — approved in brainstorming (Sean, 2026-07-14)

## Context & goal

Two recurring gaps this addresses:

1. **Issue quality is unguided.** The best issues (SYD-220/225) follow a clear
   shape — What / Why / Next action / Provenance / Effort, a one-sentence
   triageable summary, topic labels — but nothing captures or enforces that.
2. **No "interactive-only" routing.** SYD-220/225 *required* a human-attended
   interactive session (real CLIs + live credentials); dispatched headless
   workers just got stranded and escalated. There's no way to mark an issue
   "don't headless-dispatch this."

**Goal:** (a) a repo `make-issue` skill capturing issue best-practices, and (b) a
`workerPreference = "interactive"` routing value that the dispatch worker skips,
surfaced in the UI — plus parent/child (epic/story) surfacing so decomposition is
usable from the board, not just via MCP.

## Non-goals

- **An `epic` label.** Redundant: `parentId` already models epic→story
  containment (an issue *with children* is an epic; a child *with a parent* is a
  story). Deriving from child-count avoids a second field that drifts.
- **Cross-engine changes / new engines.** Routing only.
- **Cycle-proof re-parenting.** We reject direct self-parent; deep cycle
  detection is out (a parent chain is shallow and human-curated).

## Part 1 — Interactive routing

### A. Reserved value
`INTERACTIVE_PREFERENCE = "interactive"` (exported from `scripts/worker-select.ts`).
`workerPreference` stays free-text (no migration); `"interactive"` is a reserved
sentinel = "human-attended interactive session only; never headless-dispatch."
It's disjoint from the engine names (`claude`/`codex`/`gemini`) the soft-affinity
sort already understands.

### B. Dispatch skip (`selectDispatchable`)
A hard exclusion in the filter loop, beside the existing `needsInput`/`blocked`/
`openPr` skips:
```ts
if (issue.workerPreference === INTERACTIVE_PREFERENCE) continue;
```
So **no** engine's dispatch worker ever claims an interactive-marked issue,
regardless of `dispatchPolicy`. This is the enforcement — without it the marker
is cosmetic.

## Part 2 — Parent/child surfacing (epic/story)

Backend already: `file_issue`/`createIssue` accept `parent_ref`/`parentRef` →
`parentId`. Missing: re-parenting on update, a children query, and any UI.

### C. Re-parenting on update
- `UpdateIssueInput.parentRef?: string | null` — resolve ref→id (`null` clears);
  reject an issue being its own parent (`SwitchyardError`); record a new
  `parent_changed` event kind. Exposed via REST `issueUpdateBody.parentRef` and
  MCP `update_issue.parent_ref` (parity with `file_issue`).

### D. Children query + payload
- `listChildren(db, ref)` → lightweight child rows (ref, number, title, status,
  priority), ordered by number. Included as `children` on the `/issues/:ref`
  detail response.
- `childCountsByParent(db)` → `Map<parentId, count>`; the `/issues` list handler
  adds `childCount` per row (same pattern as `attention`/`openPr` maps) so the
  board can badge without N queries.

## Part 3 — UI

- **NewIssue:** a "Preferred worker" `<select>` (Any / claude / codex / gemini /
  interactive) → `workerPreference`; a "Parent (ref)" input → `parentRef`.
- **IssueDetail:** the same two controls, editable (PATCH); a **Stories** section
  listing `children` (each a link with status); badges for `workerPreference`
  (highlighted when `interactive`) and child-count.
- **Board card:** small badges for `workerPreference` (esp. `interactive`) and
  child-count.
- `ui/src/types.ts` + `api.ts`: add `workerPreference`, `parentRef`/`parentId`,
  `childCount`, and the detail `children` array.

## Part 4 — `make-issue` skill (`.claude/skills/make-issue/SKILL.md`)

Triggers on filing/creating/making a Switchyard issue. Captures:
- **Anatomy** (modeled on SYD-220/225): title; one-sentence triageable summary;
  description with **What / Why / Next action / Provenance / Effort**.
- **Topic tags:** ≥1 area label (`ui`, `dispatch`, `engine-worker`, `security`,
  `docs`, …); don't file without one.
- **Headless-vs-interactive litmus:** *can a headless agent in a disposable
  container finish this with no human-attended step and no real external
  credentials?* If not → `workerPreference: "interactive"`. SYD-220/225 as the
  worked example.
- **Big issues → spec + epic/story:** if multi-subsystem / >~1 session / needs
  design — brainstorm → spec in `docs/superpowers/specs/`, then file a **parent
  epic** with **child stories** (`parent_ref`), each independently completable;
  use dependencies (blocks/blocked-by) for ordering. No epic label — hierarchy is
  `parentId`.
- **How to file:** `file_issue` (MCP; agent issues land in triage w/ provenance)
  or the UI; set project/title/summary/description/labels/priority/
  workerPreference/parent_ref.

## Testing

- `selectDispatchable` excludes `workerPreference: "interactive"` (unit).
- `listChildren` / `childCountsByParent` (service); `updateIssue` re-parent sets
  `parentId` + records `parent_changed`, rejects self-parent (service).
- REST: `issueUpdateBody` accepts `parentRef`; `/issues/:ref` includes `children`;
  `/issues` rows carry `childCount`.
- UI: NewIssue submits the two fields; IssueDetail renders the Stories section +
  badges (component tests where the harness supports).
- `npm run verify` gate.

## Rollout
Single feature branch, logical commits (routing → backend parent/child → UI →
skill). Follow-ups filed via the new skill as dogfood.
