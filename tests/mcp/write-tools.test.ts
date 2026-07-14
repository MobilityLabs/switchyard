import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue, SUMMARY_MAX_LENGTH } from "../../src/services/issues.js";
import { snoozeIssue } from "../../src/services/triage-actions.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { getActivity } from "../../src/services/comments.js";
import { addGithubRepo } from "../../src/services/github-repos.js";
import { recordDeliveryEvent } from "../../src/services/delivery-events.js";

let db: Db, human: Actor, agent: Actor, client: Client;

async function connect(actor: Actor, attachmentsDir?: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(db, actor, attachmentsDir).connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0].text;

beforeEach(async () => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
  client = await connect(agent);
});

describe("MCP write tools", () => {
  it("file_issue's description tells agents to set a suggested priority (SYD-65)", async () => {
    const { tools } = await client.listTools();
    const fileIssue = tools.find((t) => t.name === "file_issue")!;
    expect(fileIssue.description).toMatch(/priority/i);
  });

  it("attach_file's description steers UI work to screenshots and architecture work to diagrams (SYD-183)", async () => {
    const { tools } = await client.listTools();
    const attachFile = tools.find((t) => t.name === "attach_file")!;
    expect(attachFile.description).toMatch(/UI.*screenshot/i);
    expect(attachFile.description).toMatch(/architecture.*diagram/i);
  });

  it("file_issue creates a triage issue with provenance", async () => {
    const r = await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Flaky test in api suite",
        description:
          "api_test.ts fails intermittently under load; likely a shared-state race. Suggest isolating fixtures.",
        source_type: "todo",
        source_detail: "src/api.ts:88",
      },
    });
    const issue = JSON.parse(text(r));
    expect(issue.status).toBe("triage");
    expect(getIssue(db, issue.ref).sourceDetail).toBe("src/api.ts:88");
  });

  it("file_issue accepts a summary and update_issue can change or clear it", async () => {
    const r = await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Flaky test in api suite",
        summary: "api_test.ts flakes intermittently under load.",
        description:
          "api_test.ts fails intermittently under load; likely a shared-state race. Suggest isolating fixtures.",
        source_type: "todo",
        source_detail: "src/api.ts:88",
      },
    });
    const issue = JSON.parse(text(r));
    expect(issue.summary).toBe("api_test.ts flakes intermittently under load.");
    expect(getIssue(db, issue.ref).summary).toBe("api_test.ts flakes intermittently under load.");

    const updated = JSON.parse(
      text(
        await client.callTool({
          name: "update_issue",
          arguments: { ref: issue.ref, summary: "Updated summary." },
        }),
      ),
    );
    expect(updated.summary).toBe("Updated summary.");

    const cleared = JSON.parse(
      text(
        await client.callTool({
          name: "update_issue",
          arguments: { ref: issue.ref, summary: null },
        }),
      ),
    );
    expect(cleared.summary).toBeNull();
  });

  it("file_issue rejects a summary over the MCP-enforced length cap", async () => {
    const r = await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Flaky test in api suite",
        summary: "x".repeat(SUMMARY_MAX_LENGTH + 1),
        description: "Enough detail for triage.",
        source_type: "todo",
        source_detail: "src/api.ts:88",
      },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/summary/i);
  });

  it("claim, comment, and move to in_review as an agent", async () => {
    const humanClient = await connect(human);
    await humanClient.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "Ship v1" },
    });
    // human-created issues start in backlog; move to todo, then agent claims
    await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "todo" },
    });
    const claimed = JSON.parse(
      text(
        await client.callTool({
          name: "claim_issue",
          arguments: { ref: "AIPI-1" },
        }),
      ),
    );
    expect(claimed.status).toBe("in_progress");
    await client.callTool({
      name: "comment",
      arguments: { ref: "AIPI-1", body: "Done, verified: 3 tests pass." },
    });
    const reviewed = JSON.parse(
      text(
        await client.callTool({
          name: "update_issue",
          arguments: { ref: "AIPI-1", status: "in_review", lease_token: claimed.lease_token },
        }),
      ),
    );
    expect(reviewed.status).toBe("in_review");
  });

  it("update_issue's expected_head_sha threads through to done-stamp SHA pinning (SYD-208 final review)", async () => {
    const humanClient = await connect(human);
    await humanClient.callTool({
      name: "file_issue",
      arguments: { project_key: "AIPI", title: "Ship v1" },
    });
    await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "todo" },
    });
    const claim = JSON.parse(
      text(await client.callTool({ name: "claim_issue", arguments: { ref: "AIPI-1" } })),
    );
    await client.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "in_review", lease_token: claim.lease_token },
    });

    // Seed an open agent PR the same way the real delivery worker does.
    addGithubRepo(db, human, { fullName: "acme/widgets", projectKey: "AIPI" });
    recordDeliveryEvent(db, human, "AIPI-1", {
      type: "pr_opened",
      prNumber: 7,
      url: "https://github.com/acme/widgets/pull/7",
      headSha: "sha-good",
    });

    // Wrong expected_head_sha: the service's compare-and-set 400s (isError)
    // with the moved-head message, naming both SHAs, and the issue stays put.
    const wrong = await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "done", expected_head_sha: "sha-stale" },
    });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toMatch(/head moved/i);
    expect(text(wrong)).toMatch(/sha-stale/);
    expect(text(wrong)).toMatch(/sha-good/);
    expect(getIssue(db, "AIPI-1").status).toBe("in_review");

    // Right expected_head_sha: succeeds and stamps done.
    const ok = await humanClient.callTool({
      name: "update_issue",
      arguments: { ref: "AIPI-1", status: "done", expected_head_sha: "sha-good" },
    });
    const updated = JSON.parse(text(ok));
    expect(updated.status).toBe("done");
  });

  it("add_dependency makes next_task skip the blocked issue", async () => {
    const humanClient = await connect(human);
    for (const title of ["Schema", "API"]) {
      await humanClient.callTool({ name: "file_issue", arguments: { project_key: "AIPI", title } });
    }
    for (const ref of ["AIPI-1", "AIPI-2"]) {
      await humanClient.callTool({ name: "update_issue", arguments: { ref, status: "todo" } });
    }
    await client.callTool({
      name: "add_dependency",
      arguments: { blocker_ref: "AIPI-1", blocked_ref: "AIPI-2" },
    });
    const r = await client.callTool({ name: "claim_issue", arguments: { ref: "AIPI-2" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/blocked by AIPI-1/);
  });

  it("triage_queue lists triage issues with provenance", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "A",
        description:
          "Noticed while working another task; needs a human to confirm scope before scheduling.",
        source_type: "manual",
        source_detail: "x",
      },
    });
    const r = await client.callTool({ name: "triage_queue", arguments: {} });
    const queue = JSON.parse(text(r));
    expect(queue).toHaveLength(1);
    expect(queue[0].sourceType).toBe("manual");
  });

  it("triage_queue excludes snoozed issues by default and includes them with include_snoozed", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Snoozable",
        description: "Needs a human to confirm scope before scheduling.",
        source_type: "manual",
        source_detail: "x",
      },
    });
    const future = Math.floor(Date.now() / 1000) + 3600;
    snoozeIssue(db, human, "AIPI-1", future);

    const defaultQueue = JSON.parse(
      text(await client.callTool({ name: "triage_queue", arguments: {} })),
    );
    expect(defaultQueue).toHaveLength(0);

    const withSnoozed = JSON.parse(
      text(
        await client.callTool({
          name: "triage_queue",
          arguments: { include_snoozed: true },
        }),
      ),
    );
    expect(withSnoozed).toHaveLength(1);
    expect(withSnoozed[0].ref).toBe("AIPI-1");
  });

  it("request_human_input sets needs-input and clears when a human comments", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Ambiguous requirement",
        description: "Not sure whether to support multi-tenant here; needs a human decision.",
        source_type: "manual",
        source_detail: "x",
      },
    });
    const escalated = JSON.parse(
      text(
        await client.callTool({
          name: "request_human_input",
          arguments: { ref: "AIPI-1", question: "Should this support multi-tenant configs?" },
        }),
      ),
    );
    expect(escalated.needsInput).toBe(true);

    const fetched = JSON.parse(
      text(await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } })),
    );
    expect(fetched.needsInput).toBe(true);
    expect(fetched.activity.some((e: { type: string }) => e.type === "needs_input_set")).toBe(true);
    expect(
      fetched.activity.some(
        (e: { type: string; payload: { body: string } }) =>
          e.type === "comment" && e.payload.body === "Should this support multi-tenant configs?",
      ),
    ).toBe(true);

    const humanClient = await connect(human);
    await humanClient.callTool({
      name: "comment",
      arguments: { ref: "AIPI-1", body: "No, single-tenant is fine." },
    });

    const cleared = JSON.parse(
      text(await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } })),
    );
    expect(cleared.needsInput).toBe(false);
  });

  it("attach_file decodes base64, saves the attachment, and returns a markdown snippet", async () => {
    const attachmentsDir = mkdtempSync(path.join(tmpdir(), "syd-mcp-attachments-"));
    try {
      const humanClient = await connect(human);
      await humanClient.callTool({
        name: "file_issue",
        arguments: { project_key: "AIPI", title: "Evidence needed" },
      });
      const attachClient = await connect(agent, attachmentsDir);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const r = await attachClient.callTool({
        name: "attach_file",
        arguments: {
          ref: "AIPI-1",
          filename: "evidence.png",
          content_base64: png.toString("base64"),
        },
      });
      const result = JSON.parse(text(r)) as { markdown: string; url: string };
      expect(result.url).toMatch(/^\/api\/attachments\/\d+\/evidence\.png$/);
      expect(result.markdown).toBe(`![evidence.png](${result.url})`);

      const id = result.url.split("/")[3];
      const onDisk = readFileSync(path.join(attachmentsDir, id));
      expect(onDisk.equals(png)).toBe(true);

      const issue = JSON.parse(
        text(await client.callTool({ name: "get_issue", arguments: { ref: "AIPI-1" } })),
      );
      expect(issue.activity.some((e: { type: string }) => e.type === "attachment_added")).toBe(
        true,
      );
    } finally {
      rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("attach_file rejects invalid base64 legibly", async () => {
    const attachmentsDir = mkdtempSync(path.join(tmpdir(), "syd-mcp-attachments-"));
    try {
      const humanClient = await connect(human);
      await humanClient.callTool({
        name: "file_issue",
        arguments: { project_key: "AIPI", title: "Evidence needed" },
      });
      const attachClient = await connect(agent, attachmentsDir);
      const r = await attachClient.callTool({
        name: "attach_file",
        arguments: {
          ref: "AIPI-1",
          filename: "evidence.png",
          content_base64: "not-valid-base64!!!",
        },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not valid base64/i);
    } finally {
      rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("search_issues supports needs_input filter", async () => {
    await client.callTool({
      name: "file_issue",
      arguments: {
        project_key: "AIPI",
        title: "Blocked on decision",
        description: "Needs a human decision before proceeding.",
        source_type: "manual",
        source_detail: "x",
      },
    });
    await client.callTool({
      name: "request_human_input",
      arguments: { ref: "AIPI-1", question: "Which approach?" },
    });
    const r = await client.callTool({ name: "search_issues", arguments: { needs_input: true } });
    const results = JSON.parse(text(r));
    expect(results).toHaveLength(1);
    expect(results[0].ref).toBe("AIPI-1");
  });

  describe("progress_note (SYD-43)", () => {
    it("records a progress_note event on the activity feed", async () => {
      const filed = JSON.parse(
        text(
          await client.callTool({
            name: "file_issue",
            arguments: {
              project_key: "AIPI",
              title: "T",
              description: "d",
              source_type: "session",
            },
          }),
        ),
      );
      const r = await client.callTool({
        name: "progress_note",
        arguments: { ref: filed.ref, note: "tests written, implementing the service" },
      });
      expect(JSON.parse(text(r))).toEqual({ ok: true });
      const ev = getActivity(db, filed.ref).find((a) => a.type === "progress_note");
      expect(ev?.payload).toEqual({ note: "tests written, implementing the service" });
    });

    it("returns an isError result for an empty note", async () => {
      const filed = JSON.parse(
        text(
          await client.callTool({
            name: "file_issue",
            arguments: {
              project_key: "AIPI",
              title: "T2",
              description: "d",
              source_type: "session",
            },
          }),
        ),
      );
      const r = await client.callTool({
        name: "progress_note",
        arguments: { ref: filed.ref, note: " " },
      });
      expect(r.isError).toBe(true);
    });
  });
});
