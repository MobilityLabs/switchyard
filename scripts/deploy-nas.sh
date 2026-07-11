#!/bin/sh
# Ship the working tree to the NAS (el-duro-1) and rebuild the container.
# Passwordless: ssh key + scoped sudoers rule for /usr/local/bin/switchyard-deploy.
#
# Host defaults to the Tailscale IP below; override with SWITCHYARD_NAS_HOST.
#
# Rollback: pass a git ref to ship that commit's tree instead of the working
# tree, e.g. `scripts/deploy-nas.sh <previous-good-sha>` — one command to
# recover from a bad deploy without touching the NAS by hand.
set -e
cd "$(dirname "$0")/.."

NAS_HOST="${SWITCHYARD_NAS_HOST:-100.85.158.109}"
REF="$1"

echo "shipping source..."
if [ -n "$REF" ]; then
  if ! git rev-parse --verify -q "$REF^{commit}" >/dev/null; then
    echo "error: '$REF' is not a valid git ref" >&2
    exit 1
  fi
  echo "  rolling back to $(git rev-parse --short "$REF") ($REF)"
  git archive --format=tar "$REF" | gzip \
    | ssh "$NAS_HOST" 'tar xzf - -C mcps/switchyard'
else
  tar czf - --exclude node_modules --exclude .git --exclude .superpowers --exclude dist \
    --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude .DS_Store \
    --exclude .env --exclude switchyard-worker.json . \
    | ssh "$NAS_HOST" 'tar xzf - -C mcps/switchyard'
fi
echo "rebuilding container..."
ssh "$NAS_HOST" 'sudo -n /usr/local/bin/switchyard-deploy'
