/**
 * Import a Linear workspace into a Switchyard database (SYD-37).
 *
 * usage: npx tsx scripts/import-linear.ts <db-path> [--dry-run] [--team KEY]
 *
 * Read-only against Linear. Requires LINEAR_API_KEY in the environment (never
 * pass the key as an argument). Idempotent: re-running skips issues already
 * imported (matched by Linear issue id in provenance).
 */
import { openDb } from "../src/db/index.js";
import { SwitchyardError } from "../src/services/errors.js";
import { defaultAttachmentsDir } from "../src/services/attachments.js";
import {
  buildImportPlan,
  executeImportPlan,
  renderPlan,
} from "../src/services/linear-import.js";
import { fetchLinearExport, downloadUpload } from "./import-linear-lib.js";

function usage(): never {
  console.log("usage: npx tsx scripts/import-linear.ts <db-path> [--dry-run] [--team KEY]");
  console.log("       LINEAR_API_KEY must be set in the environment.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const teamFlag = args.indexOf("--team");
const teamKey = teamFlag !== -1 ? args[teamFlag + 1] : undefined;
if (teamFlag !== -1 && !teamKey) usage();
const positional = args.filter(
  (a, i) => !a.startsWith("--") && (teamFlag === -1 || i !== teamFlag + 1),
);
const dbPath = positional[0];
if (!dbPath || positional.length !== 1) usage();

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error("error: LINEAR_API_KEY is not set — export it (e.g. from .env) and re-run.");
  process.exit(1);
}

try {
  console.log(`Fetching workspace from Linear${teamKey ? ` (team ${teamKey})` : ""}...`);
  const data = await fetchLinearExport({ apiKey, teamKey });
  const db = openDb(dbPath);
  const plan = buildImportPlan(db, data);
  console.log("\n" + renderPlan(plan) + "\n");

  if (dryRun) {
    console.log("Dry run — nothing written.");
    process.exit(0);
  }

  const report = await executeImportPlan(db, plan, {
    download: (url) => downloadUpload(url, apiKey),
    attachmentsDir: defaultAttachmentsDir(),
  });
  console.log(
    `Imported: ${report.projectsCreated} projects, ${report.actorsCreated} actors, ` +
      `${report.issuesCreated} issues, ${report.commentsCreated} comments, ` +
      `${report.dependenciesCreated} dependencies, ${report.attachmentsCreated} attachments ` +
      `(${report.skipped} skipped).`,
  );
  if (report.warnings.length) {
    console.log("Warnings:");
    for (const w of report.warnings) console.log(`  ${w}`);
  }
} catch (err) {
  if (err instanceof SwitchyardError) {
    console.error("error:", err.message);
    process.exit(1);
  }
  throw err;
}
