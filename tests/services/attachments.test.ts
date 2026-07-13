import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import type { Actor } from "../../src/services/actors.js";
import { createProject } from "../../src/services/projects.js";
import { createIssue } from "../../src/services/issues.js";
import { getActivity } from "../../src/services/comments.js";
import { saveAttachment, listAttachments } from "../../src/services/attachments.js";

let db: Db;
let human: Actor;
let tmpRoot: string;

beforeEach(() => {
  db = openDb(":memory:");
  human = createActor(db, { name: "sean", type: "human" }).actor;
  createProject(db, human, { key: "SYD", name: "Switchyard" });
  createIssue(db, human, { projectKey: "SYD", title: "Needs a screenshot" });
  tmpRoot = mkdtempSync(path.join(tmpdir(), "syd-att-svc-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("saveAttachment durability ordering (SYD-192)", () => {
  it("a failed file write leaves no attachment_added event and no attachment row", async () => {
    // Put a regular file where a path component of the attachments dir must
    // go, so mkdir/writeFile fails deterministically (ENOTDIR).
    const blocker = path.join(tmpRoot, "not-a-dir");
    writeFileSync(blocker, "occupied");
    const badDir = path.join(blocker, "attachments");

    await expect(
      saveAttachment(db, human, "SYD-1", "shot.png", Buffer.from([1, 2, 3]), badDir),
    ).rejects.toThrow();

    // The events table is an append-only audit log — a write failure must not
    // have recorded attachment_added at all (deleting it later is forbidden).
    const added = getActivity(db, "SYD-1").filter((a) => a.type === "attachment_added");
    expect(added).toEqual([]);
    expect(listAttachments(db, "SYD-1")).toEqual([]);
  });

  it("success records the row, the event, and the bytes at the id-named path", async () => {
    const dir = path.join(tmpRoot, "attachments");
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { attachment, markdown } = await saveAttachment(
      db,
      human,
      "SYD-1",
      "shot.png",
      data,
      dir,
    );

    expect(readFileSync(path.join(dir, String(attachment.id))).equals(data)).toBe(true);
    const added = getActivity(db, "SYD-1").filter((a) => a.type === "attachment_added");
    expect(added).toHaveLength(1);
    expect(added[0].payload.id).toBe(attachment.id);
    expect(added[0].payload.filename).toBe("shot.png");
    expect(listAttachments(db, "SYD-1").map((a) => a.id)).toEqual([attachment.id]);
    expect(markdown).toBe(`![shot.png](/api/attachments/${attachment.id}/shot.png)`);
  });

  it("a DB failure after the bytes are written leaves no stray files behind", async () => {
    const dir = path.join(tmpRoot, "attachments");
    await expect(
      saveAttachment(db, human, "SYD-999", "shot.png", Buffer.from([1, 2, 3]), dir),
    ).rejects.toThrow(/SYD-999 does not exist/);

    // The write-first ordering may have created the dir and a temp file; the
    // failed transaction must clean the temp up so nothing accumulates. (A
    // dir that was never created also counts as "no stray files".)
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    expect(entries).toEqual([]);
    const added = getActivity(db, "SYD-1").filter((a) => a.type === "attachment_added");
    expect(added).toEqual([]);
  });
});
