#!/usr/bin/env node
// Upload a local file to a Switchyard issue as an attachment, out-of-band: the
// bytes stream straight to the tracker's REST endpoint instead of being
// base64-encoded through an MCP tool argument, which burns model output tokens
// (SYD-182). Kept standalone (and baked into the worker image as
// `switchyard-attach`) so any dispatched worker can use it regardless of the
// target repo. `uploadAttachment` is exported so it's unit-testable in-process
// without spawning a subprocess.
//
// Usage: node attach.mjs <ISSUE_REF> <FILE>
// Env:   SWITCHYARD_URL, SWITCHYARD_TOKEN  (both required; token via env, never argv)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Returns the endpoint's raw response body ({id,url,markdown} as JSON text).
// Throws on missing url/token, a missing file (ENOENT from readFile), or a
// non-2xx response.
export async function uploadAttachment({ url, token, ref, file }) {
  if (!url) throw new Error("SWITCHYARD_URL must be set");
  if (!token) throw new Error("SWITCHYARD_TOKEN must be set");

  const bytes = await readFile(file);

  const form = new FormData();
  form.set("file", new Blob([bytes]), path.basename(file));

  const endpoint = `${url.replace(/\/$/, "")}/api/issues/${ref}/attachments`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upload failed (${res.status}): ${text}`);
  }
  return text;
}

async function main() {
  const ref = process.argv[2];
  const file = process.argv[3];
  if (!ref || !file) {
    throw new Error("usage: attach.mjs <ISSUE_REF> <FILE>");
  }
  const text = await uploadAttachment({
    url: process.env.SWITCHYARD_URL,
    token: process.env.SWITCHYARD_TOKEN,
    ref,
    file,
  });
  // The endpoint returns {id,url,markdown} — print it so the caller can quote
  // the markdown snippet in a comment.
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

// Run as CLI only when invoked directly, so importing uploadAttachment in a
// test does not trigger a real upload. fetch()'s undici keep-alive agent holds
// a socket open after the response is read, keeping the event loop alive — so
// exit explicitly once the CLI is done rather than hang.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
