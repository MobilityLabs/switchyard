#!/bin/sh
# Container entrypoint for Switchyard's Gemini engine (SYD-225) -- the gemini
# counterpart of container-entry.sh (SYD-30) / container-entry.codex.sh
# (SYD-187). Same contract: clone the host repo (mounted read-write at /origin)
# into /work, check out a fresh agent/<ref> branch, run a headless gemini
# session against the clone, and push the branch back to /origin if the session
# produced any commits. The container has no access to the host filesystem
# beyond the /origin mount, and only ever pushes agent/<ref> branches -- merging
# to main stays a human decision made outside the container.
#
# Auth is a static AI-Studio API key: the real GEMINI_API_KEY lives only in the
# syd-egress sidecar, which injects it as the x-goog-api-key header for
# generativelanguage.googleapis.com via MITM (SYD-186, rule already provisioned);
# this container holds only the CA public cert (read-only mount at /ca) and a
# placeholder GEMINI_API_KEY, never the real key.
#
# Required env:
#   ISSUE_REF                e.g. "SYD-225"
#   SWITCHYARD_URL            base URL of the switchyard server
#   SWITCHYARD_TOKEN          bearer token for the switchyard MCP tool
#   WORKER_PROMPT             the prompt handed to `gemini`
#   GEMINI_API_KEY            AI-Studio key (placeholder in proxy mode; real in open mode)
#
# Optional env:
#   SWITCHYARD_LEASE          session-scoped lease (SYD-210); added as the
#                             X-Switchyard-Lease MCP header when present
#   STACK_CHECKS              JSON array of {name, check, install} (SYD-76)
#   BASE_BRANCH               integration branch to base agent/<ref> on (default "main")
#
# Host repo mounted read-write at /origin.

set -eu

: "${ISSUE_REF:?ISSUE_REF is required}"
: "${SWITCHYARD_URL:?SWITCHYARD_URL is required}"
: "${SWITCHYARD_TOKEN:?SWITCHYARD_TOKEN is required}"
: "${WORKER_PROMPT:?WORKER_PROMPT is required}"
: "${GEMINI_API_KEY:?GEMINI_API_KEY is required (placeholder in proxy mode)}"

# Trust the egress proxy's CA so the container's intercepted TLS to
# generativelanguage.googleapis.com verifies (SYD-186). gemini-cli is Node, so
# NODE_EXTRA_CA_CERTS covers it directly -- no system trust store install
# (update-ca-certificates) needed, unlike codex's SSL_CERT_FILE path.
if [ -f /ca/mitmproxy-ca-cert.pem ]; then
  export NODE_EXTRA_CA_CERTS=/ca/mitmproxy-ca-cert.pem
fi

# Bind mounts on plain-Linux Docker preserve host UIDs; without this, git
# refuses the clone with "detected dubious ownership".
git config --global --add safe.directory /origin

git clone /origin /work
cd /work

# Pre-trust the workspace (SYD-80): kept for parity with the other entry
# scripts -- prime-workspace-trust only touches .claude/settings.json
# permissions, harmless on a gemini-only session.
node /prime-workspace-trust.mjs /work

# Explicitly base the work branch on BASE_BRANCH (default "main") rather than
# the clone's checked-out HEAD -- a plain `git clone` of a local repo hands back
# whatever branch the host happened to have checked out at clone time.
BASE_BRANCH="${BASE_BRANCH:-main}"
git fetch origin "$BASE_BRANCH"
git checkout -b "agent/$ISSUE_REF" "origin/$BASE_BRANCH"

# Recorded after the branch is set up, so the commit count below reflects only
# what the session itself produced.
INITIAL_HEAD=$(git rev-parse HEAD)

git config user.name "switchyard-worker"
git config user.email "worker@switchyard.local"

if [ -f package.json ]; then
  node /npm-ci-guard.mjs /work
fi

# Stack guarantee (SYD-76): fail fast if this project declared CLI tools this
# image doesn't have, instead of the session discovering it mid-task.
if [ -n "${STACK_CHECKS:-}" ] && [ -f scripts/stack-check.mjs ]; then
  node scripts/stack-check.mjs || exit 1
fi

# gemini-cli reads MCP config + auth mode from $HOME/.gemini/settings.json
# (os.homedir()/.gemini). It expands ${VAR} in settings values, so the
# switchyard bearer token and the session lease are written as ENV REFERENCES,
# never their values -- the value stays in the env (like SWITCHYARD_TOKEN
# already is), out of the file and out of argv (parity with codex's
# bearer_token_env_var / env_http_headers, SYD-220). selectedType picks API-key
# auth non-interactively (with GEMINI_DEFAULT_AUTH_TYPE from buildDockerArgs).
mkdir -p "$HOME/.gemini"
# X-Switchyard-Lease only under lease enforcement (SYD-210); absent otherwise.
if [ -n "${SWITCHYARD_LEASE:-}" ]; then
  _LEASE_HEADER=',
        "X-Switchyard-Lease": "${SWITCHYARD_LEASE}"'
else
  _LEASE_HEADER=''
fi
cat > "$HOME/.gemini/settings.json" <<SETTINGSEOF
{
  "security": { "auth": { "selectedType": "gemini-api-key" } },
  "mcpServers": {
    "switchyard": {
      "httpUrl": "$SWITCHYARD_URL/mcp",
      "headers": {
        "Authorization": "Bearer \${SWITCHYARD_TOKEN}"$_LEASE_HEADER
      }
    }
  }
}
SETTINGSEOF
chmod 600 "$HOME/.gemini/settings.json"

# Headless full-auto: the container is the sandbox, so --yolo auto-approves and
# --prompt runs one non-interactive turn. SWITCHYARD_TOKEN / SWITCHYARD_LEASE
# stay exported so gemini expands them into the MCP headers at connect time.
set +e
gemini --yolo --prompt "$WORKER_PROMPT" < /dev/null
GEMINI_EXIT=$?
set -e

COMMIT_COUNT=$(git rev-list "$INITIAL_HEAD"..HEAD --count)
if [ "$COMMIT_COUNT" -gt 0 ]; then
  git push origin "agent/$ISSUE_REF"
  echo "pushed branch agent/$ISSUE_REF with $COMMIT_COUNT commit(s)"
else
  echo "no commits produced"
fi

exit "$GEMINI_EXIT"
