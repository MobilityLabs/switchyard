// `syd affirm <REF>` — fetch a parked action, render it, sign the exact bytes
// with a FIDO key, POST the signature.
//
// Why a terminal command is safe here when Phase 1 needed a browser: a hardware
// signature is something Claude cannot forge. Claude may run this command; it
// just pops a PIN/touch prompt on a key it does not have. That inverts the
// original design's pillar 5 — the terminal becomes both lower-friction and a
// stronger boundary than the cookie.
//
// This is a CLIENT CLI — HTTP to the server, not a db path first-arg like
// src/cli.ts. The human runs this on their Mac; the tracker lives on the NAS.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { AFFIRM_NAMESPACE } from "./services/canonical-action.js";

const BASE = process.env.SWITCHYARD_URL ?? "http://localhost:3300";
const TOKEN = process.env.SWITCHYARD_TOKEN;
// homedir() rather than reading the HOME environment variable directly:
// tests/env-example.test.ts (SYD-141) scans this directory's source TEXT for
// env-var reads and requires each one to be documented in .env.example, so
// reading HOME here would demand documenting an OS var as app config — and,
// because the scan is textual, even naming it in a comment trips the check.
// homedir() is the correct API regardless: it also works on Windows, where
// HOME is unset.
const KEY = process.env.SWITCHYARD_AFFIRM_KEY ?? join(homedir(), ".ssh", "id_ed25519_sk");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  // Only one positional arg: the ref. The npm script itself is named "affirm"
  // (`npm run affirm -- <REF>`), so argv[2..] is just [<REF>] — there is no
  // separate "affirm" subcommand literal to peel off here. (`process.argv.slice(2)`
  // confirmed empirically: `npm run affirm -- SYD-999` hands the script exactly
  // one arg, "SYD-999".)
  const [ref] = process.argv.slice(2);
  if (!ref) die("usage: npm run affirm -- <REF>    (e.g. SYD-42)");
  if (!TOKEN) die("SWITCHYARD_TOKEN is required — export your human bearer token.");

  const res = await fetch(`${BASE}/api/pending-actions?status=pending`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) die(`Could not read the approval queue: ${res.status} ${await res.text()}`);
  const queue = (await res.json()) as {
    id: number;
    issueRef: string | null;
    issueStatus: string | null;
    actionType: string;
    canonical: string | null;
    viaAgentName: string | null;
    sessionId: number;
    expiresAt: number;
  }[];

  const row = queue.find((r) => r.issueRef === ref.toUpperCase());
  if (!row) die(`Nothing is awaiting affirmation for ${ref}.`);
  if (!row.canonical) die(`Pending action ${row.id} is not renderable — its issue may have been deleted.`);

  const left = row.expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) die(`That action expired ${-left}s ago. Ask the session to re-propose it.`);

  // READ THIS BEFORE YOU TOUCH THE KEY. The key attests that you approved these
  // bytes; it cannot tell you what they mean. This block is the only place the
  // action is shown in human terms — it is the sole mitigation for "a human who
  // approves without reading," a failure cryptography cannot fix.
  const action = JSON.parse(row.canonical) as { expectedHeadSha?: string };
  const current = row.issueStatus ?? "unknown";
  console.log("");
  console.log(`  ${row.issueRef}   ${current}  ->  ${row.actionType.toUpperCase()}`);
  console.log(`  proposed by : ${row.viaAgentName ?? "unknown agent"} (session #${row.sessionId})`);
  console.log(`  PR head     : ${action.expectedHeadSha ?? "(not pinned)"}`);
  console.log(`  expires in  : ${left}s`);
  console.log("");
  console.log("  Your key will ask for a PIN or fingerprint, depending on your key.");
  console.log("");

  let signature: string;
  try {
    signature = execFileSync("ssh-keygen", ["-Y", "sign", "-f", KEY, "-n", AFFIRM_NAMESPACE, "-"], {
      input: row.canonical,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"], // stderr inherited so the touch prompt is visible
    });
  } catch {
    die(`Signing failed. Is your key at ${KEY}? Override with SWITCHYARD_AFFIRM_KEY.`);
  }

  // The bearer proves who is ASKING to affirm, not who approved — that's the
  // signature's job. Holding a syd_ token alone is no longer sufficient to
  // affirm a gated action, which is exactly why a Bearer-authed CLI is safe
  // here where the Phase 1 web route needed a browser cookie (see
  // src/rest/pending-actions.ts). The server never claims to have verified
  // presence — it can't (research doc §3) — only that this signature matches
  // these bytes; presence is enforced by the token at signing time.
  const post = await fetch(`${BASE}/api/pending-actions/${row.id}/affirm-signed`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  if (!post.ok) die(`Affirmation refused: ${post.status} ${(await post.json()).error ?? ""}`);
  console.log(`Affirmed. ${row.issueRef} is ${row.actionType}.`);
}

main().catch((e) => die(String(e)));
