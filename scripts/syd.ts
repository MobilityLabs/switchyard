// A small authenticated client for the Switchyard REST API, so routine calls
// don't need a hand-assembled curl with a pasted token (SYD-280).
//
//   npx tsx scripts/syd.ts whoami
//   npx tsx scripts/syd.ts pr-link list SYD-280
//   npx tsx scripts/syd.ts pr-link declare SYD-280 226
//   npx tsx scripts/syd.ts pr-link confirm SYD-280 226
//   npx tsx scripts/syd.ts pr-link revoke  SYD-280 226 "linked the wrong PR"
//   npx tsx scripts/syd.ts api GET /issues/SYD-280
//   npx tsx scripts/syd.ts api POST /issues/SYD-1/comments '{"body":"hi"}'
//
// The token is read from the repo .env (or the ambient environment) and lives
// only in a request header — it is never an argv element, never logged, and
// never echoed, per CLAUDE.md's "tokens must never appear in argv".
//
// Token precedence is deliberate: a HUMAN token first, because the acts most
// worth having a shortcut for are the human-only ones (confirming a PR link,
// resolving a deviation). A `service` token cannot perform them at all — it is
// refused by the service layer (SYD-213) — so this warns up front rather than
// letting the server return a confusing 400.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same shape as scripts/github-poll.ts's loader: ambient env always wins. */
function loadDotEnv(): void {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch (err) {
    // .env is 0600 by design, and some sandboxes deny it outright. Say so
    // plainly instead of dying on a stack trace — the ambient environment may
    // still carry a token, so this is a warning, not a failure.
    console.error(
      `warning: could not read .env (${(err as Error).message}) — using the environment only.`,
    );
    return;
  }
  for (const line of contents.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const HUMAN_TOKEN_KEYS = ["SWITCHYARD_HUMAN_TOKEN", "SWITCHYARD_TOKEN"] as const;
const FALLBACK_TOKEN_KEYS = ["SWITCHYARD_SERVICE_TOKEN"] as const;
const ALL_TOKEN_KEYS = [...HUMAN_TOKEN_KEYS, ...FALLBACK_TOKEN_KEYS];

export type TokenChoice = { token: string; key: string; humanPreferred: boolean };

/**
 * Exported for tests: pure over an env-shaped record.
 *
 * `asKey` forces a specific variable. Worth having because which token a name
 * holds is not obvious — on this repo's own box `SWITCHYARD_HUMAN_TOKEN`
 * belongs to the `github-poller` actor, not to a person, so an unqualified
 * "human" act would be attributed to infrastructure. main() prints the
 * resolved identity before every write for the same reason.
 */
export function resolveToken(
  env: Record<string, string | undefined>,
  asKey?: string,
): TokenChoice | null {
  if (asKey) {
    const token = env[asKey];
    if (!token) return null;
    return {
      token,
      key: asKey,
      humanPreferred: (HUMAN_TOKEN_KEYS as readonly string[]).includes(asKey),
    };
  }
  for (const key of HUMAN_TOKEN_KEYS) {
    const token = env[key];
    if (token) return { token, key, humanPreferred: true };
  }
  for (const key of FALLBACK_TOKEN_KEYS) {
    const token = env[key];
    if (token) return { token, key, humanPreferred: false };
  }
  return null;
}

/** Exported for tests. Falls back to the worker config's url, then the default. */
export function resolveUrl(env: Record<string, string | undefined>, configUrl?: string): string {
  return (env.SWITCHYARD_URL || configUrl || "http://100.85.158.109:3300").replace(/\/+$/, "");
}

function workerConfigUrl(): string | undefined {
  const p = path.join(repoRoot(), "switchyard-worker.json");
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { url?: string }).url;
  } catch {
    return undefined;
  }
}

export type Call = { method: string; path: string; body?: unknown };

/** Exported for tests: argv -> the HTTP call, with no I/O. */
export function planCall(argv: string[]): Call {
  const [cmd, ...rest] = argv;
  if (cmd === "whoami") return { method: "GET", path: "/me" };

  if (cmd === "api") {
    const [method, apiPath, json] = rest;
    if (!method || !apiPath) throw new Error("api needs: <METHOD> <path> [json-body]");
    return {
      method: method.toUpperCase(),
      path: apiPath.startsWith("/") ? apiPath : `/${apiPath}`,
      body: json ? (JSON.parse(json) as unknown) : undefined,
    };
  }

  if (cmd === "pr-link") {
    const [sub, ref, prRaw, ...tail] = rest;
    if (sub === "list") {
      if (!ref) throw new Error("pr-link list needs: <REF>");
      return { method: "GET", path: `/issues/${ref}` };
    }
    if (!ref || !prRaw) throw new Error(`pr-link ${sub} needs: <REF> <prNumber>`);
    const prNumber = Number(prRaw);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`"${prRaw}" is not a PR number`);
    }
    const repo = process.env.SWITCHYARD_REPO || "MobilityLabs/switchyard";
    if (sub === "declare") {
      return { method: "POST", path: `/issues/${ref}/pr-links`, body: { repo, prNumber } };
    }
    if (sub === "confirm") {
      return { method: "POST", path: `/issues/${ref}/pr-links/confirm`, body: { repo, prNumber } };
    }
    if (sub === "revoke") {
      const reason = tail.join(" ").trim();
      if (!reason) throw new Error("pr-link revoke needs a reason: <REF> <prNumber> <reason...>");
      return {
        method: "POST",
        path: `/issues/${ref}/pr-links/revoke`,
        body: { repo, prNumber, reason },
      };
    }
    throw new Error(`unknown pr-link subcommand "${sub}" — use declare|confirm|revoke|list`);
  }

  throw new Error(`unknown command "${cmd}" — use whoami|pr-link|api`);
}

/** Human-only acts, so the caller can be warned before the server refuses. */
const HUMAN_ONLY = new Set(["confirm"]);

function usage(): void {
  console.log(`usage: npx tsx scripts/syd.ts <command>

  whoami                                    which actor your token is
  pr-link list    <REF>                     show an issue's declared links
  pr-link declare <REF> <prNumber>          declare a PR carries this issue's work
  pr-link confirm <REF> <prNumber>          human-only: make the link proof-bearing
  pr-link revoke  <REF> <prNumber> <reason> withdraw a link
  api <METHOD> <path> [json]                anything else

  --as <ENV_KEY>  use a specific credential (e.g. --as SWITCHYARD_TOKEN)

Token: read from .env (or the environment), preferring ${HUMAN_TOKEN_KEYS.join(" then ")},
falling back to ${FALLBACK_TOKEN_KEYS.join(", ")}. Never printed, never in argv.
Override the API base with SWITCHYARD_URL, the repo with SWITCHYARD_REPO.
Pass a claim lease with SWITCHYARD_LEASE when declaring/revoking as an agent.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  // --as <ENV_KEY> picks the credential explicitly.
  const asIdx = argv.indexOf("--as");
  const asKey = asIdx >= 0 ? argv[asIdx + 1] : undefined;
  if (asIdx >= 0) argv.splice(asIdx, asKey ? 2 : 1);

  loadDotEnv();
  const choice = resolveToken(process.env, asKey);
  if (!choice) {
    console.error(
      asKey
        ? `error: ${asKey} is not set in .env or the environment.`
        : `error: no token found. Set one of ${ALL_TOKEN_KEYS.join(", ")} in .env or the environment.`,
    );
    process.exit(1);
  }

  const call = planCall(argv);
  const base = resolveUrl(process.env, workerConfigUrl());
  const auth = { authorization: `Bearer ${choice.token}` };

  // Identity preflight before any write. One extra GET, and it turns "which
  // token did that use?" from a thing you discover afterwards in the audit log
  // into a line printed before the write happens.
  if (call.method !== "GET") {
    const meRes = await fetch(`${base}/api/me`, { headers: auth });
    if (!meRes.ok) {
      console.error(`error: ${choice.key} did not authenticate (HTTP ${meRes.status}).`);
      process.exit(1);
    }
    const me = (await meRes.json()) as { name: string; type: string };
    console.error(`acting as ${me.name} (${me.type}) via ${choice.key}`);
    if (HUMAN_ONLY.has(argv[1] ?? "") && me.type !== "human") {
      console.error(
        `error: "${argv[1]}" is human-only, and ${choice.key} is a ${me.type} actor.\n` +
          `Service actors post events, read, and comment — they cannot vouch for a link (SYD-213).\n` +
          `Re-run with --as <KEY> naming a human token.`,
      );
      process.exit(1);
    }
  }
  const headers: Record<string, string> = { ...auth, "content-type": "application/json" };
  // Claim-scoped writes need the lease when acting as an agent; humans are
  // never lease-gated, so this is simply absent for the usual case.
  if (process.env.SWITCHYARD_LEASE) headers["x-switchyard-lease"] = process.env.SWITCHYARD_LEASE;

  const res = await fetch(`${base}/api${call.path}`, {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  // pr-link list would otherwise dump the whole issue including its activity.
  if (argv[0] === "pr-link" && argv[1] === "list" && parsed && typeof parsed === "object") {
    parsed = (parsed as { prLinks?: unknown }).prLinks ?? [];
  }
  console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  if (!res.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: Error) => {
    console.error("error:", err.message);
    process.exit(1);
  });
}
