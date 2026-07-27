import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { STATUSES, PRIORITIES } from "../db/schema.js";
import type { Actor } from "../services/actors.js";
import type { Attribution } from "../services/attribution.js";
import { SwitchyardError, PendingAffirmation } from "../services/errors.js";
import { listProjects } from "../services/projects.js";
import {
  createIssue,
  getIssue,
  updateIssue,
  claimIssue,
  heartbeatClaim,
  SUMMARY_MAX_LENGTH,
} from "../services/issues.js";
import { nextTask, addDependency, removeDependency } from "../services/dependencies.js";
import { addComment, getActivity } from "../services/comments.js";
import { searchIssues } from "../services/search.js";
import { getAttention, listAttentionByIssueId } from "../services/attention.js";
import {
  listRecentEventsPage,
  DEFAULT_RECENT_EVENTS_LIMIT,
  MAX_RECENT_EVENTS_LIMIT,
} from "../services/events.js";
import { requestHumanInput } from "../services/needs-input.js";
import { declarePrLink, revokePrLink } from "../services/pr-links.js";
import { recordProgressNote, listAgentSessions } from "../services/agent-sessions.js";
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
      // Parked is a SUCCESS: the agent's job now is to tell its human what to
      // affirm, not to retry or report a failure. Returning isError here would
      // invite exactly the retry loop the dedup upsert exists to absorb.
      if (err instanceof PendingAffirmation) return ok(err.pending);
      if (err instanceof SwitchyardError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  };
}

export function buildMcpServer(
  db: Db,
  actor: Actor,
  attachmentsDir: string = defaultAttachmentsDir(),
  // SYD-210 Layer B: a connection-level lease token, extracted once by the /mcp
  // endpoint from the X-Switchyard-Lease header (mirrors how the actor is baked
  // into this closure). The host worker sets it for a container session so its
  // claim-scoped tool calls carry the lease WITHOUT the token ever appearing in
  // the LLM transcript. An explicit lease_token tool arg still wins when given.
  connectionLeaseToken?: string,
  // Supervised interactive sessions: the dual attribution for every write this
  // connection makes, resolved ONCE by /mcp from the sup_ token and baked into
  // this closure — exactly like `actor` above. It is deliberately NOT a tool
  // argument: a client-supplied sessionId would let an agent park a gated
  // action under another human's session, and affirmPendingAction's owner tie
  // would then check that victim instead of the attacker. Empty for a plain
  // (non-supervised) principal, which must never populate events.sessionId.
  attribution: Attribution = {},
  // The agent acting on the human's behalf in a supervised session. `actor` is
  // the accountable human root, so agent-scoped tools act as this instead.
  viaAgent?: Actor,
): McpServer {
  const server = new McpServer({ name: "switchyard", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "List all projects with their keys. Issue refs are <KEY>-<number>." },
    guard(() => listProjects(db)),
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Get the actor name/type/id your MCP token is bound to — the MCP equivalent of REST's " +
        "GET /me. Useful for assignee-scoped search_issues, or to confirm which actor a token authenticates as.",
    },
    guard(() => actor),
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get one issue by ref (e.g. AIPI-42), including its full activity history.",
      inputSchema: { ref: z.string() },
    },
    guard(({ ref }: { ref: string }) => {
      const issue = getIssue(db, ref);
      return {
        ...issue,
        attention: getAttention(db, issue.id),
        activity: getActivity(db, ref),
      };
    }),
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
    guard(
      (a: {
        project_key?: string;
        status?: (typeof STATUSES)[number];
        assignee?: string;
        label?: string;
        text?: string;
        needs_input?: boolean;
      }) => {
        const results = searchIssues(db, {
          projectKey: a.project_key,
          status: a.status,
          assigneeName: a.assignee,
          label: a.label,
          text: a.text,
          needsInput: a.needs_input,
        });
        const attention = listAttentionByIssueId(db);
        return results.map((r) => ({ ...r, attention: attention.get(r.id) ?? null }));
      },
    ),
  );

  server.registerTool(
    "next_task",
    {
      description:
        "Get the highest-priority issue in `todo` that is assigned to you or unassigned and not blocked. " +
        "Call this when you want work. Returns null when nothing is workable.",
      inputSchema: { project_key: z.string().optional() },
    },
    guard(({ project_key }: { project_key?: string }) => nextTask(db, actor, project_key)),
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
        "Always set priority to your best guess (urgent/high/medium/low) based on impact and " +
        "urgency — don't leave it unset; a human can always correct it during triage. " +
        `Your summary MUST be one or two sentences (${SUMMARY_MAX_LENGTH} chars max) a human can ` +
        "triage from at a glance — it's what shows in the triage inbox row; the description stays " +
        "the full decision-grade writeup behind a click. " +
        "Provenance: source_type is where this came from; source_detail is a file:line, session id, " +
        "or short note; source_url is a CI run or PR link.",
      inputSchema: {
        project_key: z.string(),
        title: z.string(),
        summary: z.string().max(SUMMARY_MAX_LENGTH).optional(),
        description: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        labels: z.array(z.string()).optional(),
        parent_ref: z.string().optional(),
        source_type: z.enum(["session", "todo", "ci", "manual"]).optional(),
        source_detail: z.string().optional(),
        source_url: z.string().optional(),
        worker_preference: z.string().nullable().optional(),
      },
    },
    guard(
      (a: {
        project_key: string;
        title: string;
        summary?: string;
        description?: string;
        priority?: (typeof PRIORITIES)[number];
        labels?: string[];
        parent_ref?: string;
        source_type?: "session" | "todo" | "ci" | "manual";
        source_detail?: string;
        source_url?: string;
        worker_preference?: string | null;
      }) =>
        createIssue(
          db,
          actor,
          {
            projectKey: a.project_key,
            title: a.title,
            summary: a.summary,
            description: a.description,
            priority: a.priority,
            labels: a.labels,
            parentRef: a.parent_ref,
            provenance: a.source_type
              ? { sourceType: a.source_type, detail: a.source_detail, url: a.source_url }
              : undefined,
            workerPreference: a.worker_preference,
          },
          attribution,
        ),
    ),
  );

  server.registerTool(
    "claim_issue",
    {
      description:
        "Assign yourself to an issue and move it to in_progress. Fails with guidance if the issue " +
        "is blocked, already claimed by someone else, or already has an open PR from a prior claim. " +
        "Prefer next_task to pick what to claim. Returns a lease_token — present it as lease_token on " +
        "every later claim-scoped call (update_issue, request_human_input) on this issue. " +
        "If you already hold an active lease (e.g. a prior session), the bare claim fails — pass " +
        "takeover: true to seize it, invalidating that session's lease.",
      inputSchema: { ref: z.string(), takeover: z.boolean().optional() },
    },
    guard(({ ref, takeover }: { ref: string; takeover?: boolean }) => {
      // SYD-210: a host-supervised container session already holds a
      // host-minted lease (injected as the connection token). Refuse claim_issue
      // for it — otherwise a prompt-injection in an untrusted issue body could
      // coax it into claim_issue(takeover:true), which would mint a fresh token
      // straight into the LLM transcript / a durable comment (and DoS the host's
      // heartbeat by invalidating its lease). Its writes are already authorized.
      if (connectionLeaseToken) {
        throw new SwitchyardError(
          `${ref} is already claimed for your session — do not call claim_issue; your writes are already authorized. Just proceed with the work.`,
        );
      }
      const { issue, leaseToken } = claimIssue(db, actor, ref, { takeover }, attribution);
      return { ...issue, lease_token: leaseToken };
    }),
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an issue's fields. Conventions: before moving an issue to in_review, post a comment " +
        "saying what was done and how it was verified. NEVER move an issue you worked on to done — " +
        "a human or a review step does that. " +
        "Issues in triage can only be moved out by humans (enforced by the server). " +
        "Agents may only self-assign (prefer claim_issue) — assigning someone else or clearing " +
        "an assignee is human-only (enforced by the server). " +
        "Stamping status: done over an issue with an open agent PR authorizes delivery, so the " +
        "server requires expected_head_sha (the head SHA you reviewed) — it 400s naming the current " +
        "head if the PR moved since you looked. " +
        "If you claimed this issue, pass lease_token (returned by claim_issue) — the server rejects a " +
        "claim-scoped change without your session's lease.",
      inputSchema: {
        ref: z.string(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        title: z.string().optional(),
        summary: z.string().max(SUMMARY_MAX_LENGTH).nullable().optional(),
        description: z.string().optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        worker_preference: z.string().nullable().optional(),
        parent_ref: z.string().nullable().optional(),
        expected_head_sha: z.string().optional(),
        lease_token: z.string().optional(),
      },
    },
    guard(
      (a: {
        ref: string;
        status?: (typeof STATUSES)[number];
        priority?: (typeof PRIORITIES)[number];
        title?: string;
        summary?: string | null;
        description?: string;
        assignee?: string | null;
        labels?: string[];
        worker_preference?: string | null;
        parent_ref?: string | null;
        expected_head_sha?: string;
        lease_token?: string;
      }) => {
        // SYD-210 review (pentester): a host-supervised session (connection lease)
        // gets NO mint container — so update_issue can never mint a fresh lease
        // into its tool result, and updateIssue's auto-claim is refused for it
        // (it's scoped to its one pre-claimed issue). Only ordinary sessions
        // (interactive / bare-CLI without a connection lease) may auto-claim and
        // receive the once-only token.
        const minted = connectionLeaseToken ? undefined : { token: null as string | null };
        const issue = updateIssue(
          db,
          actor,
          a.ref,
          {
            status: a.status,
            priority: a.priority,
            title: a.title,
            summary: a.summary,
            description: a.description,
            assigneeName: a.assignee,
            labels: a.labels,
            workerPreference: a.worker_preference,
            parentRef: a.parent_ref,
            expectedHeadSha: a.expected_head_sha,
          },
          { presented: a.lease_token ?? connectionLeaseToken, minted },
          attribution,
        );
        return minted?.token ? { ...issue, lease_token: minted.token } : issue;
      },
    ),
  );

  // SYD-210: register the model-facing heartbeat tool ONLY for a host-supervised
  // container session (one carrying a connection lease). Exposing it to ordinary
  // interactive sessions is a footgun: a single call would collapse their 8h
  // lease to the ~10-min heartbeat window (heartbeatLease shortens expires_at),
  // and an idle interactive session would then be released mid-work. The host
  // renews container leases over REST, so no ordinary session needs this tool.
  if (connectionLeaseToken) {
    server.registerTool(
      "heartbeat",
      {
        description:
          "Keep your claim's lease alive by renewing it. The supervising host worker already does " +
          "this on a timer — you normally do NOT need to call it yourself.",
        inputSchema: { ref: z.string(), lease_token: z.string().optional() },
      },
      guard(({ ref, lease_token }: { ref: string; lease_token?: string }) => {
        const { expiresAt } = heartbeatClaim(db, actor, ref, lease_token ?? connectionLeaseToken);
        return { ok: true, expires_at: expiresAt };
      }),
    );
  }

  server.registerTool(
    "comment",
    {
      description:
        "Add a comment to an issue. Use for progress notes, questions for humans, and final " +
        "summaries (what was done, how it was verified).",
      inputSchema: { ref: z.string(), body: z.string() },
    },
    guard(({ ref, body }: { ref: string; body: string }) => {
      addComment(db, actor, ref, body, attribution);
      return { ok: true };
    }),
  );

  server.registerTool(
    "progress_note",
    {
      description:
        "Record a one-line note about what you are doing right now on an issue you are working " +
        '(e.g. "tests written, implementing the service"). Shown live in the app while your ' +
        "session runs — call it each time you start a new step so humans can follow along. " +
        "Use comment for anything a human should read later; progress notes are ephemeral status.",
      inputSchema: { ref: z.string(), note: z.string() },
    },
    guard(({ ref, note }: { ref: string; note: string }) => {
      // The one agent-scoped write: recordProgressNote's requireAgent rejects a
      // human, and in a supervised session `actor` IS the human root — so act as
      // the bound agent instead of relaxing the guard. For a plain agent session
      // viaAgent is undefined and `actor` is already the agent (unchanged).
      recordProgressNote(db, viaAgent ?? actor, ref, note, attribution);
      return { ok: true };
    }),
  );

  server.registerTool(
    "request_human_input",
    {
      description:
        "Escalate a question on an issue you are working: sets the needs-input flag and posts your " +
        "question as a comment so humans see it in their inbox. Use this instead of guessing when " +
        "blocked on a decision only a human can make. The flag clears when a human replies or changes status. " +
        "Pass lease_token (returned by claim_issue) — escalating is a claim-scoped action.",
      inputSchema: { ref: z.string(), question: z.string(), lease_token: z.string().optional() },
    },
    guard(
      ({ ref, question, lease_token }: { ref: string; question: string; lease_token?: string }) =>
        requestHumanInput(
          db,
          actor,
          ref,
          question,
          lease_token ?? connectionLeaseToken,
          attribution,
        ),
    ),
  );

  server.registerTool(
    "declare_pr_link",
    {
      description:
        "Record that a pull request carries this issue's work. Call this right after you open a PR, " +
        "on ANY branch — this is what links the PR to the issue, and without it the board cannot tell " +
        "that your work exists. Do not rely on the branch name or on mentioning the ref in the PR " +
        "title: those are guesses, and only a declared link counts. " +
        "You must hold the claim, so pass lease_token (returned by claim_issue). " +
        "Your declaration blocks anyone else claiming this issue, but it does NOT by itself prove the " +
        "work landed — a human confirms that when they review. If you linked the wrong PR, call " +
        "revoke_pr_link and declare the right one.",
      inputSchema: {
        ref: z.string(),
        repo: z.string().describe("owner/name, e.g. MobilityLabs/switchyard"),
        pr_number: z.number().int().positive(),
        lease_token: z.string().optional(),
      },
    },
    guard((a: { ref: string; repo: string; pr_number: number; lease_token?: string }) =>
      declarePrLink(
        db,
        actor,
        a.ref,
        { repo: a.repo, prNumber: a.pr_number },
        a.lease_token ?? connectionLeaseToken,
        attribution,
      ),
    ),
  );

  server.registerTool(
    "revoke_pr_link",
    {
      description:
        "Withdraw a PR link you declared on this issue — use it when you linked the wrong PR, or the " +
        "PR was abandoned. A reason is required and is recorded. You can only withdraw your own link, " +
        "and only while it is still unconfirmed: once a human has confirmed it, only a human can " +
        "revoke it. Pass lease_token (returned by claim_issue).",
      inputSchema: {
        ref: z.string(),
        repo: z.string(),
        pr_number: z.number().int().positive(),
        reason: z.string(),
        lease_token: z.string().optional(),
      },
    },
    guard(
      (a: {
        ref: string;
        repo: string;
        pr_number: number;
        reason: string;
        lease_token?: string;
      }) => {
        revokePrLink(
          db,
          actor,
          a.ref,
          { repo: a.repo, prNumber: a.pr_number, reason: a.reason },
          a.lease_token ?? connectionLeaseToken,
          attribution,
        );
        return { ok: true };
      },
    ),
  );

  server.registerTool(
    "attach_file",
    {
      description:
        "Attach an image or short video to an issue as evidence (png/jpg/gif/webp/avif/mp4/webm/mov, " +
        "≤20MB decoded). The issue's activity feed shows a thumbnail/link for this automatically. " +
        "For UI work, attach a screenshot of the change (before/after where relevant); for " +
        "architecture work, attach a diagram (e.g. a Mermaid diagram rendered to PNG) — a rendered " +
        "image lets a human sign off at a glance instead of reading the diff. " +
        "Also include the returned markdown snippet in your next comment when you want to call out " +
        "or discuss the attachment, not just record it. " +
        "PREFER uploading from disk instead of base64: if the file is already on disk and you have a " +
        "shell, run `switchyard-attach <ISSUE_REF> <FILE>` (dispatched workers) or " +
        "`node scripts/attach.mjs <ISSUE_REF> <FILE>` (Switchyard repo) — it streams the bytes to the " +
        "tracker without spending output tokens base64-encoding the image, and prints the same markdown. " +
        "Use content_base64 below only when you lack a shell or the SWITCHYARD_URL/SWITCHYARD_TOKEN env vars.",
      inputSchema: {
        ref: z.string(),
        filename: z.string(),
        // ~20MB decoded (base64 inflates size by ~4/3); rejects oversized
        // payloads before we spend cycles decoding them.
        content_base64: z.string().max(28 * 1024 * 1024),
      },
    },
    guard(
      async ({
        ref,
        filename,
        content_base64,
      }: {
        ref: string;
        filename: string;
        content_base64: string;
      }) => {
        const cleaned = content_base64.replace(/\s+/g, "");
        if (
          cleaned.length === 0 ||
          cleaned.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)
        ) {
          throw new SwitchyardError(
            "content_base64 is not valid base64 — check the encoding and try again.",
          );
        }
        const data = Buffer.from(cleaned, "base64");
        const { attachment, markdown } = await saveAttachment(
          db,
          actor,
          ref,
          filename,
          data,
          attachmentsDir,
          attribution,
        );
        return { markdown, url: `/api/attachments/${attachment.id}/${attachment.filename}` };
      },
    ),
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
      addDependency(db, actor, blocker_ref, blocked_ref, attribution);
      return { ok: true };
    }),
  );

  server.registerTool(
    "remove_dependency",
    {
      description:
        "Declare that one issue no longer blocks another (removes a dependency edge). " +
        "Only humans may remove dependencies directly — if you are an agent, " +
        "this will propose dependency removal through the hard-gate if configured.",
      inputSchema: { blocker_ref: z.string(), blocked_ref: z.string() },
    },
    guard(({ blocker_ref, blocked_ref }: { blocker_ref: string; blocked_ref: string }) => {
      removeDependency(db, actor, blocker_ref, blocked_ref, attribution);
      return { ok: true };
    }),
  );

  server.registerTool(
    "recent_events",
    {
      description:
        'Cross-issue, newest-first activity feed for diagnosing "what just happened on the board" ' +
        "(the same feed the dispatch worker polls). Optional `since` (unix seconds) filters to events " +
        `after that time. Defaults to the ${DEFAULT_RECENT_EVENTS_LIMIT} most recent events, capped at ` +
        `${MAX_RECENT_EVENTS_LIMIT} — the response includes \`truncated\` and \`next_cursor\`; pass ` +
        "`next_cursor` back in as `before_id` to page further back instead of raising the limit.",
      inputSchema: {
        since: z.number().optional(),
        limit: z.number().optional(),
        before_id: z.number().optional(),
      },
    },
    guard(({ since, limit, before_id }: { since?: number; limit?: number; before_id?: number }) => {
      const page = listRecentEventsPage(db, { since, limit, beforeId: before_id });
      return { events: page.events, next_cursor: page.nextCursor, truncated: page.truncated };
    }),
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
      searchIssues(db, {
        projectKey: project_key,
        status: "triage",
        excludeSnoozed: !include_snoozed,
      }),
    ),
  );

  server.registerTool(
    "list_agent_sessions",
    {
      description:
        "List agent worker sessions (what's running or recently ran), mirroring the web UI's Agents " +
        "panel. Use to check whether an issue already has an agent working it, or what's currently live.",
      inputSchema: { active: z.boolean().optional(), ref: z.string().optional() },
    },
    guard(({ active, ref }: { active?: boolean; ref?: string }) =>
      listAgentSessions(db, { active, ref }),
    ),
  );

  return server;
}
