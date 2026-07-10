#!/usr/bin/env node
// Pre-trusts a workspace directory in Claude Code's global config (SYD-80).
//
// Without this, a headless `claude -p` session in an untrusted workspace
// ignores the repo's own checked-in .claude/settings.json permissions.allow
// entries and gates protected-path writes (.claude/agents/,
// .claude/settings.json) behind an interactive trust/approval prompt --
// which a headless session can never answer, so it stalls and exits with no
// commit, no comment, and no escalation. Writing
// `projects[workspace].hasTrustDialogAccepted: true` into ~/.claude.json is
// the exact remedy Claude Code's own warning names.
//
// Kept as a standalone script (rather than inlined in container-entry.sh)
// so the JSON-merge logic is unit-testable without spinning up a container.
//
// Usage: node prime-workspace-trust.mjs <workspace-path>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: prime-workspace-trust.mjs <workspace-path>");
  process.exit(1);
}

const configPath = `${process.env.HOME ?? homedir()}/.claude.json`;

let config = {};
if (existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, "utf8"));
}

config.projects = config.projects ?? {};
config.projects[workspace] = { ...config.projects[workspace], hasTrustDialogAccepted: true };

writeFileSync(configPath, JSON.stringify(config, null, 2));
