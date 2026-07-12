#!/bin/sh
# Entrypoint for Switchyard's egress-proxy sidecar (SYD-186, see
# Dockerfile.egress-proxy). Runs mitmproxy (mitmdump) with the
# credential-injection + allowlist addon (scripts/egress-inject-addon.py):
# provider hosts are MITM'd and the real credential injected, allowlisted
# non-provider hosts tunnel un-intercepted, everything else is refused.
# Replaces the previous tinyproxy config (which only allowlisted — it could
# not inject credentials).
#
# Dispatch containers sit on an --internal Docker network with no route out;
# this sidecar (dual-homed: that network + the default bridge) is their only
# exit. The real provider keys and the CA *private* key live only here; agent
# containers hold only a placeholder credential + the CA *public* cert.
#
# The addon reads its policy inputs straight from this container's env:
#   ALLOWED_DOMAINS         comma-separated hostnames the proxy may tunnel to
#   CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
#                           the real provider credentials to inject
#
# The CA is generated once by mitmproxy into CONFDIR and persisted via a
# mounted volume, so it survives sidecar recreation (agent containers must keep
# trusting the same CA across dispatches — never regenerate it).
#
# Overridable for tests (no Docker needed): CONFDIR (default
# /home/mitmproxy/.mitmproxy), ADDON (default /egress-inject-addon.py),
# MITMDUMP_BIN (default mitmdump).

set -eu

if [ -z "${ALLOWED_DOMAINS:-}" ]; then
  echo "FATAL: ALLOWED_DOMAINS is required (comma-separated hostnames the proxy may reach)" >&2
  exit 1
fi

CONFDIR="${CONFDIR:-/home/mitmproxy/.mitmproxy}"
ADDON="${ADDON:-/egress-inject-addon.py}"
mkdir -p "$CONFDIR"

# --set block_global=false: our clients connect from the internal Docker
#   network (private IPs); don't reject them as "global".
# --set confdir: pin the persisted CA location (mitmdump generates the CA here
#   on first run and reuses it thereafter).
# Upstream cert verification stays at mitmproxy's secure default (no
# --ssl-insecure) — the proxy still validates the real provider's certificate.
exec "${MITMDUMP_BIN:-mitmdump}" \
  --listen-host 0.0.0.0 \
  --listen-port 8888 \
  --set confdir="$CONFDIR" \
  --set block_global=false \
  -s "$ADDON"
