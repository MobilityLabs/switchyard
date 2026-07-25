import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/index.js";
import {
  actors,
  attachments,
  dependencies,
  events,
  issues,
  projects,
} from "../../src/db/schema.js";
import { SwitchyardError } from "../../src/services/errors.js";
import { createActor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { getIssue } from "../../src/services/issues.js";
import { listIssueEvents } from "../../src/services/events.js";
import {
  mapStateToStatus,
  mapPriority,
  buildImportPlan,
  executeImportPlan,
  extractUploadEmbeds,
  renderPlan,
  type LinearExport,
} from "../../src/services/linear-import.js";

// 1x1 transparent PNG — a real, valid payload for saveAttachment.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Two teams, three issues covering parent/child, blocks + related relations,
 * labels, comments (incl. a null author), embedded uploads, and file + link
 * attachment entities. */
function fixture(): LinearExport {
  return {
    orgName: "Acme Inc.",
    orgUrlKey: "acme",
    teams: [
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t2", key: "OPS", name: "Operations" },
    ],
    states: [
      { id: "s1", name: "Todo", type: "unstarted", teamKey: "ENG" },
      { id: "s2", name: "Done", type: "completed", teamKey: "ENG" },
      { id: "s3", name: "In Review", type: "started", teamKey: "ENG" },
      { id: "s4", name: "Todo", type: "unstarted", teamKey: "OPS" },
    ],
    users: [
      { id: "u1", name: "Sean Perkins", displayName: "sean", email: "sean@acme.com", active: true },
      { id: "u2", name: "Jane Doe", displayName: "jane", email: "jane@acme.com", active: true },
    ],
    issues: [
      {
        id: "lin-eng-1",
        identifier: "ENG-1",
        number: 1,
        teamKey: "ENG",
        title: "Ship the widget",
        description: "See diagram.\n\n![diagram.png](https://uploads.linear.app/aa/bb/cc)\n",
        priority: 2,
        stateName: "Done",
        stateType: "completed",
        assigneeId: "u2",
        creatorId: "u1",
        labels: ["Bug"],
        parentIdentifier: null,
        createdAt: "2025-05-01T10:00:00.000Z",
        updatedAt: "2025-05-02T11:30:00.000Z",
        comments: [
          {
            id: "lin-c1",
            body: "On it.",
            authorId: "u2",
            createdAt: "2025-05-01T12:00:00.000Z",
          },
          {
            id: "lin-c2",
            body: "Automated note.",
            authorId: null,
            createdAt: "2025-05-01T13:00:00.000Z",
          },
        ],
        relations: [],
        attachments: [
          { id: "lin-a1", title: "screenshot.png", url: "https://uploads.linear.app/dd/ee/ff" },
          { id: "lin-a2", title: "PR #5", url: "https://github.com/acme/widget/pull/5" },
        ],
      },
      {
        id: "lin-eng-2",
        identifier: "ENG-2",
        number: 2,
        teamKey: "ENG",
        title: "Widget follow-up",
        description: "",
        priority: 4,
        stateName: "In Review",
        stateType: "started",
        assigneeId: null,
        creatorId: null,
        labels: [],
        parentIdentifier: "ENG-1",
        createdAt: "2025-05-03T09:00:00.000Z",
        updatedAt: "2025-05-03T09:00:00.000Z",
        comments: [],
        relations: [
          { type: "blocks", relatedIdentifier: "OPS-7" },
          { type: "related", relatedIdentifier: "ENG-1" },
        ],
        attachments: [],
      },
      {
        id: "lin-ops-7",
        identifier: "OPS-7",
        number: 7,
        teamKey: "OPS",
        title: "Roll out the widget",
        description: "Waits on ENG-2.",
        priority: 0,
        stateName: "Todo",
        stateType: "unstarted",
        assigneeId: null,
        creatorId: "u1",
        labels: [],
        parentIdentifier: null,
        createdAt: "2025-05-04T08:00:00.000Z",
        updatedAt: "2025-05-04T08:00:00.000Z",
        comments: [],
        relations: [],
        attachments: [],
      },
    ],
  };
}

describe("mapStateToStatus", () => {
  it("maps each Linear state type to the matching Switchyard status", () => {
    expect(mapStateToStatus({ name: "Triage", type: "triage" })).toBe("triage");
    expect(mapStateToStatus({ name: "Backlog", type: "backlog" })).toBe("backlog");
    expect(mapStateToStatus({ name: "Todo", type: "unstarted" })).toBe("todo");
    expect(mapStateToStatus({ name: "In Progress", type: "started" })).toBe("in_progress");
    expect(mapStateToStatus({ name: "Done", type: "completed" })).toBe("done");
    expect(mapStateToStatus({ name: "Canceled", type: "canceled" })).toBe("canceled");
  });

  it("maps duplicate-type states to canceled", () => {
    expect(mapStateToStatus({ name: "Duplicate", type: "duplicate" })).toBe("canceled");
  });

  it("maps started states named like review to in_review", () => {
    expect(mapStateToStatus({ name: "In Review", type: "started" })).toBe("in_review");
    expect(mapStateToStatus({ name: "Code Review", type: "started" })).toBe("in_review");
    expect(mapStateToStatus({ name: "Reviewing", type: "started" })).toBe("in_review");
  });

  it("does not apply the review override outside started states", () => {
    expect(mapStateToStatus({ name: "Review Backlog", type: "backlog" })).toBe("backlog");
  });

  it("rejects unknown state types legibly", () => {
    expect(() => mapStateToStatus({ name: "Weird", type: "someday" })).toThrowError(
      SwitchyardError,
    );
    expect(() => mapStateToStatus({ name: "Weird", type: "someday" })).toThrowError(/someday/);
  });
});

describe("mapPriority", () => {
  it("maps Linear priority numbers to Switchyard priorities", () => {
    expect(mapPriority(0)).toBe("none");
    expect(mapPriority(1)).toBe("urgent");
    expect(mapPriority(2)).toBe("high");
    expect(mapPriority(3)).toBe("medium");
    expect(mapPriority(4)).toBe("low");
  });

  it("falls back to none for out-of-range values", () => {
    expect(mapPriority(5)).toBe("none");
    expect(mapPriority(-1)).toBe("none");
  });
});

describe("buildImportPlan", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("plans projects, actors, issues, dependencies, and warnings from a fresh export", () => {
    const plan = buildImportPlan(db, fixture());

    expect(plan.projects).toEqual([
      { key: "ENG", name: "Engineering", exists: false },
      { key: "OPS", name: "Operations", exists: false },
    ]);
    expect(plan.actors.map((a) => a.name).sort()).toEqual(["jane", "linear-import", "sean"]);
    expect(plan.actors.every((a) => !a.exists)).toBe(true);

    expect(plan.issues.map((i) => i.ref)).toEqual(["ENG-1", "ENG-2", "OPS-7"]);
    const eng1 = plan.issues[0];
    expect(eng1.number).toBe(1);
    expect(eng1.status).toBe("done");
    expect(eng1.priority).toBe("high");
    expect(eng1.labels).toEqual(["Bug"]);
    expect(eng1.creatorName).toBe("sean");
    expect(eng1.assigneeName).toBe("jane");
    expect(eng1.createdAt).toBe(Math.floor(Date.parse("2025-05-01T10:00:00.000Z") / 1000));
    expect(eng1.comments).toHaveLength(2);
    expect(eng1.comments[0]).toMatchObject({ linearId: "lin-c1", authorName: "jane" });
    expect(eng1.comments[1].authorName).toBe("linear-import");
    expect(eng1.fileAttachments).toEqual([
      { title: "screenshot.png", url: "https://uploads.linear.app/dd/ee/ff" },
    ]);
    expect(eng1.linkAttachments).toEqual([
      { title: "PR #5", url: "https://github.com/acme/widget/pull/5" },
    ]);

    const eng2 = plan.issues[1];
    expect(eng2.status).toBe("in_review");
    expect(eng2.priority).toBe("low");
    expect(eng2.parentRef).toBe("ENG-1");
    expect(eng2.creatorName).toBe("linear-import");

    expect(plan.dependencies).toEqual([{ blockerRef: "ENG-2", blockedRef: "OPS-7" }]);
    expect(plan.warnings.some((w) => /related/.test(w) && /ENG-2/.test(w))).toBe(true);
    expect(plan.skipped).toEqual([]);
  });

  it("marks existing projects/actors and skips already-imported issues", () => {
    const sean = createActor(db, { name: "sean", type: "human" }).actor;
    const project = createProject(db, sean, { key: "ENG", name: "Engineering" });
    db.insert(issues)
      .values({
        projectId: project.id,
        number: 1,
        title: "Ship the widget",
        status: "done",
        creatorId: sean.id,
        sourceType: "manual",
        sourceDetail: "linear:lin-eng-1",
      })
      .run();

    const plan = buildImportPlan(db, fixture());
    expect(plan.projects.find((p) => p.key === "ENG")?.exists).toBe(true);
    expect(plan.projects.find((p) => p.key === "OPS")?.exists).toBe(false);
    expect(plan.actors.find((a) => a.name === "sean")?.exists).toBe(true);
    expect(plan.skipped).toEqual([{ ref: "ENG-1", reason: "already imported (linear:lin-eng-1)" }]);
    expect(plan.issues.map((i) => i.ref)).toEqual(["ENG-2", "OPS-7"]);
  });

  it("refuses a number collision with a non-imported issue", () => {
    const sean = createActor(db, { name: "sean", type: "human" }).actor;
    const project = createProject(db, sean, { key: "ENG", name: "Engineering" });
    db.insert(issues)
      .values({
        projectId: project.id,
        number: 1,
        title: "Unrelated local issue",
        status: "todo",
        creatorId: sean.id,
      })
      .run();

    expect(() => buildImportPlan(db, fixture())).toThrowError(SwitchyardError);
    expect(() => buildImportPlan(db, fixture())).toThrowError(/ENG-1/);
  });

  it("refuses team keys that are not valid Switchyard project keys", () => {
    const data = fixture();
    data.teams[0] = { id: "t1", key: "E2", name: "Engineering" };
    expect(() => buildImportPlan(db, data)).toThrowError(SwitchyardError);
    expect(() => buildImportPlan(db, data)).toThrowError(/E2/);
  });
});

describe("renderPlan", () => {
  it("prints the full mapping: projects, states, actors, issues, deps, skips, warnings", () => {
    const db = openDb(":memory:");
    const plan = buildImportPlan(db, fixture());
    const text = renderPlan(plan);

    expect(text).toContain("Acme Inc.");
    expect(text).toContain("ENG: Engineering (new)");
    expect(text).toContain("[ENG] In Review (started) → in_review");
    expect(text).toContain("sean (new)");
    expect(text).toMatch(/ENG-1 \[done\/high\] Ship the widget/);
    expect(text).toContain("ENG-2 blocks OPS-7");
    expect(text).toMatch(/related/); // warning listed
  });
});

describe("extractUploadEmbeds", () => {
  it("finds image and link embeds pointing at uploads.linear.app, including <>-wrapped URLs", () => {
    const md =
      "![diagram.png](https://uploads.linear.app/aa/bb/cc)\n" +
      "[video.mp4](<https://uploads.linear.app/dd/ee/ff>)\n" +
      "![external](https://example.com/img.png)\n";
    expect(extractUploadEmbeds(md)).toEqual([
      { filename: "diagram.png", url: "https://uploads.linear.app/aa/bb/cc" },
      { filename: "video.mp4", url: "https://uploads.linear.app/dd/ee/ff" },
    ]);
  });
});

describe("executeImportPlan", () => {
  let db: Db;
  let dir: string;
  const download = async () => ({ data: PNG });

  beforeEach(() => {
    db = openDb(":memory:");
    dir = mkdtempSync(join(tmpdir(), "syd-linear-import-"));
  });

  async function run(data = fixture()) {
    const plan = buildImportPlan(db, data);
    return executeImportPlan(db, plan, { download, attachmentsDir: dir });
  }

  it("creates projects with preserved keys and bumps the issue counter past imported numbers", async () => {
    const report = await run();
    expect(report.projectsCreated).toBe(2);
    const eng = db.select().from(projects).where(eq(projects.key, "ENG")).get();
    const ops = db.select().from(projects).where(eq(projects.key, "OPS")).get();
    expect(eng?.nextIssueNumber).toBe(3);
    expect(ops?.nextIssueNumber).toBe(8);
  });

  it("creates tokenless human actors for Linear users", async () => {
    await run();
    const rows = db.select().from(actors).all();
    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const name of ["sean", "jane", "linear-import"]) {
      expect(byName.get(name)?.type).toBe("human");
      expect(byName.get(name)?.tokenHash).toBeNull();
    }
  });

  it("preserves refs, fields, provenance, and timestamps on imported issues", async () => {
    const report = await run();
    expect(report.issuesCreated).toBe(3);

    const eng1 = getIssue(db, "ENG-1");
    expect(eng1.number).toBe(1);
    expect(eng1.title).toBe("Ship the widget");
    expect(eng1.status).toBe("done");
    expect(eng1.priority).toBe("high");
    expect(eng1.labels).toEqual(["Bug"]);
    expect(eng1.sourceType).toBe("manual");
    expect(eng1.sourceDetail).toBe("linear:lin-eng-1");
    expect(eng1.sourceUrl).toBe("https://linear.app/acme/issue/ENG-1");
    expect(eng1.createdAt).toBe(Math.floor(Date.parse("2025-05-01T10:00:00.000Z") / 1000));
    expect(eng1.updatedAt).toBe(Math.floor(Date.parse("2025-05-02T11:30:00.000Z") / 1000));

    const sean = db.select().from(actors).where(eq(actors.name, "sean")).get();
    const jane = db.select().from(actors).where(eq(actors.name, "jane")).get();
    expect(eng1.creatorId).toBe(sean?.id);
    expect(eng1.assigneeId).toBe(jane?.id);

    expect(getIssue(db, "OPS-7").number).toBe(7);
  });

  it("writes created and comment events with original authorship, timestamps, and linear ids", async () => {
    const report = await run();
    expect(report.commentsCreated).toBe(2);

    const eng1 = getIssue(db, "ENG-1");
    const evts = listIssueEvents(db, eng1.id);
    const created = evts.find((e) => e.type === "created");
    expect(created?.actorName).toBe("sean");
    expect(created?.createdAt).toBe(Math.floor(Date.parse("2025-05-01T10:00:00.000Z") / 1000));

    const comments = evts.filter((e) => e.type === "comment");
    expect(comments).toHaveLength(2);
    expect(comments[0].actorName).toBe("jane");
    expect(comments[0].payload).toMatchObject({ body: "On it.", linearId: "lin-c1" });
    expect(comments[0].createdAt).toBe(Math.floor(Date.parse("2025-05-01T12:00:00.000Z") / 1000));
    expect(comments[1].actorName).toBe("linear-import");
  });

  it("links sub-issues and creates dependencies with events", async () => {
    const report = await run();
    expect(report.dependenciesCreated).toBe(1);

    const eng1 = getIssue(db, "ENG-1");
    const eng2 = getIssue(db, "ENG-2");
    const ops7 = getIssue(db, "OPS-7");
    expect(eng2.parentId).toBe(eng1.id);

    const dep = db.select().from(dependencies).all();
    expect(dep).toEqual([{ blockerId: eng2.id, blockedId: ops7.id }]);
    const blockedEvts = listIssueEvents(db, ops7.id).filter((e) => e.type === "blocked_by_added");
    expect(blockedEvts).toHaveLength(1);
    expect(blockedEvts[0].payload).toMatchObject({ blocker: "ENG-2" });
  });

  it("re-uploads embedded and attached files, rewrites URLs, and appends link attachments", async () => {
    const report = await run();
    expect(report.attachmentsCreated).toBe(2);

    const eng1 = getIssue(db, "ENG-1");
    expect(eng1.description).not.toContain("uploads.linear.app");
    expect(eng1.description).toMatch(/!\[diagram\.png\]\(\/api\/attachments\/\d+\/diagram\.png\)/);
    expect(eng1.description).toContain("### Imported links");
    expect(eng1.description).toContain("[PR #5](https://github.com/acme/widget/pull/5)");

    const rows = db.select().from(attachments).all();
    expect(rows.map((r) => r.filename).sort()).toEqual(["diagram.png", "screenshot.png"]);
    expect(rows.every((r) => r.issueId === eng1.id)).toBe(true);
  });

  it("keeps the original URL and warns when a file cannot be downloaded or is a disallowed type", async () => {
    const data = fixture();
    data.issues[0].description = "![notes.pdf](https://uploads.linear.app/pp/qq/rr)";
    data.issues[0].attachments = [];
    const plan = buildImportPlan(db, data);
    const report = await executeImportPlan(db, plan, {
      download: async (url) => (url.includes("/pp/") ? { data: PNG } : null),
      attachmentsDir: dir,
    });

    const eng1 = getIssue(db, "ENG-1");
    expect(eng1.description).toContain("https://uploads.linear.app/pp/qq/rr");
    expect(report.attachmentsCreated).toBe(0);
    expect(report.warnings.some((w) => w.includes("notes.pdf"))).toBe(true);
  });

  it("is a no-op on re-run over the same export", async () => {
    await run();
    const counts = () => ({
      issues: db.select().from(issues).all().length,
      events: db.select().from(events).all().length,
      attachments: db.select().from(attachments).all().length,
      deps: db.select().from(dependencies).all().length,
    });
    const before = counts();

    const plan2 = buildImportPlan(db, fixture());
    expect(plan2.issues).toEqual([]);
    expect(plan2.skipped).toHaveLength(3);
    const report2 = await executeImportPlan(db, plan2, { download, attachmentsDir: dir });
    expect(report2.issuesCreated).toBe(0);
    expect(report2.projectsCreated).toBe(0);
    expect(report2.actorsCreated).toBe(0);
    expect(counts()).toEqual(before);
  });
});
