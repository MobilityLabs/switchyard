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
# Runs are launchd-scheduled hourly from 04:30 to 11:30 (see
# launchd/com.switchyard.dreamer.plist) so a laptop that's offline or a
# session that hangs at 04:30 gets retried instead of silently losing the
# whole night (SYD-61). A run is skipped once today's digest has already
# succeeded (tracked via an .ok marker next to the digest), so the hourly
# retries are a no-op once one run gets through. The claude invocation itself
# is wrapped in a timeout so a hung session (ConnectionRefused etc.) doesn't
# burn hours before the next scheduled retry, and any failed/timed-out run
# appends a FAILED note to the digest file itself, not just the log, so the
# miss is visible where a human actually looks.
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
#   CLAUDE_BIN               path to claude CLI                default: $HOME/.local/bin/claude
#   DREAMS_DIR                where the dated digest is written default: $HOME/.claude/dreams
#   DREAMER_DRY_RUN           set 1 to skip filing issues       default: unset (files findings)
#   DREAMER_TIMEOUT_SECONDS   kill a hung claude session        default: 1800 (30 min)

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

DIGEST_FILE="$DREAMS_DIR/switchyard-$DREAMER_DATE.md"
OK_MARKER="$DREAMS_DIR/.switchyard-$DREAMER_DATE.ok"
TIMEOUT_MARKER="$DREAMS_DIR/.dreamer-timeout-marker"
DREAMER_TIMEOUT_SECONDS="${DREAMER_TIMEOUT_SECONDS:-1800}"

if [ -f "$OK_MARKER" ]; then
  log "already succeeded for $DREAMER_DATE, skipping (hourly retry no-op)"
  exit 0
fi

append_failure_note() {
  note_rc=$1
  note_kind=$2
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  note="**FAILED** — dreamer run for $DREAMER_DATE did not complete ($note_kind, exit $note_rc) at $ts. No digest was generated this run. See $LOG_FILE for details."
  if [ ! -f "$DIGEST_FILE" ]; then
    printf '# Switchyard dreamer — %s\n\n%s\n' "$DREAMER_DATE" "$note" > "$DIGEST_FILE"
  else
    printf '\n%s\n' "$note" >> "$DIGEST_FILE"
  fi
}

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

rm -f "$TIMEOUT_MARKER"

"$CLAUDE_BIN" -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --tools Bash Write \
  --disable-slash-commands \
  --strict-mcp-config \
  --settings '{"disableAllHooks":true}' \
  --append-system-prompt "Headless nightly reflection worker for Switchyard. Read via Bash/curl against \$SWITCHYARD_URL with \$SWITCHYARD_TOKEN; write the digest via the Write tool to the literal path \$DREAMS_DIR/switchyard-\$DREAMER_DATE.md. Never call a route that mutates an existing issue — read and file only." \
  >> "$LOG_FILE" 2>&1 &
CLAUDE_PID=$!

(
  sleep "$DREAMER_TIMEOUT_SECONDS"
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    touch "$TIMEOUT_MARKER"
    kill "$CLAUDE_PID" 2>/dev/null
    sleep 5
    kill -9 "$CLAUDE_PID" 2>/dev/null
  fi
) </dev/null >/dev/null 2>&1 &
WATCHER_PID=$!

wait "$CLAUDE_PID"
RC=$?

# Watcher is done its job once the main process exits; reap it quietly.
kill "$WATCHER_PID" 2>/dev/null
wait "$WATCHER_PID" 2>/dev/null

if [ -f "$TIMEOUT_MARKER" ]; then
  rm -f "$TIMEOUT_MARKER"
  log "dreamer run TIMED OUT after ${DREAMER_TIMEOUT_SECONDS}s (exit $RC)"
  append_failure_note "$RC" "timed out after ${DREAMER_TIMEOUT_SECONDS}s"
  exit 1
fi

if [ "$RC" -eq 0 ]; then
  log "dreamer run finished ok"
  touch "$OK_MARKER"
else
  log "dreamer run FAILED (exit $RC)"
  append_failure_note "$RC" "non-zero exit"
fi

exit "$RC"
