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
import { nextTask } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

function guard<A>(fn: (args: A) => unknown): (args: A) => ToolResult {
  return (args) => {
    try {
      return ok(fn(args));
    } catch (err) {
      if (err instanceof SwitchyardError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  };
}

export function buildMcpServer(db: Db, actor: Actor): McpServer {
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
      },
    },
    guard((a: { project_key?: string; status?: (typeof STATUSES)[number]; assignee?: string; label?: string; text?: string }) =>
      searchIssues(db, {
        projectKey: a.project_key, status: a.status,
        assigneeName: a.assignee, label: a.label, text: a.text,
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

  return server;
}
