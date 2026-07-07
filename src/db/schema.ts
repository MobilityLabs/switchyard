import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const STATUSES = [
  "triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

const now = () => sql`(unixepoch())`;

export const actors = sqliteTable("actors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["human", "agent"] }).notNull(),
  tokenHash: text("token_hash"),
  createdAt: integer("created_at").notNull().default(now()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  nextIssueNumber: integer("next_issue_number").notNull().default(1),
  createdAt: integer("created_at").notNull().default(now()),
});

export const issues = sqliteTable("issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull().references(() => projects.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", { enum: STATUSES }).notNull(),
  priority: text("priority", { enum: PRIORITIES }).notNull().default("none"),
  assigneeId: integer("assignee_id").references(() => actors.id),
  creatorId: integer("creator_id").notNull().references(() => actors.id),
  parentId: integer("parent_id"),
  labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
  sourceType: text("source_type", { enum: ["session", "todo", "ci", "manual"] }),
  sourceDetail: text("source_detail"),
  sourceUrl: text("source_url"),
  createdAt: integer("created_at").notNull().default(now()),
  updatedAt: integer("updated_at").notNull().default(now()),
});

export const dependencies = sqliteTable(
  "dependencies",
  {
    blockerId: integer("blocker_id").notNull().references(() => issues.id),
    blockedId: integer("blocked_id").notNull().references(() => issues.id),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]
);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id").notNull().references(() => issues.id),
  actorId: integer("actor_id").notNull().references(() => actors.id),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at").notNull().default(now()),
});
