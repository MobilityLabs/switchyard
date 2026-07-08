import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { STATUSES, PRIORITIES } from "../db/schema.js";
import type { Actor } from "../services/actors.js";
import { SwitchyardError } from "../services/errors.js";
import { listProjects } from "../services/projects.js";
import {
  createIssue, getIssue, updateIssue, claimIssue,
} from "../services/issues.js";
import { nextTask, addDependency } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";
import { requestHumanInput } from "../services/needs-input.js";
import { saveAttachment, defaultAttachmentsDir } from "../services/attachments.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

function guard<A>(fn: (args: A) => unknown): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof SwitchyardError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  };
}

export function buildMcpServer(db: Db, actor: Actor, attachmentsDir: string = defaultAttachmentsDir()): McpServer {
  const server = new McpServer({ name: "switchyard", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "List all projects with their keys. Issue refs are <KEY>-<number>." },
    guard(() => listProjects(db))
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get one issue by ref (e.g. AIPI-42), including its full activity history.",
      inputSchema: { ref: z.string() },
    },
    guard(({ ref }: { ref: string }) => ({
      ...getIssue(db, ref),
      activity: getActivity(db, ref),
    }))
  );

  server.registerTool(
    "search_issues",
    {
      description: "Search issues. All filters are ANDed; text matches title/description.",
      inputSchema: {
        project_key: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        assignee: z.string().optional(),
        label: z.string().optional(),
        text: z.string().optional(),
        needs_input: z.boolean().optional(),
      },
    },
    guard((a: {
      project_key?: string; status?: (typeof STATUSES)[number]; assignee?: string;
      label?: string; text?: string; needs_input?: boolean;
    }) =>
      searchIssues(db, {
        projectKey: a.project_key, status: a.status,
        assigneeName: a.assignee, label: a.label, text: a.text,
        needsInput: a.needs_input,
      })
    )
  );

  server.registerTool(
    "next_task",
    {
      description:
        "Get the highest-priority issue in `todo` that is assigned to you or unassigned and not blocked. " +
        "Call this when you want work. Returns null when nothing is workable.",
      inputSchema: { project_key: z.string().optional() },
    },
    guard(({ project_key }: { project_key?: string }) => nextTask(db, actor, project_key))
  );

  server.registerTool(
    "file_issue",
    {
      description:
        "Create an issue. ALWAYS file discovered work (TODOs, flaky tests, follow-ups, bugs you " +
        "noticed but did not fix) instead of only mentioning it in chat. Agent-filed issues go to " +
        "the triage inbox for human review, so file freely but with clear titles and provenance. " +
        "Your description MUST be decision-grade — a human accepts or dismisses from it alone: " +
        "(1) what's wrong or needed, (2) why it matters and the impact if ignored, " +
        "(3) your suggested next action and rough effort. " +
        "Provenance: source_type is where this came from; source_detail is a file:line, session id, " +
        "or short note; source_url is a CI run or PR link.",
      inputSchema: {
        project_key: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        labels: z.array(z.string()).optional(),
        parent_ref: z.string().optional(),
        source_type: z.enum(["session", "todo", "ci", "manual"]).optional(),
        source_detail: z.string().optional(),
        source_url: z.string().optional(),
      },
    },
    guard((a: {
      project_key: string; title: string; description?: string;
      priority?: (typeof PRIORITIES)[number]; labels?: string[]; parent_ref?: string;
      source_type?: "session" | "todo" | "ci" | "manual";
      source_detail?: string; source_url?: string;
    }) =>
      createIssue(db, actor, {
        projectKey: a.project_key, title: a.title, description: a.description,
        priority: a.priority, labels: a.labels, parentRef: a.parent_ref,
        provenance: a.source_type
          ? { sourceType: a.source_type, detail: a.source_detail, url: a.source_url }
          : undefined,
      })
    )
  );

  server.registerTool(
    "claim_issue",
    {
      description:
        "Assign yourself to an issue and move it to in_progress. Fails with guidance if the issue " +
        "is blocked. Prefer next_task to pick what to claim.",
      inputSchema: { ref: z.string() },
    },
    guard(({ ref }: { ref: string }) => claimIssue(db, actor, ref))
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue's fields. Conventions: before moving an issue to in_review, post a comment " +
        "saying what was done and how it was verified. NEVER move an issue you worked on to done — " +
        "a human or a review step does that. " +
        "Issues in triage can only be moved out by humans (enforced by the server).",
      inputSchema: {
        ref: z.string(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    guard((a: {
      ref: string; status?: (typeof STATUSES)[number]; priority?: (typeof PRIORITIES)[number];
      title?: string; description?: string; assignee?: string | null; labels?: string[];
    }) =>
      updateIssue(db, actor, a.ref, {
        status: a.status, priority: a.priority, title: a.title,
        description: a.description, assigneeName: a.assignee, labels: a.labels,
      })
    )
  );

  server.registerTool(
    "comment",
    {
      description:
        "Add a comment to an issue. Use for progress notes, questions for humans, and final " +
        "summaries (what was done, how it was verified).",
      inputSchema: { ref: z.string(), body: z.string() },
    },
    guard(({ ref, body }: { ref: string; body: string }) => {
      addComment(db, actor, ref, body);
      return { ok: true };
    })
  );

  server.registerTool(
    "request_human_input",
    {
      description:
        "Escalate a question on an issue you are working: sets the needs-input flag and posts your " +
        "question as a comment so humans see it in their inbox. Use this instead of guessing when " +
        "blocked on a decision only a human can make. The flag clears when a human replies or changes status.",
      inputSchema: { ref: z.string(), question: z.string() },
    },
    guard(({ ref, question }: { ref: string; question: string }) => requestHumanInput(db, actor, ref, question))
  );

  server.registerTool(
    "attach_file",
    {
      description:
        "Attach an image or short video to an issue as evidence (png/jpg/gif/webp/avif/mp4/webm/mov, " +
        "≤20MB decoded). Returns a markdown snippet — include it in your next comment so humans " +
        "see the media inline.",
      inputSchema: { ref: z.string(), filename: z.string(), content_base64: z.string() },
    },
    guard(async ({ ref, filename, content_base64 }: { ref: string; filename: string; content_base64: string }) => {
      const cleaned = content_base64.replace(/\s+/g, "");
      if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
        throw new SwitchyardError(
          "content_base64 is not valid base64 — check the encoding and try again."
        );
      }
      const data = Buffer.from(cleaned, "base64");
      const { attachment, markdown } = await saveAttachment(db, actor, ref, filename, data, attachmentsDir);
      return { markdown, url: `/api/attachments/${attachment.id}/${attachment.filename}` };
    })
  );

  server.registerTool(
    "add_dependency",
    {
      description:
        "Declare that one issue blocks another (blocker must finish first). Blocked issues are " +
        "skipped by next_task and cannot be claimed until the blocker is done or canceled.",
      inputSchema: { blocker_ref: z.string(), blocked_ref: z.string() },
    },
    guard(({ blocker_ref, blocked_ref }: { blocker_ref: string; blocked_ref: string }) => {
      addDependency(db, actor, blocker_ref, blocked_ref);
      return { ok: true };
    })
  );

  server.registerTool(
    "triage_queue",
    {
      description:
        "List issues waiting in triage (agent-filed, pending human review), with provenance. Use " +
        "when a human asks you to help triage: suggest duplicates, priorities, and merges — but " +
        "the accept/dismiss decision is theirs.",
      inputSchema: { project_key: z.string().optional(), include_snoozed: z.boolean().optional() },
    },
    guard(({ project_key, include_snoozed }: { project_key?: string; include_snoozed?: boolean }) =>
      searchIssues(db, { projectKey: project_key, status: "triage", excludeSnoozed: !include_snoozed })
    )
  );

  return server;
}
