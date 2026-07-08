#!/bin/sh
# Ship the working tree to the NAS (el-duro-1) and rebuild the container.
# Passwordless: ssh key + scoped sudoers rule for /usr/local/bin/switchyard-deploy.
set -e
cd "$(dirname "$0")/.."
echo "shipping source..."
tar czf - --exclude node_modules --exclude .git --exclude .superpowers --exclude dist \
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude .DS_Store . \
  | ssh 100.85.158.109 'tar xzf - -C mcps/switchyard'
echo "rebuilding container..."
ssh 100.85.158.109 'sudo -n /usr/local/bin/switchyard-deploy'
