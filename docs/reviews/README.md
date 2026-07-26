# Review archive

Multi-model review output, preserved because it contains verified findings that
exist nowhere else. Reviews run in a scratch directory that is deleted when the
run ends; anything worth keeping has to be copied here deliberately.

Each file is one reviewer's unedited output. They cite `file:line` against the
repo as it stood at the time of review — check before relying on a citation, and
treat a citation that no longer resolves as a sign the code moved, not that the
finding was wrong.

## 2026-07-26 — Declared PR↔issue links, round 1

Reviewed: `docs/superpowers/specs/2026-07-26-declared-pr-issue-links-design.md`
(the spec as written that day; it has not been revised since).

**Verdict: REVISE, 4/4 reviewers.** A fifth (`codex`, "The Executor") failed to
start — an unconfigured acpx session, exit 4 — so the implementation-correctness
lens is missing from this round.

| file | reviewer | lens |
|---|---|---|
| `…-r1-gemini-architect.md` | gemini | structural integrity, scope coherence |
| `…-r1-fable-skeptic.md` | Claude (fable) | runtime paths, unstated assumptions |
| `…-r1-opus-skeptic.md` | Claude (opus) | arithmetic, boundaries, consistency sweeps |
| `…-r1-pentester.md` | Claude (opus) | trust boundaries, attack surface |

### Why these are worth keeping

The spec's central premise — *a merely-proposed link can gate claims, because a
wrong link only over-blocks, which fails safe* — was falsified, and the reviews
contain the verified reasoning:

- **The repo is public**, and the spec's primary declaration channel was a
  PR-body trailer. Anyone can open a fork PR carrying one, which would create a
  link that immediately blocks claims on the named issue. With no unlink path
  specified, that is an unauthenticated, permanent, unremediable denial of
  service. Over-blocking is not safe when it cannot be undone.
- **`getOpenPr` is not only the claim gate.** It is also the source of the
  done-stamp delivery pin (`src/services/issues.ts:436` → `:453`), which
  `listPendingDeliveryAuthorizations` selects on. So opening that read to
  proposals would have made a guessed link into a delivery authorization —
  contradicting the spec's own scope line and its own tests.
- **Delivery closes the PR.** `scripts/deliver.ts:397` calls `closeDeadAgentPr`
  when no agent branch exists, and posts a public "Delivery FAILED" comment. The
  spec described this outcome as a benign statistic; it is a destructive action
  against a human-authored PR, and the design would have routed interactive PRs
  into it.
- **`deliver.ts:568-579` already documents the guard being removed** — *"pin-less
  done-stamps are interactive work (no agent PR), not delivery authorizations,
  and are skipped silently."* That comment is the only thing keeping interactive
  work out of delivery today.
- **Supervised sessions defeat `requireHuman`.** `src/server.ts:78` resolves a
  supervised session to the bound human, so an agent inside one passes any
  `actor.type === "human"` check — which was the entire security argument for
  "agents propose, humans confirm".
- **`pr_state` is a state machine, not a link table.** Its maintenance loop
  (webhook and poller) services only attributed rows, so a declared row would
  freeze at creation and never transition `open → merged`.

### Related

- The reviewed spec: `docs/superpowers/specs/2026-07-26-declared-pr-issue-links-design.md`
- The larger design this was extracted from:
  `docs/superpowers/specs/2026-07-26-approved-state-delivery-design.md`
  (three rounds, also REVISE; its round-3 findings are recorded in the spec
  itself under "Known-open findings" — its reviewer transcripts were not
  preserved, which is the omission that prompted this archive)
- The intent document written afterwards:
  `docs/2026-07-26-ideal-agent-flows.md`
