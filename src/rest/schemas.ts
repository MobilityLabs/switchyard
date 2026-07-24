import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { STATUSES, PRIORITIES } from "../db/schema.js";
import { SUMMARY_MAX_LENGTH } from "../services/issues.js";
import { AGENT_SESSION_MODES } from "../services/agent-sessions.js";

export const projectBody = z.object({ key: z.string(), name: z.string() });
export const projectUpdateBody = z.object({ name: z.string().min(1) });
export const actorCreateBody = z.object({
  name: z.string().min(1),
  type: z.enum(["human", "agent", "service"]),
});

const provenance = z.object({
  sourceType: z.enum(["session", "todo", "ci", "manual"]),
  detail: z.string().optional(),
  url: z.string().optional(),
});

export const issueCreateBody = z.object({
  projectKey: z.string(),
  title: z.string().min(1),
  summary: z.string().max(SUMMARY_MAX_LENGTH).optional(),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  labels: z.array(z.string()).optional(),
  parentRef: z.string().optional(),
  provenance: provenance.optional(),
  workerPreference: z.string().nullable().optional(),
});

export const issueUpdateBody = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().max(SUMMARY_MAX_LENGTH).nullable().optional(),
  description: z.string().optional(),
  assigneeName: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  workerPreference: z.string().nullable().optional(),
  parentRef: z.string().nullable().optional(),
  // SYD-208: compare-and-set proof that the human reviewed this exact head
  // before stamping done over an open agent PR — see updateIssue's pin gate.
  expectedHeadSha: z.string().min(1).optional(),
});

export const redeliverBody = z.object({ expectedHeadSha: z.string().min(1).optional() });

export const resolveDeliveryBody = z.object({ note: z.string().min(1) });

// SYD-208: the Task-6 worker's outcome vocabulary excludes skipped_rollout —
// that value is written only by the one-time rollout backfill
// (ensureRolloutBackfill), never by a live delivery attempt, so the schema
// layer refuses it before it ever reaches finishDeliveryAttempt's own guard.
// Written as a literal tuple (rather than DELIVERY_OUTCOMES.filter(...) cast
// to a tuple type) so z.enum's tuple requirement typechecks cleanly; a REST
// test asserts this list equals DELIVERY_OUTCOMES minus skipped_rollout so
// the two can't silently drift apart.
export const WORKER_OUTCOMES = [
  "merged_deployed",
  "merged_deploy_failed",
  "verify_failed",
  "conflict_bounced",
  "merge_failed",
  "checks_timeout",
  "sha_chain_disarmed",
] as const;
export const deliveryAttemptStartBody = z.object({
  authorizationId: z.number().int().positive(),
  prNumber: z.number().int().positive().optional(),
  headSha: z.string().min(1).optional(),
  deployRetry: z.boolean().optional(),
});
export const deliveryAttemptFinishBody = z.object({
  outcome: z.enum(WORKER_OUTCOMES),
  derivedHeadSha: z.string().min(1).optional(),
});

// SYD-209: the worker persists the post-rebase head (S1) mid-attempt — before
// the merge, so a crash re-anchors on S1 — via a dedicated route that does NOT
// finish the attempt (no outcome field).
export const deliveryAttemptDerivedHeadBody = z.object({
  derivedHeadSha: z.string().min(1),
});

export const commentBody = z.object({ body: z.string() });
const deployResult = z.union([
  z.object({ ran: z.literal(false) }),
  z.object({ ran: z.literal(true), ok: z.boolean(), tail: z.string() }),
]);
// SYD-205 ingestion groundwork: `repo` (and `headSha`/`ghUpdatedAt` on
// pr_opened) stay OPTIONAL until the worker host go-live — making them
// required now would 400 the un-upgraded worker and silently drop its
// pr_opened publish (the deploy-skew rule in the sync-simplification spec).
const repoField = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')
  .optional();
export const deliveryEventBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pr_opened"),
    prNumber: z.number().int().positive(),
    url: z.string().url(),
    repo: repoField,
    headSha: z.string().min(1).optional(),
    ghUpdatedAt: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("delivered"),
    prNumber: z.number().int().positive(),
    mergeSha: z.string().min(1),
    deploy: deployResult,
    repo: repoField,
    headSha: z.string().min(1).optional(),
    ghUpdatedAt: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("delivery_failed"),
    message: z.string().min(1),
    repo: repoField,
  }),
]);
export const agentSessionCreateBody = z.object({
  ref: z.string(),
  mode: z.enum(AGENT_SESSION_MODES),
  pid: z.number().int().positive().nullable().optional(),
});
export const agentSessionEndBody = z.object({ exitCode: z.number().int().nullable() });
export const progressNoteBody = z.object({ note: z.string().min(1) });
export const dependencyBody = z.object({ blockerRef: z.string(), blockedRef: z.string() });
export const requestInputBody = z.object({ question: z.string() });
export const snoozeBody = z.object({ until: z.number().int().positive() });
export const duplicateBody = z.object({ of: z.string() });
export const webhookCreateBody = z.object({
  url: z.string(),
  projectKey: z.string().optional(),
  secret: z.string().optional(),
});
export const webhookPatchBody = z.object({ active: z.boolean() });
export const githubRepoCreateBody = z.object({
  fullName: z.string(),
  projectKey: z.string().optional(),
  secret: z.string().optional(),
});
export const githubEventBody = z.object({
  event: z.enum(["pull_request", "check_suite"]),
  // Shape varies by event type; handleGithubWebhook validates the fields it
  // actually reads against a per-event zod schema (src/services/github-webhook.ts).
  payload: z.unknown(),
  // Optional-first per the SYD-205 deploy-skew rule; the server infers a sole
  // bound repo when absent.
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')
    .optional(),
});
export const settingPutBody = z.object({ value: z.any() });

export const body = <T extends z.ZodTypeAny>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join(".");
      return c.json(
        { error: `Invalid request body${path ? ` at "${path}"` : ""}: ${first.message}` },
        400,
      );
    }
  });
