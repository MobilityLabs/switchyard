# Switchyard

Self-hosted, agent-native project tracker. Humans plan on a shared board;
Claude Code agents file, triage, claim, and work issues through MCP —
gated by human triage, with provenance on everything.

Spec: `docs/superpowers/specs/2026-07-07-switchyard-design.md`

## Quick start

```bash
npm install
npx tsx src/cli.ts switchyard.db add-project AIPI "aipi benchmarking"
npx tsx src/cli.ts switchyard.db add-actor sean human
npx tsx src/cli.ts switchyard.db add-actor claude/worker agent
npm run dev   # listens on :3300
```

## Connect Claude Code

```bash
claude mcp add switchyard --transport http http://localhost:3300/mcp \
  --header "Authorization: Bearer <token from add-actor>"
```

Tools: `list_projects`, `get_issue`, `search_issues`, `next_task`,
`file_issue`, `claim_issue`, `update_issue`, `comment`, `triage_queue`,
`add_dependency`.

## Development

```bash
npm test
```
