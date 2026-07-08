// Single-instance pidfile lock shared by the long-lived loops (agent-worker,
// deliver): a live pid in the file blocks startup; stale files from crashed
// processes are reclaimed. Not safe against two processes racing the same
// path simultaneously — good enough for "don't run two loops by accident".

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

export function acquirePidLock(lockPath: string, hint = "stop it first"): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws ESRCH if no such process
        throw new Error(`another instance is already running (pid ${pid}, ${lockPath}) — ${hint}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        // Stale pidfile from a crash — reclaim it.
      }
    }
  }
  writeFileSync(lockPath, String(process.pid));
  return () => {
    try { rmSync(lockPath); } catch { /* already gone */ }
  };
}
