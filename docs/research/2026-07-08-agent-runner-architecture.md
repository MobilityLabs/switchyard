# Local Agent Runner: Decision Brief

**Date:** 2026-07-08 · **For:** SYD-44 (runner setup flow), SYD-43 (agent progress panel)

## Verdicts

| Option | Verdict | Why |
|---|---|---|
| Claude Agent SDK (@anthropic-ai/claude-agent-sdk) | **Adopt** | Streaming SDKMessage events (per-tool-call progress + per-session cost/usage/session_id) are exactly the "agents at work" feed; in-process MCP config (token never on disk/argv); abortController for clean cancel; `resume: sessionId` makes needs-input resume a true resume. Caveats: 0.x churn (pin versions), SDK spawns the CLI locally so containerized mode runs the SDK *inside* the container (NanoClaw-proven shape). |
| CLI `--output-format stream-json` parsing | **Adapt (bridge)** | Same event vocabulary from the existing spawn with zero new deps — the this-week path to live progress; forward-compatible with the SDK move. |
| launchd (worker + notifier KeepAlive; dreamer calendar) | **Adopt** | Native, zero deps, we already ship a plist and solved its PATH/env gotchas. |
| pm2 / forever | **Skip** | pm2 on macOS is a supervisor supervised by launchd (OpenClaw demotes it to fallback); forever unmaintained. |
| Compose restart policies | **Adopt at NAS phase** | server+worker+notifier as one compose file with `restart: unless-stopped`. |
| Gas Town / NanoClaw / OpenClaw as libraries | **Skip code, mine patterns** | All applications, none importable. Steal: Witness heartbeat (session alive, N turns, last tool — distinguishes working from wedged); NanoClaw's host-orchestrator + SDK-runner-in-container shape; OpenClaw's doctor/wizard ops UX. |

## Recommended architecture

Bare mode: `agent-worker.ts` replaces `spawn("claude")` with in-process `query()` — programmatic mcpServers, `permissionMode: acceptEdits`, allowedTools from config, abortController per dispatch. Containerized (default): keep `docker run`, replace container-entry's `claude -p` with a ~100-line SDK `agent-runner.ts` emitting one NDJSON progress line per event; host worker parses the stream, appends the log, and forwards digested events (`session_started`, `tool_call`, `turn_completed`, `result` w/ cost) to `POST /api/agent-sessions/:ref/progress` → events feed + small SSE endpoint → UI "agents at work" panel. Capture `session_id` for true resume on answered escalations. `active` becomes `Map<ref, {abort, sessionId, lastEvent}>` enabling a stuck-session watchdog. Supervision: two more launchd plists now; compose at NAS phase. Setup: `switchyard init-worker` = doctor checks (claude/SDK, auth env, docker, server reachable+token valid, image built) + interactive config + plist install + dry-run self-test + "label an issue auto to start"; idempotent.

## Sources
- Agent SDK TS reference: https://code.claude.com/docs/en/agent-sdk/typescript · streaming modes: https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode · resume-history gap: https://github.com/anthropics/claude-agent-sdk-typescript/issues/14 · npm 0.3.204 (2026-07-08)
- Gas Town: https://github.com/steveyegge/gastown · https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 · https://paddo.dev/blog/gastown-two-kinds-of-multi-agent/
- NanoClaw agent-runner: https://github.com/qwibitai/nanoclaw
- OpenClaw daemon/wizard/doctor: https://docs.openclaw.ai/gateway · https://docs.openclaw.ai/reference/wizard · pm2-fallback: https://github.com/openclaw/openclaw/issues/21511
