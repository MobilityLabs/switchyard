#!/usr/bin/env node
// Session-start guard for containerized dispatch (SYD-76): runs before
// `claude -p` starts so a missing stack tool fails fast with a clear message
// instead of the session discovering the gap mid-task. STACK_CHECKS is a JSON
// array of { name, check, install } built by stackChecksEnv (worker-select.ts)
// from the dispatching project's switchyard-worker.json `stack.cli`.

import { execSync } from "node:child_process";

const raw = process.env.STACK_CHECKS;
if (!raw) process.exit(0);

let checks;
try {
  checks = JSON.parse(raw);
} catch (err) {
  console.error(`FATAL: STACK_CHECKS is not valid JSON: ${err.message}`);
  process.exit(1);
}

const failures = [];
for (const c of checks) {
  try {
    execSync(c.check, { stdio: "ignore", shell: "/bin/sh" });
  } catch {
    failures.push(c);
  }
}

if (failures.length > 0) {
  console.error("FATAL: this session's stack is missing required tools:");
  for (const f of failures) {
    console.error(`  - ${f.name}: \`${f.check}\` failed${f.install ? ` (repair: ${f.install})` : ""}`);
  }
  process.exit(1);
}

console.log(`stack check passed (${checks.length} tool(s) verified)`);
