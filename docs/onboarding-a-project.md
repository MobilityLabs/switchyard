# Onboarding a project onto Switchyard

The steps to put a new repo under Switchyard's dispatch + delivery gate,
written while onboarding the piano game (`NOC`, `~/sites/piano-game`,
github.com/seanperkins/nocturne) on 2026-07-09. Steps marked **[manual gap]**
have no UI, script, or MCP tool yet — they're tracked as issues (see the
"Automation gaps" section at the bottom).

## Prerequisites

- The repo is a git checkout on the worker machine with a GitHub remote
  (`origin`). Private is fine — PRs are opened host-side with your `gh` auth.
- The worker machine already passes `npm run init-worker` for an existing
  project (docker image built, `.env` has `SWITCHYARD_TOKEN` +
  `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`, server reachable).

## Steps

### 1. Create the project on the server **[manual gap: no UI, no MCP tool]**

Pick the key carefully — issue refs (`NOC-1`) are permanent. Today this is a
raw API call (or the CLI on the server host against the live db):

```bash
set -a; source .env; set +a
curl -s -X POST http://100.85.158.109:3300/api/projects \
  -H "Authorization: Bearer $SWITCHYARD_TOKEN" \
  -H "content-type: application/json" \
  -d '{"key":"NOC","name":"Nocturne (piano game)"}'
```

### 2. Add the repo to `switchyard-worker.json` **[manual gap: hand-edited JSON]**

```json
"projects": {
  "SYD": { "repo": "/Users/sean/sites/switchyard" },
  "NOC": { "repo": "/Users/sean/sites/piano-game" }
}
```

If this machine should also open PRs for containerized work, make sure the
delivery block exists:

```json
"delivery": { "openPrs": true }
```

### 3. Validate the chain

```bash
npm run init-worker                # all checks, including the new project's repo
npm run init-worker -- --self-test # one dry-run tick
```

Note the doctor does **not** yet check the delivery-gate prerequisites
(`gh` installed + authenticated, repo has a GitHub remote) **[manual gap]**.

### 4. Branch protection on the repo's `main` **[manual gap: raw gh api call]**

Blocks force-push/deletion; required reviews stay off until there's a second
GitHub identity (SYD-19):

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

### 5. Make sure the MCP registration is user-scoped

`claude mcp add` defaults to **local scope** — private to the directory you
ran it in. A registration made inside the switchyard repo is invisible to
sessions in the new project's repo. Check and fix:

```bash
claude mcp get switchyard   # "Scope: Local config" means only one repo sees it
claude mcp remove --scope local switchyard
claude mcp add --scope user switchyard --transport http http://100.85.158.109:3300/mcp \
  --header "Authorization: Bearer <agent token>"
```

Caveat: running `claude mcp add/remove` while Claude Code sessions are open
can be silently reverted — a live session saving its state rewrites
`~/.claude.json` from stale memory. Verify the scope change stuck
(`claude mcp get switchyard`), and re-apply with sessions closed if not.
Per-person actors (`claude/<name>-dev`) are the recommended token — see
`docs/agent-kit.md`.

### 6. Prime the repo's CLAUDE.md

Add a short section so interactive Claude sessions in that repo actually use
the tracker (pattern from `docs/agent-kit.md`): project key, "check
`next_task` / file discovered work with `file_issue`", and the branch
conventions (`agent/<ref>` is reserved for dispatched workers).

### 7. Restart the loops so the new config loads

The worker reads its config at start — a running loop won't see the new
project. **[manual gap: deliver.ts has no launchd installer]**

```bash
SWITCHYARD_TOKEN=... npx tsx scripts/agent-worker.ts   # dispatch loop
SWITCHYARD_TOKEN=... npx tsx scripts/deliver.ts        # delivery gate loop
```

(Both read the repo `.env` themselves; launchd covers only the dispatch
worker via `npm run init-worker -- --install-launchd`.)

### 8. Smoke-test the full gate

1. File an issue in the new project (UI → New Issue, or `file_issue` via MCP —
   agent filings land in triage).
2. Human: triage it to `todo` (unassigned, no `hold` label under the
   `all-todo` policy; add the configured label instead if the policy is
   `labeled`).
3. Watch the worker dispatch a container (`.superpowers/worker-logs/<ref>.log`
   in the target repo) and, on exit, push `agent/<ref>` + open a PR.
4. Review the PR/branch, then stamp the issue `done` in the UI.
5. deliver.ts merges the PR and comments the merge SHA (deploy is skipped
   automatically for repos with no `deploy` script — e.g. Netlify-built
   nocturne).

## Automation gaps found while onboarding NOC (2026-07-09)

| Gap | Today | Wanted | Tracked |
|-----|-------|--------|---------|
| Project creation | raw `curl` / server-host CLI | UI: new-project form (human-gated, like triage) | SYD-51 |
| Worker config | hand-edit `switchyard-worker.json` | `init-worker --add-project KEY /path` (validates, edits, re-runs doctor) | SYD-52 |
| Delivery-gate checks | not covered by doctor | doctor checks `gh` auth, remote, `delivery` block; `--protect-main` applies branch protection | SYD-53 |
| deliver.ts as a service | run by hand | launchd installer alongside the worker's | SYD-53 |
| Delivery visibility | merge/deploy results are issue comments only | PR link + delivery status surfaced in the UI issue view (pairs with SYD-43 live-sessions panel) | SYD-54 |
| MCP scope check | local-scope registrations silently invisible from other repos; live sessions can revert `claude mcp` edits | doctor warns when the MCP registration isn't user-scoped (fold into SYD-52/53) | doc only (step 5) |
