#!/bin/sh
# Container entrypoint for Switchyard's containerized dispatch mode (SYD-30).
#
# Runs inside a disposable Docker container (see ../Dockerfile.worker): clones
# the host repo (mounted read-write at /origin) into /work, checks out a
# fresh branch, runs a headless Claude Code session against the clone, and
# pushes the branch back to /origin if the session produced any commits. The
# container has no access to the host filesystem beyond the /origin mount,
# and only ever pushes agent/<ref> branches — merging to main stays a human
# decision made outside the container.
#
# Required env:
#   ISSUE_REF                e.g. "SYD-30"
#   SWITCHYARD_URL            base URL of the switchyard server
#   SWITCHYARD_TOKEN          bearer token for the switchyard MCP tool
#   WORKER_PROMPT             the prompt handed to `claude -p`
#   ALLOWED_TOOLS             comma-separated tool allowlist for `claude`
#   CLAUDE_CODE_OAUTH_TOKEN   OAuth token from `claude setup-token` -- or --
#   ANTHROPIC_API_KEY         an Anthropic API key (one of the two is required)
#
# Optional env:
#   STACK_CHECKS              JSON array of {name, check, install} (SYD-76) --
#                             verified before claude -p runs; see stack-check.mjs
#   BASE_BRANCH               integration branch to base agent/<ref> on (default "main")
#   MODE                      "work" (default) or "resolve-conflict" (SYD-100)
#
# MODE=resolve-conflict (SYD-100): dispatched by scripts/deliver.ts when a
# mechanical rebase-onto-main hits real conflict hunks, instead of a fresh
# branch cut from BASE_BRANCH the session continues an EXISTING agent/<ref>
# branch (AGENT_BRANCH, required in this mode) so it can rebase and resolve
# the conflicts itself -- a script has no intent to resolve them with, only a
# session does. The session pushes its own resolution (no commit-count gate);
# the entrypoint's only job afterward is to fail loudly if a rebase was left
# unresolved.
#
# Host repo mounted read-write at /origin.

set -eu

MODE="${MODE:-work}"

: "${ISSUE_REF:?ISSUE_REF is required}"
: "${SWITCHYARD_URL:?SWITCHYARD_URL is required}"
: "${SWITCHYARD_TOKEN:?SWITCHYARD_TOKEN is required}"
: "${WORKER_PROMPT:?WORKER_PROMPT is required}"
: "${ALLOWED_TOOLS:?ALLOWED_TOOLS is required}"
if [ "$MODE" = "resolve-conflict" ]; then
  : "${AGENT_BRANCH:?AGENT_BRANCH is required when MODE=resolve-conflict}"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL: one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set" >&2
  exit 1
fi

# Bind mounts on plain-Linux Docker preserve host UIDs; without this, git
# refuses the clone with "detected dubious ownership".
git config --global --add safe.directory /origin

git clone /origin /work
cd /work

# Pre-trust the workspace (SYD-80): otherwise Claude Code treats /work as
# untrusted, ignores the repo's own checked-in .claude/settings.json
# permissions.allow entries, and gates protected-path writes (.claude/agents/,
# .claude/settings.json) behind an interactive approval prompt a headless
# session can never answer -- it just stalls and exits with nothing. The
# container is already the sandbox boundary (see the allowedTools note
# below), so there's no separate trust boundary left to enforce here.
node /prime-workspace-trust.mjs /work

BASE_BRANCH="${BASE_BRANCH:-main}"
if [ "$MODE" = "resolve-conflict" ]; then
  # Continue the EXISTING agent branch instead of cutting a fresh one -- it
  # already carries the reviewed work; only the conflict resolution is new.
  git fetch origin "$AGENT_BRANCH"
  git checkout -B "$AGENT_BRANCH" FETCH_HEAD
  # Fetched (not rebased here) so origin/$BASE_BRANCH exists for the session
  # to rebase onto itself -- resolving the conflict needs intent a script
  # doesn't have.
  git fetch origin "$BASE_BRANCH"
else
  # Explicitly base the work branch on BASE_BRANCH (default "main") rather than
  # the clone's checked-out HEAD -- a plain `git clone` of a local repo hands
  # back whatever branch the host happened to have checked out at clone time,
  # which is nondeterministic from the container's point of view.
  git fetch origin "$BASE_BRANCH"
  git checkout -b "agent/$ISSUE_REF" "origin/$BASE_BRANCH"
fi

# Recorded after the branch is set up, so the commit count below (work mode
# only) reflects only what the session itself produced.
INITIAL_HEAD=$(git rev-parse HEAD)

git config user.name "switchyard-worker"
git config user.email "worker@switchyard.local"

if [ -f package.json ]; then
  node /npm-ci-guard.mjs /work
fi

# Stack guarantee (SYD-76): fail fast with a clear message if this project
# declared CLI tools (STACK_CHECKS) that this image doesn't have, instead of
# the session discovering it mid-task.
if [ -n "${STACK_CHECKS:-}" ] && [ -f scripts/stack-check.mjs ]; then
  node scripts/stack-check.mjs || exit 1
fi

# Written as a file rather than `claude mcp add --header ...` so the bearer
# token never appears in any process argv (visible via ps / docker top).
cat > /tmp/switchyard-mcp.json <<MCPEOF
{
  "mcpServers": {
    "switchyard": {
      "type": "http",
      "url": "$SWITCHYARD_URL/mcp",
      "headers": { "Authorization": "Bearer $SWITCHYARD_TOKEN" }
    }
  }
}
MCPEOF
chmod 600 /tmp/switchyard-mcp.json

# The container is the sandbox here, not the tool allowlist -- a generous
# allowlist inside a disposable, network-scoped clone is fine.
set +e
claude -p "$WORKER_PROMPT" --mcp-config /tmp/switchyard-mcp.json --permission-mode acceptEdits --allowedTools "$ALLOWED_TOOLS"
CLAUDE_EXIT=$?
set -e

if [ "$MODE" = "resolve-conflict" ]; then
  # The prompt has the session push its own resolution (a force-push-with-lease
  # of a rebased branch, not a fast-forward the commit-count gate below could
  # detect) -- the entrypoint's only remaining job is to fail loudly if a
  # rebase was left mid-flight, so a stalled/misbehaving session can never be
  # mistaken for a resolved one.
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    echo "conflict-resolution session left the rebase unresolved -- aborting" >&2
    git rebase --abort || true
    exit 1
  fi
  exit "$CLAUDE_EXIT"
fi

COMMIT_COUNT=$(git rev-list "$INITIAL_HEAD"..HEAD --count)
if [ "$COMMIT_COUNT" -gt 0 ]; then
  git push origin "agent/$ISSUE_REF"
  echo "pushed branch agent/$ISSUE_REF with $COMMIT_COUNT commit(s)"
else
  echo "no commits produced"
fi

exit "$CLAUDE_EXIT"
