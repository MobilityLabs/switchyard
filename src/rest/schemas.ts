import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { STATUSES, PRIORITIES } from "../db/schema.js";

export const projectBody = z.object({ key: z.string(), name: z.string() });

const provenance = z.object({
  sourceType: z.enum(["session", "todo", "ci", "manual"]),
  detail: z.string().optional(),
  url: z.string().optional(),
});

export const issueCreateBody = z.object({
  projectKey: z.string(),
  title: z.string().min(1),
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
  description: z.string().optional(),
  assigneeName: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

export const commentBody = z.object({ body: z.string() });
export const dependencyBody = z.object({ blockerRef: z.string(), blockedRef: z.string() });
export const webhookCreateBody = z.object({
  url: z.string(),
  projectKey: z.string().optional(),
  secret: z.string().optional(),
});
export const webhookPatchBody = z.object({ active: z.boolean() });

export const body = <T extends z.ZodTypeAny>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join(".");
      return c.json({ error: `Invalid request body${path ? ` at "${path}"` : ""}: ${first.message}` }, 400);
    }
  });
