import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { githubRepos } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getProjectByKey } from "./projects.js";

export type GithubRepo = typeof githubRepos.$inferSelect;

const FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

function requireHuman(actor: Actor): void {
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Only humans manage linked GitHub repos — ask a human to link or unlink a repo.",
    );
  }
}

export function addGithubRepo(
  db: Db,
  actor: Actor,
  input: { fullName: string; projectKey?: string; secret?: string },
): GithubRepo {
  requireHuman(actor);
  if (!FULL_NAME_RE.test(input.fullName)) {
    throw new SwitchyardError(`GitHub repo must be "owner/repo" — got "${input.fullName}".`);
  }
  const existing = db
    .select()
    .from(githubRepos)
    .where(eq(githubRepos.fullName, input.fullName))
    .get();
  if (existing) {
    throw new SwitchyardError(`GitHub repo "${input.fullName}" is already linked.`);
  }
  const projectId = input.projectKey ? getProjectByKey(db, input.projectKey).id : null;
  return db
    .insert(githubRepos)
    .values({ fullName: input.fullName, projectId, secret: input.secret ?? null })
    .returning()
    .get();
}

export function listGithubRepos(db: Db): GithubRepo[] {
  return db.select().from(githubRepos).all();
}

export function removeGithubRepo(db: Db, actor: Actor, id: number): void {
  requireHuman(actor);
  const gone = db.delete(githubRepos).where(eq(githubRepos.id, id)).returning().get();
  if (!gone) {
    throw new SwitchyardError(
      `There is no linked GitHub repo with id ${id} — list them with GET /api/github-repos.`,
    );
  }
}

/**
 * Resolves the signing secret to verify a delivery from `fullName` against.
 * Returns undefined when the repo isn't linked at all (caller falls back to
 * the global GITHUB_WEBHOOK_SECRET), or the repo's row (secret possibly
 * null, meaning "linked but shares the global secret").
 */
export function findGithubRepo(db: Db, fullName: string): GithubRepo | undefined {
  return db.select().from(githubRepos).where(eq(githubRepos.fullName, fullName)).get();
}
