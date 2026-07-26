#!/bin/sh
# Container entrypoint for Switchyard's Codex engine (SYD-187) -- the
# codex-exec counterpart of container-entry.sh (SYD-30). Same contract: clone
# the host repo (mounted read-write at /origin) into /work, check out a fresh
# agent/<ref> branch, run a headless codex session against the clone, and push
# the branch back to /origin if the session produced any commits. The
# container has no access to the host filesystem beyond the /origin mount,
# and only ever pushes agent/<ref> branches -- merging to main stays a human
# decision made outside the container.
#
# Auth is the user's ChatGPT subscription login: the real OAuth token lives
# only in the syd-egress sidecar, which injects it via MITM (SYD-186); this
# container holds only the CA public cert (read-only mount at /ca) and a
# placeholder auth.json carrying the real (non-secret) account_id, never the
# real token.
#
# Required env:
#   ISSUE_REF                e.g. "SYD-187"
#   SWITCHYARD_URL            base URL of the switchyard server
#   SWITCHYARD_TOKEN          bearer token for the switchyard MCP tool
#   WORKER_PROMPT             the prompt handed to `codex exec`
#   CODEX_ACCOUNT_ID          non-secret ChatGPT account UUID (placeholder auth.json)
#
# Optional env:
#   STACK_CHECKS              JSON array of {name, check, install} (SYD-76) --
#                             verified before codex exec runs; see stack-check.mjs
#   BASE_BRANCH               integration branch to base agent/<ref> on (default "main")
#
# Host repo mounted read-write at /origin.

set -eu

: "${ISSUE_REF:?ISSUE_REF is required}"
: "${SWITCHYARD_URL:?SWITCHYARD_URL is required}"
: "${SWITCHYARD_TOKEN:?SWITCHYARD_TOKEN is required}"
: "${WORKER_PROMPT:?WORKER_PROMPT is required}"
: "${CODEX_ACCOUNT_ID:?CODEX_ACCOUNT_ID is required (the non-secret ChatGPT account UUID)}"

# Trust the egress proxy's CA so the container's intercepted TLS to
# chatgpt.com verifies (SYD-186). The syd-egress sidecar MITMs the ChatGPT
# host with a leaf cert signed by its own CA and injects the real OAuth
# token; this container holds only the CA *public* cert (read-only mount at
# /ca) plus a placeholder auth.json, never the real token. Codex (Rust)
# honors SSL_CERT_FILE directly -- unlike the Node-based Claude Code CLI
# (NODE_EXTRA_CA_CERTS in container-entry.sh), there's no system trust store
# install needed here (spike, Task 1).
if [ -f /ca/mitmproxy-ca-cert.pem ]; then
  # Trust the egress-proxy CA additively (system roots + the MITM CA) so codex
  # verifies both the intercepted chatgpt.com AND any real-cert host it reaches.
  cat /etc/ssl/certs/ca-certificates.crt /ca/mitmproxy-ca-cert.pem > /tmp/ca-bundle.pem 2>/dev/null \
    || cp /ca/mitmproxy-ca-cert.pem /tmp/ca-bundle.pem
  export SSL_CERT_FILE=/tmp/ca-bundle.pem
fi

# Bind mounts on plain-Linux Docker preserve host UIDs; without this, git
# refuses the clone with "detected dubious ownership".
git config --global --add safe.directory /origin

git clone /origin /work
cd /work

# Pre-trust the workspace (SYD-80): otherwise Claude Code treats /work as
# untrusted (kept for parity with container-entry.sh -- prime-workspace-trust
# only touches .claude/settings.json permissions, which is harmless even on a
# codex-only session).
node /prime-workspace-trust.mjs /work

# Explicitly base the work branch on BASE_BRANCH (default "main") rather than
# the clone's checked-out HEAD -- a plain `git clone` of a local repo hands
# back whatever branch the host happened to have checked out at clone time,
# which is nondeterministic from the container's point of view.
BASE_BRANCH="${BASE_BRANCH:-main}"
git fetch origin "$BASE_BRANCH"
git checkout -b "agent/$ISSUE_REF" "origin/$BASE_BRANCH"

# Recorded after the branch is set up, so the commit count below reflects
# only what the session itself produced.
INITIAL_HEAD=$(git rev-parse HEAD)

git config user.name "switchyard-worker"
git config user.email "worker@switchyard.local"

if [ -f package.json ]; then
  node /install-guard.mjs /work
fi

# Stack guarantee (SYD-76): fail fast with a clear message if this project
# declared CLI tools (STACK_CHECKS) that this image doesn't have, instead of
# the session discovering it mid-task.
if [ -n "${STACK_CHECKS:-}" ] && [ -f scripts/stack-check.mjs ]; then
  node scripts/stack-check.mjs || exit 1
fi

# Codex reads MCP config + auth from $CODEX_HOME (not a CLI flag). The token
# NAME (not value) goes in config.toml, so the bearer never appears in the
# file or in argv (parity with container-entry.sh's /tmp/switchyard-mcp.json
# approach for Claude). The placeholder auth.json carries the REAL account_id
# (non-secret -- codex sends it as the chatgpt-account-id header, which the
# backend matches against the injected token's account); the proxy injects the
# real Authorization: Bearer over the wire.
export CODEX_HOME=/tmp/codex-home
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<TOMLEOF
[mcp_servers.switchyard]
url = "$SWITCHYARD_URL/mcp"
bearer_token_env_var = "SWITCHYARD_TOKEN"
TOMLEOF
# SYD-220: under lease enforcement (SYD-210) the host mints a session-scoped
# lease the session must present as the X-Switchyard-Lease MCP header on its
# claim-scoped writes (update_issue / in_review / request_human_input). codex
# 0.144.x's env_http_headers names an env var (never its value) to source a
# custom header -- exact parity with bearer_token_env_var above. Unlike the
# Claude path (container-entry.sh bakes the value into a 0600 headers file, then
# unsets the env), codex reads SWITCHYARD_LEASE from the ENV at connect time, so
# it must stay exported below -- the NAME lives in config.toml, the value never
# touches the file or argv (same property as SWITCHYARD_TOKEN). Absent for
# answer/non-lease sessions, so codex sends no lease header then.
if [ -n "${SWITCHYARD_LEASE:-}" ]; then
  printf 'env_http_headers = { "X-Switchyard-Lease" = "SWITCHYARD_LEASE" }\n' >> "$CODEX_HOME/config.toml"
fi
chmod 600 "$CODEX_HOME/config.toml"

# codex PARSES the tokens in auth.json as JWTs locally before sending them, so a
# literal "placeholder" string is rejected ("invalid ID token format"). The
# placeholder must be a VALID-FORMAT dummy JWT (header.payload.sig, base64url).
# A far-future exp stops codex attempting a refresh (which the dummy refresh
# token can't satisfy); the real (non-secret) account_id claim matches the
# injected token's account. The dummy carries no credential -- the proxy still
# replaces Authorization with the real bearer. (Confirmed live, SYD-187 go-live.)
_b64url() { base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }
_jwt_hdr=$(printf '%s' '{"alg":"none","typ":"JWT"}' | _b64url)
_jwt_pay=$(printf '{"iss":"https://auth.openai.com","aud":["https://api.openai.com/v1"],"exp":9999999999,"iat":1700000000,"https://api.openai.com/auth":{"chatgpt_account_id":"%s","chatgpt_plan_type":"plus","user_id":"user-placeholder"}}' "$CODEX_ACCOUNT_ID" | _b64url)
_dummy_jwt="$_jwt_hdr.$_jwt_pay.c2ln"
cat > "$CODEX_HOME/auth.json" <<AUTHEOF
{"OPENAI_API_KEY":null,"tokens":{"id_token":"$_dummy_jwt","access_token":"$_dummy_jwt","refresh_token":"rt-placeholder","account_id":"$CODEX_ACCOUNT_ID"},"last_refresh":"2026-07-07T00:00:00Z"}
AUTHEOF
chmod 600 "$CODEX_HOME/auth.json"

# The container is the sandbox here, not codex's own approval/sandbox layer
# -- headless full-auto is fine inside a disposable, network-scoped clone.
# Spike (Task 1): codex 0.142.5 dropped `--ask-for-approval`; the headless
# full-auto flag is --dangerously-bypass-approvals-and-sandbox.
set +e
codex exec --dangerously-bypass-approvals-and-sandbox "$WORKER_PROMPT" < /dev/null
CODEX_EXIT=$?
set -e

COMMIT_COUNT=$(git rev-list "$INITIAL_HEAD"..HEAD --count)
if [ "$COMMIT_COUNT" -gt 0 ]; then
  git push origin "agent/$ISSUE_REF"
  echo "pushed branch agent/$ISSUE_REF with $COMMIT_COUNT commit(s)"
else
  echo "no commits produced"
fi

exit "$CODEX_EXIT"
