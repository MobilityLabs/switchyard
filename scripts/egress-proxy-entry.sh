#!/bin/sh
# Entrypoint for Switchyard's egress-proxy sidecar (SYD-110, see
# Dockerfile.egress-proxy). Renders a default-deny tinyproxy config whose
# domain allowlist comes from ALLOWED_DOMAINS (comma-separated hostnames),
# then execs tinyproxy in the foreground.
#
# Dispatch containers sit on an --internal Docker network with no route out;
# this sidecar (dual-homed: that network + the default bridge) is their only
# exit, so whatever isn't in ALLOWED_DOMAINS is unreachable — including
# wherever a prompt-injected session or malicious npm lifecycle script would
# exfiltrate tokens to.
#
# Overridable for tests (no Docker needed): CONF_DIR (default /etc/tinyproxy),
# TINYPROXY_BIN (default tinyproxy).

set -eu

if [ -z "${ALLOWED_DOMAINS:-}" ]; then
  echo "FATAL: ALLOWED_DOMAINS is required (comma-separated hostnames the proxy may reach)" >&2
  exit 1
fi

CONF_DIR="${CONF_DIR:-/etc/tinyproxy}"
mkdir -p "$CONF_DIR"

# One anchored ERE per hostname: dots escaped, exact match only — "evil
# api.anthropic.com.attacker.net" must not slip past a substring match.
: > "$CONF_DIR/filter"
echo "$ALLOWED_DOMAINS" | tr ',' '\n' | while IFS= read -r domain; do
  [ -n "$domain" ] || continue
  escaped=$(printf '%s' "$domain" | sed 's/\./\\./g')
  printf '^%s$\n' "$escaped" >> "$CONF_DIR/filter"
done

cat > "$CONF_DIR/tinyproxy.conf" <<CONFEOF
Port 8888
Listen 0.0.0.0
Timeout 600
MaxClients 64
FilterType ere
FilterURLs No
FilterDefaultDeny Yes
Filter "$CONF_DIR/filter"
CONFEOF

exec "${TINYPROXY_BIN:-tinyproxy}" -d -c "$CONF_DIR/tinyproxy.conf"
