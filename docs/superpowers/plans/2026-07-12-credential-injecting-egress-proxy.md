# Credential-Injecting Egress Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tinyproxy egress sidecar with a unified Node proxy that both domain-allowlists general egress and injects real provider credentials into outbound API calls, so agent containers never hold real provider keys — proven end-to-end on the Claude worker.

**Architecture:** One sidecar (`syd-egress`) does two jobs: a forward proxy (`CONNECT` + absolute-URI) that enforces a default-deny hostname allowlist for general egress (npm, git, MCP), and a reverse proxy on fixed per-provider path prefixes that rewrites the request to the real provider host with the real credential injected. The real keys live only in the sidecar's env; agent containers get a dummy key plus a base-URL override pointing at the sidecar.

**Tech Stack:** TypeScript, Node 24 (`http`/`net` for the forward-proxy path, Hono for the reverse-proxy routes — matching `scripts/slack-notifier.ts`), Docker, Vitest.

## Global Constraints

- **Real provider credentials appear only in the `syd-egress` container's env** — never in an agent container, never in any process argv. (Bare `-e VAR` passthrough, values from the launcher env.)
- **Injector upstreams are a fixed table**, never caller-controlled — the proxy can never be turned into an open relay.
- **Domain allowlist stays default-deny** for all non-provider egress.
- **Response bodies stream** (LLM APIs are SSE) — never buffer a proxied body.
- **`SWITCHYARD_TOKEN` handling is unchanged** — it stays an env var in the agent container (scoped, intended identity).
- Existing worker image base is `node:24-slim`; the proxy runs as a non-root user where practical.
- Spec: `docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md`.

---

## File Structure

- Create `scripts/egress-proxy-routes.ts` — **pure** logic: the injection route table, request-target classification (inject-route vs forward-proxy), header rewrite, and hostname allowlist matching. No I/O. The unit-test surface.
- Create `scripts/egress-proxy.ts` — the runnable sidecar: an `http.Server` wiring the pure logic to real sockets (`CONNECT` tunneling) and a Hono app (inject routes with streaming). Injectable `fetch`/`net.connect`/`env` so it is testable.
- Modify `Dockerfile.egress-proxy` — build+run the Node proxy instead of tinyproxy.
- Retire `scripts/egress-proxy-entry.sh` — replaced by the Node entrypoint (kept only if a fallback is wanted; default is delete).
- Modify `scripts/worker-select.ts` — evolve `ensureEgressGuard` (pass provider-key env into the sidecar; recreate on key-set change), add the injection route/base-URL helpers, and change `buildDockerArgs` (Claude: drop real cred, add base-URL + dummy key, extend `NO_PROXY`).
- Create `tests/scripts/egress-proxy-routes.test.ts`, `tests/scripts/egress-proxy.test.ts`; modify `tests/scripts/worker-select.*.test.ts`.
- Modify `codemaps/workers.md` — one-line note that egress is now injecting+allowlisting.

---

## Task 1: OAuth injection spike (gate)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md` (fold results into §B/§H)

**Interfaces:**
- Produces: `CLAUDE_INJECTION` — a concrete description of the header set the proxy must set on `/anthropic/*` requests: the auth header name + value source (`CLAUDE_CODE_OAUTH_TOKEN` vs `ANTHROPIC_API_KEY`), plus any required constant headers (e.g. `anthropic-version`, beta headers) and whether any inbound header must be stripped. Consumed by Task 2's route table.

- [ ] **Step 1: Capture Claude Code's real request shape against a custom base URL.** Point a throwaway Claude Code run at a logging endpoint: `ANTHROPIC_BASE_URL=http://127.0.0.1:8899/anthropic claude -p "say hi" --permission-mode acceptEdits` with a tiny Node logger on :8899 that prints method, path, and **all** headers (redacting the token value) then returns 200 with a canned minimal response. Record: which auth header carries the OAuth token, any `anthropic-*` version/beta headers, and the exact path Claude appends after the base URL.

- [ ] **Step 2: Consult the "onecli" prior art the user cited** for OAuth-through-proxy — confirm whether the OAuth access token is used verbatim as a bearer, whether a refresh is needed within a ≤1h session, and any audience/beta-header requirements it sets. Cross-check against Step 1's capture.

- [ ] **Step 3: Decide static-vs-refresh.** If the OAuth access token outlives a session (≤1h watchdog), the proxy injects it statically. If not, document the refresh flow (endpoint + refresh token source) as a follow-up task; do **not** silently ship a proxy that stops working mid-session.

- [ ] **Step 4: Write the results into the spec** — replace the `/anthropic` row's "OAuth bearer or API key — §H" with the confirmed header set, and mark §H resolved. Commit.

```bash
git add docs/superpowers/specs/2026-07-12-credential-injecting-egress-proxy-design.md
git commit -m "docs: resolve OAuth injection spike for egress proxy (Task 1)"
```

> **Gate:** Tasks 3+ can be written generically, but the `/anthropic` route's config values come from this task. Do not fabricate them.

---

## Task 2: Pure routing + injection core

**Files:**
- Create: `scripts/egress-proxy-routes.ts`
- Test: `tests/scripts/egress-proxy-routes.test.ts`

**Interfaces:**
- Produces:
  - `type InjectionRoute = { prefix: string; upstreamHost: string; setHeaders: (env: NodeJS.ProcessEnv) => Record<string,string>; stripHeaders: string[] }`
  - `INJECTION_ROUTES: InjectionRoute[]` — the fixed `/anthropic`, `/openai`, `/gemini` table (values for `/anthropic` from Task 1).
  - `matchInjectionRoute(path: string): { route: InjectionRoute; upstreamPath: string } | null`
  - `rewriteHeaders(incoming: Record<string,string>, route: InjectionRoute, env: NodeJS.ProcessEnv): Record<string,string>` — drops `route.stripHeaders` (case-insensitive) and any inbound `authorization`/`x-api-key`/`x-goog-api-key`, then applies `route.setHeaders(env)`; also rewrites `host` to `upstreamHost`.
  - `hostAllowed(host: string, allowlist: ReadonlySet<string>): boolean` — exact, case-insensitive hostname match (mirrors the anchored-ERE semantics of the old tinyproxy filter: no substring matches).

- [ ] **Step 1: Write failing tests for route matching and header rewrite.**

```ts
import { describe, it, expect } from "vitest";
import { matchInjectionRoute, rewriteHeaders, hostAllowed, INJECTION_ROUTES } from "../../scripts/egress-proxy-routes.js";

describe("matchInjectionRoute", () => {
  it("maps a known prefix to its upstream and preserves the remaining path+query", () => {
    const m = matchInjectionRoute("/openai/v1/responses?stream=true");
    expect(m?.route.upstreamHost).toBe("api.openai.com");
    expect(m?.upstreamPath).toBe("/v1/responses?stream=true");
  });
  it("returns null for an unknown prefix", () => {
    expect(matchInjectionRoute("/evil/v1/models")).toBeNull();
  });
});

describe("rewriteHeaders", () => {
  it("replaces caller auth with the injected credential and rewrites host", () => {
    const route = INJECTION_ROUTES.find(r => r.prefix === "/openai")!;
    const out = rewriteHeaders(
      { authorization: "Bearer sk-dummy", host: "syd-egress:8888", "content-type": "application/json" },
      route,
      { OPENAI_API_KEY: "sk-real-123" } as NodeJS.ProcessEnv,
    );
    expect(out.authorization).toBe("Bearer sk-real-123");
    expect(out.host).toBe("api.openai.com");
    expect(out["content-type"]).toBe("application/json");
  });
});

describe("hostAllowed", () => {
  const allow = new Set(["registry.npmjs.org"]);
  it("allows an exact host", () => expect(hostAllowed("registry.npmjs.org", allow)).toBe(true));
  it("rejects a look-alike suffix", () => expect(hostAllowed("registry.npmjs.org.attacker.net", allow)).toBe(false));
});
```

- [ ] **Step 2: Run tests — verify they fail** (module not found).

Run: `npx vitest run tests/scripts/egress-proxy-routes.test.ts`
Expected: FAIL — cannot resolve `../../scripts/egress-proxy-routes.js`.

- [ ] **Step 3: Implement `scripts/egress-proxy-routes.ts`.** Fixed route table; `/anthropic` `setHeaders`/`stripHeaders` use the Task 1 result (shown here with the OAuth-bearer shape as the expected outcome — adjust to the spike's confirmed values). `/openai` and `/gemini` as in the tests.

```ts
export type InjectionRoute = {
  prefix: string;
  upstreamHost: string;
  setHeaders: (env: NodeJS.ProcessEnv) => Record<string, string>;
  stripHeaders: string[];
};

const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

export const INJECTION_ROUTES: InjectionRoute[] = [
  {
    prefix: "/anthropic",
    upstreamHost: "api.anthropic.com",
    // Values confirmed in Task 1. Placeholder shown is the OAuth-bearer shape.
    setHeaders: (env) => ({ authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ""}` }),
    stripHeaders: [],
  },
  {
    prefix: "/openai",
    upstreamHost: "api.openai.com",
    setHeaders: (env) => ({ authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}` }),
    stripHeaders: [],
  },
  {
    prefix: "/gemini",
    upstreamHost: "generativelanguage.googleapis.com",
    setHeaders: (env) => ({ "x-goog-api-key": env.GEMINI_API_KEY ?? "" }),
    stripHeaders: [],
  },
];

export function matchInjectionRoute(path: string): { route: InjectionRoute; upstreamPath: string } | null {
  for (const route of INJECTION_ROUTES) {
    if (path === route.prefix || path.startsWith(route.prefix + "/")) {
      return { route, upstreamPath: path.slice(route.prefix.length) || "/" };
    }
  }
  return null;
}

export function rewriteHeaders(
  incoming: Record<string, string>,
  route: InjectionRoute,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const drop = new Set([...AUTH_HEADERS, ...route.stripHeaders].map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!drop.has(k.toLowerCase()) && k.toLowerCase() !== "host") out[k] = v;
  }
  out.host = route.upstreamHost;
  return { ...out, ...route.setHeaders(env) };
}

export function hostAllowed(host: string, allowlist: ReadonlySet<string>): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  for (const a of allowlist) if (a.toLowerCase() === h) return true;
  return false;
}
```

- [ ] **Step 4: Run tests — verify they pass.**

Run: `npx vitest run tests/scripts/egress-proxy-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add scripts/egress-proxy-routes.ts tests/scripts/egress-proxy-routes.test.ts
git commit -m "feat: pure routing + credential-injection core for egress proxy (Task 2)"
```

---

## Task 3: Reverse-proxy inject routes (streaming)

**Files:**
- Create: `scripts/egress-proxy.ts` (Hono app portion)
- Test: `tests/scripts/egress-proxy.test.ts`

**Interfaces:**
- Consumes: `matchInjectionRoute`, `rewriteHeaders` (Task 2).
- Produces: `createInjectApp(deps: { fetch: typeof fetch; env: NodeJS.ProcessEnv }): Hono` — a Hono app whose catch-all handler proxies a matched inject-route to `https://<upstreamHost><upstreamPath>` with rewritten headers and a **streamed** response body; returns 404 for unmatched paths.

- [ ] **Step 1: Write a failing test** that a request to an inject route reaches the injected upstream with the real key and streams the body back. Use an injected `fetch` fake.

```ts
import { describe, it, expect } from "vitest";
import { createInjectApp } from "../../scripts/egress-proxy.js";

describe("inject app", () => {
  it("proxies /openai/* to api.openai.com with the real key and streams the body", async () => {
    let seenUrl = "", seenAuth = "";
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url; seenAuth = (init.headers as Record<string,string>).authorization;
      return new Response("data: hi\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const app = createInjectApp({ fetch: fakeFetch, env: { OPENAI_API_KEY: "sk-real" } as NodeJS.ProcessEnv });
    const res = await app.request("/openai/v1/responses", { method: "POST", body: "{}" });
    expect(seenUrl).toBe("https://api.openai.com/v1/responses");
    expect(seenAuth).toBe("Bearer sk-real");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hi\n\n");
  });

  it("404s an unmatched path", async () => {
    const app = createInjectApp({ fetch: fetch, env: {} as NodeJS.ProcessEnv });
    const res = await app.request("/evil/x");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test — verify it fails** (module/export missing).

Run: `npx vitest run tests/scripts/egress-proxy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createInjectApp`.** Catch-all handler: match route → build upstream URL → `rewriteHeaders` → `deps.fetch` with the original method/body → return a `Response` that passes the upstream body stream through unchanged (no buffering). Verify Hono's streaming/`c.body(stream)` API against the installed version during implementation.

```ts
import { Hono } from "hono";
import { matchInjectionRoute, rewriteHeaders } from "./egress-proxy-routes.js";

export function createInjectApp(deps: { fetch: typeof fetch; env: NodeJS.ProcessEnv }): Hono {
  const app = new Hono();
  app.all("*", async (c) => {
    const m = matchInjectionRoute(c.req.path);
    if (!m) return c.notFound();
    const url = `https://${m.route.upstreamHost}${m.upstreamPath}`;
    const headers = rewriteHeaders(Object.fromEntries(c.req.raw.headers), m.route, deps.env);
    const upstream = await deps.fetch(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      // @ts-expect-error Node fetch duplex for streamed request bodies
      duplex: "half",
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  });
  return app;
}
```

- [ ] **Step 4: Run test — verify it passes.**

Run: `npx vitest run tests/scripts/egress-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add scripts/egress-proxy.ts tests/scripts/egress-proxy.test.ts
git commit -m "feat: streaming credential-injection reverse proxy (Task 3)"
```

---

## Task 4: Forward-proxy `CONNECT` + allowlist

**Files:**
- Modify: `scripts/egress-proxy.ts` (add the `http.Server` + `connect` handler and `main()`)
- Test: `tests/scripts/egress-proxy.test.ts` (add allowlist-decision tests)

**Interfaces:**
- Consumes: `hostAllowed` (Task 2), `createInjectApp` (Task 3).
- Produces: `connectAllowed(hostHeaderOrAuthority: string, allowlist: ReadonlySet<string>): boolean` (thin wrapper over `hostAllowed` that parses `host:port`); `startProxy(deps)` binding the Hono app to origin requests and a `server.on("connect", …)` that tunnels to allowlisted hosts via `net.connect`, and `403`/`Connection refused`s the rest. `ALLOWED_DOMAINS` (CSV) + provider-key vars read from `deps.env`.

- [ ] **Step 1: Write failing tests** for `connectAllowed`.

```ts
import { describe, it, expect } from "vitest";
import { connectAllowed } from "../../scripts/egress-proxy.js";

describe("connectAllowed", () => {
  const allow = new Set(["registry.npmjs.org", "100.85.158.109"]);
  it("allows an allowlisted CONNECT authority", () => expect(connectAllowed("registry.npmjs.org:443", allow)).toBe(true));
  it("rejects a non-allowlisted host", () => expect(connectAllowed("evil.example.com:443", allow)).toBe(false));
});
```

- [ ] **Step 2: Run — verify fail.** Run: `npx vitest run tests/scripts/egress-proxy.test.ts` — Expected: FAIL (no `connectAllowed`).

- [ ] **Step 3: Implement the forward-proxy path.** `connectAllowed` parses the authority and delegates to `hostAllowed`. `startProxy` creates an `http.Server` whose normal requests are served by the Hono app (via `@hono/node-server`), and whose `"connect"` event tunnels allowlisted authorities with `net.connect`, writing `HTTP/1.1 200 Connection Established` then piping both directions; disallowed authorities get `HTTP/1.1 403 Forbidden` and the socket destroyed. `main()` reads `ALLOWED_DOMAINS` + keys from `process.env` and calls `startProxy`. (Verify `@hono/node-server` request-listener adapter and the `connect` event wiring during implementation.)

```ts
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { hostAllowed } from "./egress-proxy-routes.js";

export function connectAllowed(authority: string, allowlist: ReadonlySet<string>): boolean {
  return hostAllowed(authority, allowlist); // hostAllowed already strips :port
}

export function startProxy(deps: { env: NodeJS.ProcessEnv; port: number; requestListener: import("http").RequestListener }) {
  const allow = new Set((deps.env.ALLOWED_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const server = createServer(deps.requestListener);
  server.on("connect", (req, clientSocket, head) => {
    const authority = req.url ?? "";
    if (!connectAllowed(authority, allow)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const [host, port] = authority.split(":");
    const upstream = netConnect(Number(port) || 443, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  server.listen(deps.port);
  return server;
}
```

- [ ] **Step 4: Run — verify pass.** Run: `npx vitest run tests/scripts/egress-proxy.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add scripts/egress-proxy.ts tests/scripts/egress-proxy.test.ts
git commit -m "feat: forward-proxy CONNECT + allowlist in egress proxy (Task 4)"
```

---

## Task 5: Dockerfile — run the Node proxy

**Files:**
- Modify: `Dockerfile.egress-proxy`
- Retire: `scripts/egress-proxy-entry.sh`

**Interfaces:**
- Produces: an image (still tagged `switchyard-egress-proxy`) whose entrypoint runs `scripts/egress-proxy.ts` via `tsx`, listening on 8888, reading `ALLOWED_DOMAINS` + provider-key vars from env.

- [ ] **Step 1: Rewrite `Dockerfile.egress-proxy`** to `FROM node:24-slim`, copy `scripts/egress-proxy.ts`, `scripts/egress-proxy-routes.ts`, and a minimal `package.json` with `hono` + `@hono/node-server` + `tsx`, `npm ci`, drop to non-root, `ENTRYPOINT ["npx","tsx","/app/egress-proxy.ts"]`. (Confirm the dependency install strategy — a tiny dedicated `package.json` under a build context dir keeps the image lean.)

- [ ] **Step 2: Build the image.**

Run: `docker build -f Dockerfile.egress-proxy -t switchyard-egress-proxy .`
Expected: builds clean.

- [ ] **Step 3: Smoke-test the container** with a dummy allowlist and no real keys: `docker run --rm -e ALLOWED_DOMAINS=registry.npmjs.org -p 8888:8888 switchyard-egress-proxy &` then `curl -x http://127.0.0.1:8888 https://registry.npmjs.org/ -I` (allowed) and a disallowed host (expect 403). Stop the container.

- [ ] **Step 4: Delete `scripts/egress-proxy-entry.sh`** (tinyproxy entry no longer referenced).

- [ ] **Step 5: Commit.**

```bash
git add Dockerfile.egress-proxy scripts/egress-proxy-entry.sh
git commit -m "feat: egress-proxy image runs the Node injecting proxy (Task 5)"
```

---

## Task 6: `ensureEgressGuard` passes provider keys to the sidecar

**Files:**
- Modify: `scripts/worker-select.ts` (`ensureEgressGuard`, and a helper for the key-var set)
- Test: `tests/scripts/worker-select.egress.test.ts` (or the existing egress test file)

**Interfaces:**
- Consumes: existing `EGRESS_PROXY_NAME`, `egressAllowlist`.
- Produces: `injectKeyEnvArgs(env): string[]` — bare `-e VAR` for each present provider key var (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`); `ensureEgressGuard` now passes those into the `docker run` of the sidecar and recreates the sidecar when the **key-var set** changes (not just the allowlist).

- [ ] **Step 1: Write failing tests** (extend the injected-`exec` pattern already used for `ensureEgressGuard`): assert the sidecar `docker run` args include `-e CLAUDE_CODE_OAUTH_TOKEN` when present in env and omit `-e OPENAI_API_KEY` when absent; assert a change in which key vars are present triggers an `rm -f` + recreate. (Mirror the existing `ensureEgressGuard` test setup in `tests/scripts/`.)

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement.** Add `injectKeyEnvArgs`; include its output in the sidecar `run` argv; extend the freshness check so `inspectProxy().sameKeys` compares the **names** of present key vars (never values) baked as a sentinel env `INJECT_KEYS=<sorted,csv,of,names>` on the sidecar, recreating when it differs. Keep the race-tolerant structure intact.

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit.**

```bash
git add scripts/worker-select.ts tests/scripts/worker-select.egress.test.ts
git commit -m "feat: egress sidecar holds provider keys; recreate on key-set change (Task 6)"
```

---

## Task 7: `buildDockerArgs` — base-URL + dummy key, drop real cred (Claude)

**Files:**
- Modify: `scripts/worker-select.ts` (`buildDockerArgs`, `egressDockerArgs`)
- Test: `tests/scripts/worker-select.test.ts`

**Interfaces:**
- Consumes: `EGRESS_PROXY_NAME`, `EGRESS_PROXY_PORT`.
- Produces: for a containerized Claude dispatch, the agent-container argv includes `-e ANTHROPIC_BASE_URL=http://syd-egress:8888/anthropic` and `-e ANTHROPIC_API_KEY=<dummy sentinel>` (or the dummy var Claude accepts), **excludes** any real Anthropic credential, and adds the proxy hostname to `NO_PROXY`.

- [ ] **Step 1: Write failing tests.**

```ts
it("Claude agent container gets the base-URL + dummy key and no real credential", () => {
  const args = buildDockerArgs(issue, project, config, { CLAUDE_CODE_OAUTH_TOKEN: "real-oauth" } as NodeJS.ProcessEnv);
  const joined = args.join(" ");
  expect(joined).toContain("ANTHROPIC_BASE_URL=http://syd-egress:8888/anthropic");
  expect(joined).not.toContain("real-oauth");           // value never in argv
  // the real cred is NOT forwarded into the agent container:
  const eIdx = args.reduce((n, a, i) => (a === "-e" && args[i+1]?.startsWith("CLAUDE_CODE_OAUTH_TOKEN") ? i : n), -1);
  expect(eIdx).toBe(-1);
});
it("adds the proxy host to NO_PROXY so provider base-URL traffic goes direct", () => {
  const args = buildDockerArgs(issue, project, config, { CLAUDE_CODE_OAUTH_TOKEN: "x" } as NodeJS.ProcessEnv);
  expect(args.join(" ")).toMatch(/NO_PROXY=[^ ]*syd-egress/);
});
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement.** In `egressDockerArgs`, append `EGRESS_PROXY_NAME` to the `NO_PROXY`/`no_proxy` values. In `buildDockerArgs`, when engine is Claude (the default/only engine here): remove the real-cred `-e CLAUDE_CODE_OAUTH_TOKEN`/`-e ANTHROPIC_API_KEY` passthrough; add `-e ANTHROPIC_BASE_URL=http://${EGRESS_PROXY_NAME}:${EGRESS_PROXY_PORT}/anthropic` and `-e ANTHROPIC_API_KEY=<dummy>` (dummy value confirmed acceptable in Task 1). Update the "requires auth env" guard so it validates the key is present in the **worker/sidecar** env (for the injector) rather than requiring it inside the agent container.

- [ ] **Step 4: Run — verify pass.** Also run the full worker-select suite: `npx vitest run tests/scripts/`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/worker-select.ts tests/scripts/worker-select.test.ts
git commit -m "feat: Claude agent container uses injecting proxy, no real key in-container (Task 7)"
```

---

## Task 8: End-to-end acceptance + codemap

**Files:**
- Modify: `codemaps/workers.md`
- (No code — verification task.)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Full gate.** Run `npm run typecheck` and `npm test`; both green.

- [ ] **Step 2: Bring up the guard.** Start the worker (or call the guard directly) so `ensureEgressGuard` stands up `syd-egress` with the real Anthropic cred in the sidecar env and `ALLOWED_DOMAINS` set. Confirm `docker ps` shows the sidecar and `docker inspect syd-egress` shows the key var present (value not logged).

- [ ] **Step 3: Dispatch a real Claude SYD issue** labeled for containerized dispatch. Confirm it produces its `agent/<ref>` PR (session runs, commits, pushes) — i.e. the injected OAuth path actually reaches Anthropic.

- [ ] **Step 4: Prove the key is absent from the agent container.** While the session runs (or via a deliberately long test issue), `docker exec <syd-ref> env | grep -Ei 'anthropic|claude'` shows **only** `ANTHROPIC_BASE_URL` + the dummy key — no real credential. Capture this output as the acceptance evidence (attach to the tracking issue per the visual-verification norm).

- [ ] **Step 5: Update `codemaps/workers.md`** — the egress line now reads "injecting + allowlisting proxy: holds provider keys, agent containers carry only a dummy key + base-URL." Commit.

```bash
git add codemaps/workers.md
git commit -m "docs: codemap note for injecting egress proxy (Task 8)"
```

---

## Self-Review

**Spec coverage:**
- §A unified proxy → Tasks 3+4 (inject + forward/allowlist), Task 5 (image). ✅
- §B routing table → Task 2. ✅
- §C credential model (keys only in sidecar; dummy in agent) → Tasks 6 + 7; proven in Task 8 Step 4. ✅
- §D base-URL override (Claude) → Task 7. ✅
- §E NO_PROXY nuance → Task 7 Step 3 + test. ✅
- §F lifecycle → Task 6. ✅
- §G Claude retrofit + acceptance → Task 7 + Task 8. ✅
- §H OAuth spike → Task 1 (gate). ✅
- Testing section → per-task unit tests + Task 8 integration. ✅
- Codex/Gemini rows provisioned but not exercised (Project 2) → Task 2 table includes them; no engine wiring (correct — out of scope). ✅

**Placeholder scan:** The only deferred values are the `/anthropic` route header specifics, which are explicitly the deliverable of the gating Task 1 — not a hidden placeholder. `<dummy>` sentinel value is resolved in Task 1/Task 7. No "TBD/handle errors/similar to" placeholders. ✅

**Type consistency:** `matchInjectionRoute` / `rewriteHeaders` / `hostAllowed` / `connectAllowed` / `createInjectApp` / `startProxy` / `injectKeyEnvArgs` names are used consistently across Tasks 2–7. `InjectionRoute` shape is defined once (Task 2) and consumed unchanged. ✅

**Implementation-verification notes (honest gaps):** exact Hono streaming API (`Task 3`), `@hono/node-server` + `connect`-event wiring (`Task 4`), and the Claude-OAuth header set (`Task 1`) are confirmed against the installed versions/live capture during their tasks rather than asserted here.
