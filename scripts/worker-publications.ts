// Durable host-side publication obligations. No credentials are stored here.
// A worker crash or the server's orphan-session sweep must not lose commits
// already pushed by a container into its host repository.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { WorkerConfig } from "./worker-select.js";

const publicationSchema = z.object({
  ref: z.string().regex(/^[A-Z]{2,10}-\d+$/),
  issueTitle: z.string(),
  sessionId: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  /** New sessions import a sanitized exchange; absent on pre-upgrade markers. */
  exchange: z.boolean().optional(),
});
export type PendingPublication = z.infer<typeof publicationSchema>;

function directory(repo: string, config: WorkerConfig): string {
  // Engine workers can share a checkout. Scope by the server and credential
  // NAME, never its value, so one worker does not consume another's outbox.
  const scope = createHash("sha256")
    .update(JSON.stringify([config.url, config.label, config.token ?? "SWITCHYARD_TOKEN"]))
    .digest("hex");
  return path.join(repo, ".superpowers", "worker-publications", scope);
}

export function savePublication(
  repo: string,
  config: WorkerConfig,
  publication: PendingPublication,
): void {
  const checked = publicationSchema.parse(publication);
  const dir = directory(repo, config);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${checked.ref}.json`);
  const temp = `${dest}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(checked) + "\n", { mode: 0o600, flush: true });
  renameSync(temp, dest);
}

export function readPublications(repo: string, config: WorkerConfig): PendingPublication[] {
  const dir = directory(repo, config);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => publicationSchema.parse(JSON.parse(readFileSync(path.join(dir, file), "utf8"))));
}

export function clearPublication(repo: string, config: WorkerConfig, ref: string): void {
  publicationSchema.shape.ref.parse(ref);
  rmSync(path.join(directory(repo, config), `${ref}.json`), { force: true });
}
