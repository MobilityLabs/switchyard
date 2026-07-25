import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue, getIssue, toView, SUMMARY_MAX_LENGTH } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";

let db: Db, human: Actor, agent: Actor;
beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  agent = createActor(db, { name: "claude/worker", type: "agent" }).actor;
  createProject(db, human, { key: "AIPI", name: "aipi" });
});

describe("createIssue", () => {
  it("human-created issues land in backlog with a ref and a created event", () => {
    const issue = createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    expect(issue.ref).toBe("AIPI-1");
    expect(issue.status).toBe("backlog");
    const ev = listIssueEvents(db, issue.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "created", actorName: "sean" });
  });

  it("agent-created issues require provenance and land in triage", () => {
    expect(() => createIssue(db, agent, { projectKey: "AIPI", title: "Flaky test" })).toThrowError(
      /provenance/i,
    );
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Flaky test in api suite",
      description:
        "api_test.ts fails intermittently under load; likely a shared-state race. Suggest isolating fixtures.",
      provenance: { sourceType: "todo", detail: "src/api.ts:88" },
    });
    expect(issue.status).toBe("triage");
    expect(issue.sourceType).toBe("todo");
  });

  it("agent-created issues require a description a human can triage from", () => {
    expect(() =>
      createIssue(db, agent, {
        projectKey: "AIPI",
        title: "Flaky test in api suite",
        provenance: { sourceType: "todo", detail: "src/api.ts:88" },
      }),
    ).toThrowError(/description a human can triage from/i);
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Flaky test in api suite",
      description:
        "api_test.ts fails intermittently under load; likely a shared-state race. Suggest isolating fixtures.",
      provenance: { sourceType: "todo", detail: "src/api.ts:88" },
    });
    expect(issue.status).toBe("triage");
  });

  it("rejects agent-supplied provenance urls that aren't http(s) and accepts http(s) urls", () => {
    expect(() =>
      createIssue(db, agent, {
        projectKey: "AIPI",
        title: "Malicious link",
        description:
          "Filed via a suspicious webhook payload containing a javascript: URL; flagging for review before trusting the source.",
        provenance: { sourceType: "manual", url: "javascript:alert(1)" },
      }),
    ).toThrowError(/must be http/i);
    const issue = createIssue(db, agent, {
      projectKey: "AIPI",
      title: "Safe link",
      description:
        "CI run linked below shows the failing build; needs a human to confirm before we retry the deploy.",
      provenance: { sourceType: "manual", url: "https://example.com/run/123" },
    });
    expect(issue.sourceUrl).toBe("https://example.com/run/123");
  });

  it("getIssue round-trips by ref and rejects unknown refs legibly", () => {
    createIssue(db, human, { projectKey: "AIPI", title: "One" });
    expect(getIssue(db, "AIPI-1").title).toBe("One");
    expect(() => getIssue(db, "AIPI-99")).toThrowError(/AIPI-99 does not exist/);
    expect(() => getIssue(db, "banana")).toThrowError(/like "AIPI-42"/);
  });

  it("stores a summary when given one, and leaves it null when omitted", () => {
    const withSummary = createIssue(db, human, {
      projectKey: "AIPI",
      title: "Ship v1",
      summary: "Ship the first cut of v1.",
    });
    expect(withSummary.summary).toBe("Ship the first cut of v1.");

    const withoutSummary = createIssue(db, human, { projectKey: "AIPI", title: "Ship v2" });
    expect(withoutSummary.summary).toBeNull();
  });

  it("rejects a summary over the length cap", () => {
    const tooLong = "x".repeat(SUMMARY_MAX_LENGTH + 1);
    expect(() =>
      createIssue(db, human, { projectKey: "AIPI", title: "Ship v1", summary: tooLong }),
    ).toThrowError(/summary/i);

    const atCap = "x".repeat(SUMMARY_MAX_LENGTH);
    expect(
      createIssue(db, human, { projectKey: "AIPI", title: "Ship v1", summary: atCap }).summary,
    ).toBe(atCap);
  });

  // SYD-239: dispatch containers have no browser, so they cannot produce the
  // screenshot SYD-183 asks for on UI work. Defaulting `ui` issues to
  // "interactive" routes them to a human-attended session that has one —
  // worker-select's INTERACTIVE_PREFERENCE skip does the actual refusing.
  it("defaults workerPreference to interactive for a ui-labelled issue", () => {
    const issue = createIssue(db, human, {
      projectKey: "AIPI",
      title: "Fix the board column widths",
      labels: ["ui"],
    });
    expect(issue.workerPreference).toBe("interactive");
  });

  // Guard, not a driver: the default must stay a fallback. Swapping the
  // precedence in createIssue (default ?? input instead of input ?? default)
  // would make this fail, and would silently un-dispatch UI work a human had
  // deliberately routed to an engine.
  it("lets an explicit workerPreference win over the ui-label default", () => {
    const issue = createIssue(db, human, {
      projectKey: "AIPI",
      title: "Mechanical class rename across the views",
      labels: ["ui"],
      workerPreference: "codex",
    });
    expect(issue.workerPreference).toBe("codex");
  });

  it("leaves workerPreference unset for an issue with no interactive-only label", () => {
    const issue = createIssue(db, human, {
      projectKey: "AIPI",
      title: "Tighten the dispatch poll",
      labels: ["dispatch"],
    });
    expect(issue.workerPreference).toBeNull();
  });

  it("toView throws SwitchyardError instead of crashing when the issue's project row is missing (SYD-146)", () => {
    const issue = createIssue(db, human, { projectKey: "AIPI", title: "Ship v1" });
    const orphanRow = { ...issue, projectId: 999999 };
    expect(() => toView(db, orphanRow)).toThrowError(/references a missing project/i);
  });
});
