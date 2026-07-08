#!/bin/bash
# The Dreamer — nightly reflection job for Switchyard (SYD-28).
#
# Runs a single headless `claude -p` session against prompts/dreamer.md: it
# reads the last 24h of tracker activity plus the full board via the REST
# API (curl), analyzes for friction/opportunity patterns, writes a dated
# digest, and files at most a few concrete findings back into triage.
# Invocation flags follow cc-autodream's lean-query pattern (see
# /Users/sean/sites/cc-autodream/bin/run.sh and its CLAUDE.md) adapted to a
# single call instead of a two-layer fanout: strip per-call bloat (hooks,
# skills, MCP, CLAUDE.md auto-load) while keeping subscription/OAuth auth.
#
# Usage:
#   sh scripts/dreamer.sh
#   DREAMER_DRY_RUN=1 sh scripts/dreamer.sh   # write the digest, file nothing
#
# Required env:
#   SWITCHYARD_URL     base URL of the running switchyard server
#   SWITCHYARD_TOKEN   bearer token for an actor registered via add-actor
#
# Optional env:
#   CLAUDE_BIN         path to claude CLI                  default: $HOME/.local/bin/claude
#   DREAMS_DIR         where the dated digest is written    default: $HOME/.claude/dreams
#   DREAMER_DRY_RUN    set 1 to skip filing issues           default: unset (files findings)

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
DREAMS_DIR="${DREAMS_DIR:-$HOME/.claude/dreams}"
LOG_FILE="$DREAMS_DIR/switchyard-dreamer.log"

mkdir -p "$DREAMS_DIR"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"; }

if [ -z "${SWITCHYARD_URL:-}" ] || [ -z "${SWITCHYARD_TOKEN:-}" ]; then
  log "FATAL: SWITCHYARD_URL and SWITCHYARD_TOKEN must both be set"
  exit 1
fi

if [ ! -x "$CLAUDE_BIN" ]; then
  log "FATAL: claude not found at $CLAUDE_BIN (set CLAUDE_BIN to override)"
  exit 1
fi

cd "$REPO_DIR" || { log "FATAL: cannot cd to $REPO_DIR"; exit 1; }

export DREAMS_DIR
export DREAMER_DATE
DREAMER_DATE=$(date +%Y-%m-%d)
# Unix epoch ~24h ago, for the events feed's ?since=. macOS `date -v`, GNU `date -d` fallback.
export DREAMER_SINCE
DREAMER_SINCE=$(date -v-24H +%s 2>/dev/null || date -d '24 hours ago' +%s)

PROMPT=$(cat "$REPO_DIR/prompts/dreamer.md")
if [ "${DREAMER_DRY_RUN:-0}" != "0" ]; then
  PROMPT="$PROMPT

DRY RUN: write the digest but do NOT file any issues."
fi

log "starting dreamer run for $DREAMER_DATE (since=$DREAMER_SINCE, dry_run=${DREAMER_DRY_RUN:-0})"

# Strip per-call bloat but keep OAuth/subscription auth (do NOT switch to
# --bare / CLAUDE_CODE_SIMPLE=1 — those break keychain auth, see autodream's
# CLAUDE.md). bypassPermissions is required for an unattended Bash+Write session.
export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1

"$CLAUDE_BIN" -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --tools Bash Write \
  --disable-slash-commands \
  --strict-mcp-config \
  --settings '{"disableAllHooks":true}' \
  --append-system-prompt "Headless nightly reflection worker for Switchyard. Read via Bash/curl against \$SWITCHYARD_URL with \$SWITCHYARD_TOKEN; write the digest via the Write tool to the literal path \$DREAMS_DIR/switchyard-\$DREAMER_DATE.md. Never call a route that mutates an existing issue — read and file only." \
  >> "$LOG_FILE" 2>&1
RC=$?

if [ "$RC" -eq 0 ]; then
  log "dreamer run finished ok"
else
  log "dreamer run FAILED (exit $RC)"
fi

exit "$RC"
