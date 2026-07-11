import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { STATUSES, PRIORITIES } from "../db/schema.js";
import { SUMMARY_MAX_LENGTH } from "../services/issues.js";
import { AGENT_SESSION_MODES } from "../services/agent-sessions.js";

export const projectBody = z.object({ key: z.string(), name: z.string() });
export const actorCreateBody = z.object({ name: z.string().min(1), type: z.enum(["human", "agent"]) });

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
});

export const issueUpdateBody = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().max(SUMMARY_MAX_LENGTH).nullable().optional(),
  description: z.string().optional(),
  assigneeName: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

export const commentBody = z.object({ body: z.string() });
const deployResult = z.union([
  z.object({ ran: z.literal(false) }),
  z.object({ ran: z.literal(true), ok: z.boolean(), tail: z.string() }),
]);
export const deliveryEventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pr_opened"), prNumber: z.number().int().positive(), url: z.string().url() }),
  z.object({
    type: z.literal("delivered"),
    prNumber: z.number().int().positive(),
    mergeSha: z.string().min(1),
    deploy: deployResult,
  }),
  z.object({ type: z.literal("delivery_failed"), message: z.string().min(1) }),
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
  payload: z.record(z.any()),
});
export const settingPutBody = z.object({ value: z.any() });

export const body = <T extends z.ZodTypeAny>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join(".");
      return c.json({ error: `Invalid request body${path ? ` at "${path}"` : ""}: ${first.message}` }, 400);
    }
  });
