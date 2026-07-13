import path from "node:path";
import { promises as fs, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { attachments, actors } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";
import { getIssue } from "./issues.js";
import { recordEvent } from "./events.js";

// SVG is deliberately excluded — it's an XSS vector (can carry <script>/event
// handlers and gets treated as markup, not a raster image, by some renderers).
export const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB

export function defaultAttachmentsDir(): string {
  return process.env.ATTACHMENTS_DIR ?? "./attachments";
}

function extensionOf(filename: string): string {
  return path.extname(filename).replace(/^\./, "").toLowerCase();
}

// Basename + strip anything but alphanumerics/dot/dash/underscore, so the
// stored filename can't traverse directories or carry shell/HTML metacharacters.
function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).trim();
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const safeStem = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
  return ext ? `${safeStem}.${ext}` : safeStem;
}

export type AttachmentRow = typeof attachments.$inferSelect;

export async function saveAttachment(
  db: Db,
  actor: Actor,
  ref: string,
  filename: string,
  data: Buffer,
  attachmentsDir: string,
): Promise<{ attachment: AttachmentRow; markdown: string }> {
  const sanitized = sanitizeFilename(filename);
  const ext = extensionOf(sanitized);

  if (ext === "svg") {
    throw new SwitchyardError(
      "SVG attachments are rejected — SVG can embed scripts and is an XSS vector. Convert to a raster format (PNG/JPEG) and try again.",
    );
  }
  const contentType = ALLOWED_ATTACHMENT_TYPES[ext];
  if (!contentType) {
    throw new SwitchyardError(
      `".${ext || "?"}" is not an allowed attachment type — allowed types: ${Object.keys(ALLOWED_ATTACHMENT_TYPES).join(", ")}.`,
    );
  }
  if (data.length > MAX_ATTACHMENT_SIZE) {
    throw new SwitchyardError(
      `Attachment is ${(data.length / (1024 * 1024)).toFixed(1)}MB — attachments must be 20MB or smaller.`,
    );
  }

  // Durability ordering (SYD-192): events is an append-only audit log, so
  // attachment_added must never be recorded for bytes that aren't on disk —
  // and once recorded it cannot be deleted. Write the bytes to a temp path
  // BEFORE touching the DB (this is where the realistic failures — perms,
  // disk full, bad dir — happen), then insert the row + event and rename the
  // temp file to its id-named path as the LAST step inside the synchronous
  // transaction: if the rename throws, the transaction rolls back and neither
  // the row nor the event survives. The only remaining crash window (after
  // rename, before commit) leaves a file with no DB row — a harmless orphan,
  // unlike an event that points at a file that doesn't exist.
  await fs.mkdir(attachmentsDir, { recursive: true });
  const tmpPath = path.join(attachmentsDir, `.tmp-${randomUUID()}`);
  await fs.writeFile(tmpPath, data);

  let row: AttachmentRow;
  try {
    row = db.transaction((tx) => {
      const issue = getIssue(tx, ref);
      const inserted = tx
        .insert(attachments)
        .values({
          issueId: issue.id,
          actorId: actor.id,
          filename: sanitized,
          contentType,
          size: data.length,
        })
        .returning()
        .get();
      recordEvent(tx, {
        issueId: issue.id,
        actorId: actor.id,
        type: "attachment_added",
        payload: { id: inserted.id, filename: sanitized, size: data.length, contentType },
      });
      renameSync(tmpPath, path.join(attachmentsDir, String(inserted.id)));
      return inserted;
    });
  } catch (err) {
    // A file with no DB row is a harmless orphan, but don't accumulate temp
    // files. If the rename already happened (commit-time failure), the temp
    // is gone and this is a no-op.
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const url = `/api/attachments/${row.id}/${row.filename}`;
  const markdown = VIDEO_EXTENSIONS.has(ext)
    ? `[${row.filename}](${url})`
    : `![${row.filename}](${url})`;
  return { attachment: row, markdown };
}

export function getAttachment(db: Db, id: number): AttachmentRow {
  const row = db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) {
    throw new SwitchyardError(`Attachment ${id} does not exist.`);
  }
  return row;
}

export type AttachmentView = {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  actorName: string;
  createdAt: number;
};

/** All attachments on an issue, oldest first — covers orphans that no comment
 * embeds, and lets the UI render an attachments strip alongside the activity
 * feed's per-event links. */
export function listAttachments(db: Db, ref: string): AttachmentView[] {
  const issue = getIssue(db, ref);
  return db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      contentType: attachments.contentType,
      size: attachments.size,
      createdAt: attachments.createdAt,
      actorName: actors.name,
    })
    .from(attachments)
    .innerJoin(actors, eq(attachments.actorId, actors.id))
    .where(eq(attachments.issueId, issue.id))
    .orderBy(asc(attachments.id))
    .all();
}
