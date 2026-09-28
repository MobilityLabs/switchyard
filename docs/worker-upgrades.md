# Worker dependency upgrades

Worker images use explicit provider CLI versions. Updating a Dockerfile does
not update existing local images or running containers. Node remains on the
supported 24 LTS major; its patch release and Debian packages are selected at
build time, so these are version-pinned CLIs, not byte-for-byte reproducible
images. Record image IDs/digests with deployment records, and rebuild with
`--pull` to receive base-image security updates.

The defaults reviewed on 2026-09-28 are:

| Component | Pin | Primary source |
| --- | --- | --- |
| Claude Code | 2.1.283 | [Release](https://github.com/anthropics/claude-code/releases/tag/v2.1.283) |
| Codex CLI | 0.157.1 | [Release](https://github.com/openai/codex/releases/tag/rust-v0.157.1) |
| Gemini CLI | 0.61.0 | [Release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.61.0) |
| mitmproxy | 12.2.3 | [Changelog](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/CHANGELOG.md) |
| Node | 24 LTS | [Release lifecycle](https://nodejs.org/en/about/previous-releases) |

The proxy upgrade includes the upstream hyper-h2 fix for HTTP/2-to-HTTP/1
request smuggling released in mitmproxy 12.1.2. This is a dependency maintenance
reason, not a claim that an exploit was demonstrated against Switchyard.

## Review and rebuild

1. Read the stable release notes, especially CLI flags, auth storage, MCP
   headers, output schemas, and proxy API changes. Avoid prerelease tags.
2. Change the corresponding Dockerfile default. For Codex/Gemini, update
   `WELL_KNOWN_CLI_INSTALL` in `scripts/init-worker-lib.ts` too; a regression
   check prevents doctor repair advice from drifting from the image pins.
3. Run the repository checks and the `Worker images` GitHub Actions workflow.
   That workflow builds all four images, checks exact installed CLI versions
   and headless flags, exercises proxy hooks using real mitmproxy objects, and
   starts the proxy entrypoint. Runtime smoke containers use `--network none`
   and receive no provider or deployment credentials. It does not run an agent
   turn or establish a real upstream TLS connection.
4. On the worker host, build every engine in use and the shared proxy:

   ```sh
   docker build --pull -f Dockerfile.worker -t switchyard-worker .
   docker build --pull -f Dockerfile.worker.codex -t switchyard-worker-codex .
   docker build --pull -f Dockerfile.worker.gemini -t switchyard-worker-gemini .
   docker build --pull -f Dockerfile.egress-proxy -t switchyard-egress-proxy .
   ```

   Build arguments `CLAUDE_CODE_VERSION`, `CODEX_CLI_VERSION`, and
   `GEMINI_CLI_VERSION` allow a candidate version to be tried under a separate
   image tag before changing defaults. Preserve the previous image IDs/tags
   for rollback.

## Roll out on the worker host

Pause new dispatches and let active sessions finish before replacing the
shared egress sidecar: it carries every engine's live connections. After
rebuilding, remove the stopped `syd-egress` container and restart the worker
processes so `ensureEgressGuard` recreates it from the new image. Keep the
`syd-egress-ca` volume; deleting it would rotate the CA unexpectedly. A rebuilt
image alone does not force an existing sidecar to reload.

Run `npm run init-worker -- --self-test` with each engine's normal configuration,
then do a controlled task using that engine. Check MCP authentication and the
`X-Switchyard-Lease` header, incremental model output, cancellation, commit
import, and host-side PR publication. Confirm the image ID actually running.
For the proxy, verify allowed dependency installs and provider traffic, a denied
destination, and provider streaming through TLS. Restore the previous tags
and recreate the sidecar if the checks fail; retain the CA volume on rollback.

## Codex auth compatibility boundary

The Codex container holds a dummy, JWT-shaped `auth.json` with the non-secret
account ID. The real ChatGPT OAuth bearer remains in the proxy and replaces
the placeholder on requests to `chatgpt.com`. This handwritten file is an
integration dependency, not a documented stable provider API.

For 0.157.1, the upstream
[auth manager](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/login/src/auth/manager.rs)
still accepts token storage and checks a parseable access-token expiry before
falling back to `last_refresh`. The placeholder's future expiry therefore avoids
proactive refresh by this code path; a real expired/revoked proxy token can
still fail and requires host-side renewal. No real credentials belong in a
fixture or smoke workflow. Recheck this source contract on every Codex upgrade
and retain the authenticated task check above before production rollout.

Codex `exec --dangerously-bypass-approvals-and-sandbox` is used only inside
the disposable worker container. It is not a host-runner recommendation, and
does not imply the separate `--ask-for-approval` CLI option was removed.

## Proxy behavior

Credential injection requires HTTPS and agreement between the request target
and Host header. Provider requests over plain HTTP are denied even if the
provider is in `ALLOWED_DOMAINS`. Redirects are returned to the client; each new
request is checked again. Provider `text/event-stream` responses stream at the
response-header hook so long turns are not buffered until completion. Request
bodies remain buffered so destination validation and injection happen before
upstream transmission. See the upstream [hook lifecycle](https://docs.mitmproxy.org/stable/api/events.html).
