# Worker model selection and session metadata

Set optional `model` on a worker configuration to request a provider model or
alias. A project's `model` overrides the worker value. Omitting both preserves
the engine's existing defaults; Switchyard never automatically upgrades or
switches models. Model identifiers are limited to 200 letters, digits and
`._:/-`, beginning with a letter or digit. This validates argument safety, not
provider availability or account entitlement.

```json
{
  "engine": "claude",
  "model": "sonnet",
  "projects": {
    "SYD": { "repo": "/repos/switchyard", "model": "opus" },
    "APP": { "repo": "/repos/app" }
  }
}
```

Merge these fields into a complete worker configuration. SYD requests `opus`,
APP requests `sonnet`. The same precedence applies to work and answer sessions,
Claude CLI/SDK, and supported containerized Codex/Gemini workers. A model name
must belong to that worker's engine. Run `npm run init-worker -- --self-test`
after editing configuration, then restart the worker.

Session logs in `.superpowers/worker-logs/` contain JSON records correlated by a unique `session_key`:

- `worker.runtime`: requested model, installed CLI or SDK version, start time.
  A missing version is `null`, never inferred from a Dockerfile or lockfile.
- `worker.image`: the actual running container's image ID and available registry
  digests. A local build may have an ID without registry digests; unavailable
  Docker inspection is recorded as unknown. Host CLI/SDK sessions have no image.
- `worker.event`: engine, provider event type, emitted model names, usage,
  cost/duration where supplied, tool names and completion/error status.
  `effective_models` is present only when the provider emits model metadata;
  Codex exec streams may omit it. Aliases and routing may resolve to multiple
  models. Requested and observed values are deliberately separate.
- `worker.diagnostic`, `worker.launch_error`, `worker.exit`: static, actionable
  error classifications and process outcomes. CLI startup errors identify a
  missing or non-executable binary; authentication, argument, quota, network,
  permission and MCP problems have separate troubleshooting hints.

CLI logs now retain **structured metadata, not verbatim transcripts**. Arbitrary
text, tool arguments/results, stderr and auth objects can expose credentials, so
unrecognized lines are counted in `worker.output_omitted`. If a failure has no
recognized diagnostic, use its exit status and check the installed CLI version,
worker configuration, provider status, and proxy health before a supervised
reproduction. Do not add raw request/auth dumps to worker logs. Existing SDK
human-readable summaries remain alongside sanitized structured event metadata.

## Compare models on representative work

1. Select a small fixed set of previously completed tasks: a bug with a regression
   test, a scoped feature, a multi-file refactor and a task requiring MCP context.
   Use isolated branches from the same base, identical tools and prompts, and
   keep provider accounts, quotas and human acceptance criteria fixed.
2. Run each candidate more than once. Keep the requested and provider-emitted
   model names, runtime versions and image identities with each result. If an
   effective model is unknown, do not present it as verified.
3. Compare test pass rate, reviewer acceptance, follow-up edits, elapsed time,
   provider-reported usage/cost and infrastructure failures. Separate unsupported
   auth/configuration failures from model-quality failures. No emitted cost means
   unknown cost; do not equate token count with a monetary amount.
4. Choose a model only after human review of those results. Update the explicit
   worker/project value, roll out to one worker, and keep the previous setting
   available for rollback. Benchmarks consume provider quota and are run by an
   operator; the worker does not run evaluations or switch models automatically.

The implementation is covered by offline fake-CLI and mocked-SDK tests; these
verify argument boundaries, metadata parsing, version capture and cancellation,
without purchasing provider sessions or establishing live provider compatibility.
