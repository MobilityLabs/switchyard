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
# Host repo mounted read-write at /origin.

set -eu

: "${ISSUE_REF:?ISSUE_REF is required}"
: "${SWITCHYARD_URL:?SWITCHYARD_URL is required}"
: "${SWITCHYARD_TOKEN:?SWITCHYARD_TOKEN is required}"
: "${WORKER_PROMPT:?WORKER_PROMPT is required}"
: "${ALLOWED_TOOLS:?ALLOWED_TOOLS is required}"

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

# Recorded before any work happens, so we can tell afterwards whether the
# session produced commits worth pushing.
INITIAL_HEAD=$(git rev-parse HEAD)

git checkout -b "agent/$ISSUE_REF"
git config user.name "switchyard-worker"
git config user.email "worker@switchyard.local"

if [ -f package.json ]; then
  npm ci || echo "WARNING: npm ci failed -- continuing without installed dependencies" >&2
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

COMMIT_COUNT=$(git rev-list "$INITIAL_HEAD"..HEAD --count)
if [ "$COMMIT_COUNT" -gt 0 ]; then
  git push origin "agent/$ISSUE_REF"
  echo "pushed branch agent/$ISSUE_REF with $COMMIT_COUNT commit(s)"
else
  echo "no commits produced"
fi

exit "$CLAUDE_EXIT"
