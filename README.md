# Switchyard

Self-hosted, agent-native project tracker. Humans plan on a shared board;
Claude Code agents file, triage, claim, and work issues through MCP —
gated by human triage, with provenance on everything.

Spec: `docs/superpowers/specs/2026-07-07-switchyard-design.md`

## Quick start

```bash
npm install
npx tsx src/cli.ts switchyard.db add-project AIPI "aipi benchmarking"
npx tsx src/cli.ts switchyard.db add-actor sean human
npx tsx src/cli.ts switchyard.db add-actor claude/worker agent
npm run dev   # listens on :3300
```

## Configuration

The server reads its config from environment variables (or a `.env` file,
gitignored, kept `0600`). See `.env.example` for the full list with defaults:
`SWITCHYARD_DB`, `PORT`, `ATTACHMENTS_DIR`, `SWITCHYARD_URL`,
`GITHUB_WEBHOOK_SECRET`, `STALE_CLAIM_HOURS`.

```bash
cp .env.example .env
```

## Connect Claude Code

```bash
claude mcp add switchyard --transport http http://localhost:3300/mcp \
  --header "Authorization: Bearer <token from add-actor>"
```

Tools: `list_projects`, `get_issue`, `search_issues`, `next_task`,
`file_issue`, `claim_issue`, `update_issue`, `comment`, `triage_queue`,
`add_dependency`.

For a per-person setup (user-scoped registration, a CLAUDE.md snippet that
primes sessions to actually use the tracker) see `docs/agent-kit.md`.

## Web UI

The server serves the web UI at `/` — triage inbox (default), per-project board
with drag-to-move, and issue detail. Log in once via a minted link (below); the
session cookie lasts 30 days.

## Humans: log in

```bash
npx tsx src/cli.ts switchyard.db mint-login sean
# open the printed link — it sets a 30-day session cookie
```

## REST API

All routes under `/api` accept a bearer token (agents) or the session cookie (humans).
`GET/POST /api/projects` · `GET /api/actors` · `GET/POST /api/issues` ·
`GET/PATCH /api/issues/:ref` · `POST /api/issues/:ref/claim` ·
`POST /api/issues/:ref/comments` · `GET /api/next-task` ·
`POST /api/dependencies` · `GET/POST /api/webhooks` · `DELETE /api/webhooks/:id` ·
`GET /api/events`.

`GET /api/events?since=<unix>&limit=<n>` — global, newest-first activity feed
(events joined with issue ref/title, project key, and actor name). `limit`
defaults to 200, capped at 500. Powers reflection tooling like the Dreamer
(below); useful for any external consumer that wants "what happened
recently" without polling per-issue.

Issues in `triage` can only be moved out by human actors (enforced server-side).

## Webhooks

```bash
npx tsx src/cli.ts switchyard.db add-webhook https://example.com/hook SYD
```

Events POST as JSON (`event`, `issue`, `project`, `actor`, ...) with an
`x-switchyard-signature: sha256=<hmac>` header when a secret is set.
Delivery is best-effort (no retries), polled every 2 seconds.

### Inbound GitHub integration

`POST /webhooks/github` receives GitHub's own webhook deliveries so a PR
merge/close or a red check run shows up on the issue without an agent
hand-writing a delivery comment. Register it on the repo(s) agents push
`agent/<ref>` branches to:

- Payload URL: `https://<host>/webhooks/github`
- Content type: `application/json`
- Events: **Pull requests**, **Check suites** (Push is accepted but currently
  ignored)
- Secret: any random string, also set as `GITHUB_WEBHOOK_SECRET` in the
  server's `.env`

The issue is matched by parsing the PR/check-suite branch as `agent/<ref>`
(falling back to scanning the PR title/body for a bare `<PROJECT>-<n>` ref)
and recording `gh_pr_opened` / `gh_pr_merged` / `gh_pr_closed` /
`gh_checks_passed` / `gh_checks_failed` timeline events, attributed to a
synthetic `github` actor. The SYD-54 delivery strip on the issue view folds
these in automatically alongside the existing agent-posted delivery events.
Deliveries are rejected with 401 unless they carry a valid
`X-Hub-Signature-256` for the configured secret, and 501 if no secret is
configured at all.

Link the repos you want inbound visibility for (owner/repo, optionally scoped
to a project):

```bash
npx tsx src/cli.ts switchyard.db add-github-repo acme/widgets SYD
```

#### Polling fallback

Some repos can't have a webhook installed (no admin access, org policy,
etc.). `scripts/github-poll.ts` covers those: it watches every repo linked
via `add-github-repo` above through the `gh` CLI (`gh pr list`, `gh run
list` — no local clone needed, just `gh auth login` on the host) instead of
waiting for a delivery, and feeds whatever changed into the same
`src/services/github-webhook.ts` matching/recording logic via
`POST /api/github-events` — an authenticated version of `POST /webhooks/github`
for callers that can't produce (or verify) an HMAC signature. Both paths
converge on the same timeline events, so a repo only needs to be linked, not
also webhook-configured, to show up on the SYD-54 delivery strip.

```bash
SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts            # loop forever
SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts --once     # single scan
SWITCHYARD_TOKEN=... npx tsx scripts/github-poll.ts --dry-run  # print, don't POST
```

`SWITCHYARD_TOKEN` must belong to a human-type actor — `POST /api/github-events`
rejects agent actors, since any dispatched agent holding a bearer token could
otherwise forge `pull_request`/`check_suite` events. Provision a dedicated
poller identity rather than reusing a person's login:
`add-actor <name> human` + `mint-login <name>`.

Polls every `githubPoll.pollSeconds` in `switchyard-worker.json` (default
120s — kept well above `delivery.pollSeconds` since each tick spends GitHub
API rate limit per linked repo). Per-repo/per-PR state persists in
`.superpowers/github-poll-state.json`, so only state *transitions* (a PR
opening, closing, or a run's conclusion changing) get reported — a repo's
already-open PRs at link time are treated as newly opened, but re-polling
the same unchanged PR or check conclusion is a no-op, so restarts don't
replay history.

### Slack notifications

A standalone consumer (its own process, not part of the main server) that turns
select webhook events into Slack messages: new triage filings, needs-input
escalations, and issues moving to `in_review`. Everything else is dropped.

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npx tsx scripts/slack-notifier.ts
```

Then register it as a webhook (optionally scoped to a project, optionally signed):

```bash
npx tsx src/cli.ts switchyard.db add-webhook http://<host>:3301/ [PROJECT] <secret>
```

If you set a secret, also export it as `SWITCHYARD_WEBHOOK_SECRET` on the notifier
process so it can verify the `x-switchyard-signature` header. It ships unconfigured
— nothing posts to Slack until `SLACK_WEBHOOK_URL` is set and the webhook is
registered. Always set a webhook secret when registering — an unsigned webhook
endpoint will accept spoofed events from anyone who finds the URL.

## Auto-dispatch

A local poller (`scripts/agent-worker.ts`, meant to run on a person's own machine)
that spawns headless Claude Code sessions on ready work.

The human control point is a label: only issues in `todo` carrying the
configured label (`auto` by default) are ever picked up. Copy the example
config and edit it for your machine:

```bash
cp switchyard-worker.example.json switchyard-worker.json
```

```json
{
  "url": "http://100.85.158.109:3300",
  "label": "auto",
  "intervalSeconds": 300,
  "eventPollSeconds": 15,
  "maxConcurrent": 1,
  "projects": { "SYD": { "repo": "/Users/sean/sites/switchyard" } },
  "containerized": true,
  "image": "switchyard-worker"
}
```

Containerized dispatch always bases `agent/<ref>` on `origin/main` in each
project's repo, regardless of what branch is checked out on the host —
set `projects.<KEY>.baseBranch` to override this for a repo whose
integration branch isn't `main`.

Setting up a machine to run the worker is one command — a doctor that checks
the whole chain (config, project repos, docker image, tokens in `.env`, server
reachability, and that the token is an *agent* actor, never a human one):

```bash
npm run init-worker                       # check everything, change nothing
npm run init-worker -- --self-test        # + one dry-run tick (prints what would dispatch)
npm run init-worker -- --install-launchd  # + install a KeepAlive LaunchAgent (macOS)
```

`--install-launchd` writes `~/Library/LaunchAgents/com.switchyard.worker.plist`
and loads it: the worker starts immediately, restarts if it crashes (a clean
stop stays down — `launchctl unload` to stop it), and comes back after reboot.
No secrets and no shell are involved in the plist — launchd execs `tsx`
directly and the worker itself reads the repo `.env` (0600) at start. Two
worker loops can't run at once: the loop takes a pidfile lock
(`.superpowers/worker.pid`), and the installer additionally refuses to load
the LaunchAgent while any worker process is running.

To run it by hand instead:

```bash
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts            # poll forever
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --once     # single poll
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts --dry-run  # print, don't spawn
```

### Runners

There is more than one way to spin up a session; `runner` in
`switchyard-worker.json` picks it:

- `"cli"` (default) — shell out to `claude -p`, bare on the host or inside a
  Docker container per `containerized`. What's documented above.
- `"sdk"` — run the session in-process through the Claude Agent SDK. The MCP
  bearer token is handed over as an in-memory object (never argv, never a
  temp file), and the worker log gets one line per tool call instead of an
  opaque transcript. Setup: `npm install --prefix worker-sdk` (its deps are
  isolated there because the SDK wants zod@4 and the app is on zod@3).
  Not combinable with `containerized` yet.

Registering non-Claude runners (Codex, Antigravity, Cursor) is being
researched in SYD-46.

Safety model: the label gate (nothing runs unlabeled), `maxConcurrent` (caps
concurrent headless sessions), and the fact that dispatched work still flows
through the same claim -> in_review -> human-review pipeline as anything else
— dispatched sessions can never move an issue to `done` themselves, and the
server enforces this (agents attempting a `done` transition are rejected, not
just discouraged by the prompt). Each dispatch's stdout/stderr is logged to
`<project repo>/.superpowers/worker-logs/<ref>.log`.

Labeling an issue `auto` is consent to run that issue's content (title,
description, comments) through a headless session with your local permission
profile — review the issue text like you'd review a script before running it,
and keep the worker's permission allowlist tight. In containerized mode
(below) that consent still applies, but its stakes are lower: the session
never gets a shell on your actual machine, so a tight tool allowlist matters
less than it does bare on the host.

### Containerized mode (recommended)

By default, dispatched sessions run bare on the host: same process, same
working tree, same filesystem access as anything else you run locally. Set
`containerized: true` and Switchyard instead runs the session inside a
disposable Docker container that clones the repo internally, works on a
branch, and pushes the branch back — it is structurally unable to touch your
host filesystem or push to `main`. This is the recommended default; the bare
mode above stays available for repos or setups where Docker isn't practical.

Build the worker image once (rebuild after upgrading `@anthropic-ai/claude-code`
or changing `scripts/container-entry.sh`):

```bash
npm run build:worker-image
```

Set `containerized: true` in `switchyard-worker.json` (and optionally
`image` if you're using something other than the default `switchyard-worker`
tag), and make sure the worker process's environment has one of:

```bash
CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`
ANTHROPIC_API_KEY=...         # or a raw API key
```

`scripts/agent-worker.ts` passes these through to the container via bare
`-e VAR` (no value embedded in argv) — see `buildDockerArgs` in
`scripts/worker-select.ts`. Inside the container, `scripts/container-entry.sh`
clones `/origin` (the host repo, mounted read-write) into `/work`, checks out
`agent/<ref>`, runs the same `claude -p` session as bare mode (with an
addendum reminding it to commit and to name the branch in its issue
comment), and pushes `agent/<ref>` back to `/origin` if it produced any
commits. The container gets no host filesystem beyond that one mount, and can
only ever push that one branch name — merging stays a human decision, same
as bare mode.

## Delivery gate

Unattended agent work never lands on `main` (or the NAS) until a human stamps
the issue `done`. Three pieces (SYD-49):

1. **Workers open PRs.** When a containerized session exits having pushed
   `agent/<ref>` into the host repo, the worker pushes that branch to GitHub
   and opens a PR titled with the ref — host-side, so containers never hold
   GitHub credentials. Controlled by `delivery.openPrs` (default true when the
   `delivery` block exists).
2. **A delivery worker merges + deploys on the done-stamp.**

   ```bash
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts            # loop forever
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --once     # single scan
   SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts --dry-run  # print, don't merge
   ```

   It polls `GET /api/events` (every `delivery.pollSeconds`, default 30s) for
   `status_changed → done` — a transition only humans can make, server-enforced
   — merges the open `agent/<ref>` PR, deploys via `npm run deploy` from a
   dedicated clean clone (`delivery.cloneDir`, default
   `~/.switchyard/deliver-clones` — never a working tree), and comments the
   merge SHA + deploy result on the issue. Issues without an open agent PR
   (interactive work) are skipped: interactive sessions keep direct merges.
   The event cursor persists in `.superpowers/deliver-cursor`, so approvals
   stamped while the worker was down are delivered on restart. A crash or
   shutdown between the merge and the deploy leaves the PR merged but not
   deployed and not commented — on restart the ref is skipped (its PR is no
   longer open), so if an issue is stamped done and its PR shows merged but no
   delivery comment ever lands, re-run the deploy manually (`npm run deploy`)
   or re-deliver by hand. If delivery fails, re-stamping an already-`done`
   issue done is a no-op (unchanged status emits no event) — instead click
   **Retry delivery** on the issue's attention banner, which fires a
   `redeliver_requested` event the worker also polls for (SYD-102).
3. **Branch protection on `main`** blocks force-pushes and deletion. Required
   PR reviews stay off for now: all pushes authenticate as one GitHub identity
   and GitHub forbids self-approval — full can't-push-to-main enforcement is
   the SYD-19 (second identity) upgrade path.

Escalations resume fast: when a session calls `request_human_input`, the issue
parks (`needsInput`) until a human answers with a comment. The answer releases
the claim server-side (back to `todo`, unassigned), and the worker's event-feed
poll (`eventPollSeconds`, default 15s) spots the `needs_input_cleared` event and
re-dispatches within seconds — the new session's prompt tells it to read the
answer in the activity feed. If the worker was down when the answer landed, the
regular `intervalSeconds` poll picks the issue up instead.

## The Dreamer

A nightly reflection job (SYD-28): once a night, a headless Claude Code
session reads the last 24h of tracker activity (`GET /api/events`) plus the
full board and triage queue, looks for patterns — review-column latency,
needs-input response gaps, stale/parked issues, recurring themes in what
agents file, board hygiene, error signals, and integration opportunities
(e.g. repeated manual SHA citations that a GitHub link would remove) — and:

1. writes a dated digest to `~/.claude/dreams/switchyard-YYYY-MM-DD.md`
   (counts, top 3-5 ranked observations, open questions — a one-minute read), and
2. files at most 3 concrete, decision-grade findings back into triage
   (after checking they aren't already tracked), each with provenance
   `sourceType: "session"`, `detail: "dreamer nightly YYYY-MM-DD"`.

It never modifies existing issues — read and file only. See
`prompts/dreamer.md` for the full instructions and `scripts/dreamer.sh` for
the runner (modeled on cc-autodream's lean headless-invocation pattern).

Install the nightly schedule (04:30 local time):

```bash
cp launchd/com.switchyard.dreamer.plist ~/Library/LaunchAgents/
# edit the copy: replace REPLACE_WITH_TOKEN with a real actor token
# (npx tsx src/cli.ts switchyard.db add-actor dreamer agent), and check
# SWITCHYARD_URL / WorkingDirectory match your host
launchctl load ~/Library/LaunchAgents/com.switchyard.dreamer.plist
```

Manual run:

```bash
SWITCHYARD_URL=http://localhost:3300 SWITCHYARD_TOKEN=... sh scripts/dreamer.sh
```

Dry run (writes the digest, files nothing):

```bash
SWITCHYARD_URL=http://localhost:3300 SWITCHYARD_TOKEN=... DREAMER_DRY_RUN=1 sh scripts/dreamer.sh
```

## Development

```bash
npm test
npm run typecheck
```

Token-lean architecture maps for coding agents live in `codemaps/`
(generated — regenerate with the `/update-codemaps` skill rather than
hand-editing).
