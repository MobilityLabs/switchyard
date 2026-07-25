// Decision logic for the worker-parity preflight (SYD-166): a single command
// an agent runs before done-stamping that mirrors what .github/workflows/ci.yml
// will do, so environment-sensitive failures surface inside the session that
// can cheaply fix them instead of bouncing an already-completed delivery —
// wrong node major (SYD-97: Node 25 breaks jsdom) or a session's local TZ
// leaking into date-dependent tests (SYD-162: dreamer's tests read the local
// clock and fail after 8pm ET). Kept side-effect free and unit-tested here;
// the thin process-spawning wrapper lives in verify-worker-parity.ts — same
// split as delivery-lib.ts / delivery-exec.ts.

import { nodeVersionSatisfiesEngines } from "./init-worker-lib.js";

// GitHub Actions' ubuntu-latest runners default to UTC and ci.yml never sets
// TZ, so UTC is what a delivered PR is actually checked against. Pinning it
// here removes the one axis a session's own host TZ could otherwise disagree
// with CI on.
export const WORKER_TZ = "UTC";

export type VerifyStep = { label: string; cmd: string; args: string[] };

/** Mirrors ci.yml's job steps, in order. `npm ci` / `npm rebuild
 * better-sqlite3` aren't reproduced — a dev/agent session already has deps
 * installed — so a green run here means the rest of CI (typecheck, build,
 * test) is green too. */
export function ciMirrorSteps(): VerifyStep[] {
  return [
    { label: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
    { label: "build:ui", cmd: "npm", args: ["run", "build:ui"] },
    { label: "test", cmd: "npm", args: ["test"] },
  ];
}

/** This repo's declared `engines.node` band, or null if package.json has none
 * or is unparseable. */
export function readEnginesNode(pkgJsonRaw: string): string | null {
  try {
    const pkg = JSON.parse(pkgJsonRaw);
    return typeof pkg?.engines?.node === "string" ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

/** Null when `actual` (a `process.version`-shaped string) satisfies
 * `enginesNode` (or there's no declared band); otherwise a ready-to-print
 * FATAL message. Node major drift is exactly what bit SYD-97 — silently
 * running the suite on the wrong node produces confusing failures instead of
 * naming the actual cause up front. */
export function nodeVersionMismatchMessage(
  enginesNode: string | null,
  actual: string,
): string | null {
  if (enginesNode === null) return null;
  if (nodeVersionSatisfiesEngines(enginesNode, actual)) return null;
  return (
    `FATAL: running node ${actual}, outside this repo's engines.node "${enginesNode}" ` +
    "(CI resolves node from .nvmrc). Switch node (e.g. `nvm use`) before trusting this run."
  );
}

export type SpawnResult = { status: number | null };
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnResult;

export type VerifyOutcome = { ok: true } | { ok: false; failedStep: string; exitCode: number };

/** Runs `steps` in order with TZ pinned to WORKER_TZ, stopping at the first
 * non-zero exit — the same fail-fast behavior as CI's step sequence. `spawn`
 * is injected so this is unit-testable without actually invoking npm. */
export function runVerifySteps(
  steps: VerifyStep[],
  spawn: SpawnFn,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): VerifyOutcome {
  const env = { ...opts.env, TZ: WORKER_TZ };
  for (const step of steps) {
    const res = spawn(step.cmd, step.args, { cwd: opts.cwd, env });
    if (res.status !== 0) {
      return { ok: false, failedStep: step.label, exitCode: res.status ?? 1 };
    }
  }
  return { ok: true };
}
