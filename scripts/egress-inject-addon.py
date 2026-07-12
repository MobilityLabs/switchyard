#!/usr/bin/env python3
"""mitmproxy addon: inject real provider credentials, default-deny the rest.

Real provider keys come from the proxy container's env (never from an agent
container). For a fixed table of provider hosts the proxy MITMs the TLS,
strips the caller's auth header, and injects the real credential; allowlisted
non-provider hosts (npm, git, the tracker) tunnel un-intercepted; everything
else is refused. This is the credential-injection + allowlist half of the
`syd-egress` sidecar (SYD-186); it replaces tinyproxy's default-deny filter.

The pure decision functions (`injection_for`, `host_allowed`,
`connect_decision`) carry the policy and are exercised by `--selftest`
(no mitmproxy dependency). The mitmproxy hooks at the bottom are thin shells
that apply those decisions; they are import-guarded so `--selftest` runs under
a bare Python (mitmproxy absent).

Usage under the sidecar:
    ALLOWED_DOMAINS=registry.npmjs.org,github.com \
    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-... \
    mitmdump --listen-host 0.0.0.0 --listen-port 8888 -s scripts/egress-inject-addon.py

Self-test:
    python3 scripts/egress-inject-addon.py --selftest
"""
import os
import sys
from collections.abc import Mapping

# Fixed injection table — never caller-controlled, so the proxy can't be turned
# into an open credential relay. Keep in sync with the design spec §B and
# EGRESS_BASELINE in scripts/worker-select.ts.
PROVIDER_HOSTS = {
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
}

# Header names that may carry a caller-supplied credential; stripped before we
# inject the real one so a session's placeholder never leaks upstream.
_AUTH_HEADERS = ("authorization", "x-api-key", "x-goog-api-key")


def injection_for(host: str, env: Mapping) -> list | None:
    """Header ops (name, value|None) to apply for a provider host, else None.

    `None` as a value means "remove this header". Anthropic picks the scheme by
    token prefix (confirmed from onecli secret_inject.rs):
      sk-ant-oat* (OAuth)  -> Authorization: Bearer <token>
      sk-ant-api* (API key) -> x-api-key: <token>, remove authorization
    """
    h = host.lower()
    if h == "api.anthropic.com":
        tok = env.get("CLAUDE_CODE_OAUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
        if tok.startswith("sk-ant-oat"):
            return [("authorization", f"Bearer {tok}")]
        return [("x-api-key", tok), ("authorization", None)]
    if h == "api.openai.com":
        return [("authorization", f"Bearer {env.get('OPENAI_API_KEY', '')}")]
    if h == "generativelanguage.googleapis.com":
        return [("x-goog-api-key", env.get("GEMINI_API_KEY", ""))]
    return None


def host_allowed(host: str, allowlist: set) -> bool:
    """Exact, case-insensitive membership — mirrors the old anchored-ERE
    semantics (no substring matches: `api.anthropic.com.attacker.net` is out)."""
    return host.lower() in {a.lower() for a in allowlist}


def connect_decision(host: str, allowlist: set) -> str:
    """Per-CONNECT policy: 'mitm' (provider host, inject), 'tunnel' (allowlisted
    non-provider, pass TLS through un-intercepted), or 'deny' (default)."""
    h = host.lower()
    if h in PROVIDER_HOSTS:
        return "mitm"
    if host_allowed(h, allowlist):
        return "tunnel"
    return "deny"


def parse_allowlist(env: Mapping) -> set:
    """ALLOWED_DOMAINS is comma-separated hostnames (same format tinyproxy
    consumed in scripts/egress-proxy-entry.sh). Blanks are dropped."""
    raw = env.get("ALLOWED_DOMAINS", "")
    return {d.strip().lower() for d in raw.split(",") if d.strip()}


def _apply(headers, ops) -> None:
    # Strip any caller-supplied auth first, then apply the injected ops so a
    # session's placeholder credential never survives into the upstream request.
    for k in _AUTH_HEADERS:
        if k in headers:
            del headers[k]
    for name, value in ops:
        if value is None:
            if name in headers:
                del headers[name]
        else:
            headers[name] = value


# --- mitmproxy hooks (only reachable when run under mitmdump) ---------------
# Imported lazily / guarded so `--selftest` runs without mitmproxy installed.

def tls_clienthello(data) -> None:  # noqa: ANN001
    """Decide MITM vs plain tunnel per connection by SNI. Provider hosts are
    intercepted (default mitmproxy behavior); allowlisted non-provider hosts are
    tunnelled un-decrypted; denied hosts never reach here (killed at CONNECT)."""
    allowlist = parse_allowlist(os.environ)
    sni = data.client_hello.sni or ""
    if connect_decision(sni, allowlist) == "tunnel":
        data.ignore_connection = True


def http_connect(flow) -> None:  # noqa: ANN001
    """Default-deny gate at CONNECT time: refuse any host that is neither a
    provider host nor on the allowlist, before any TLS is established."""
    from mitmproxy import http

    allowlist = parse_allowlist(os.environ)
    if connect_decision(flow.request.host, allowlist) == "deny":
        flow.response = http.Response.make(
            403, b"egress denied: host not in allowlist\n",
            {"Content-Type": "text/plain"},
        )


def request(flow) -> None:  # noqa: ANN001
    """Inject the real credential for MITM'd provider hosts."""
    ops = injection_for(flow.request.pretty_host, os.environ)
    if ops is not None:
        _apply(flow.request.headers, ops)


def _selftest() -> None:
    # Anthropic OAuth vs API-key branch.
    a = injection_for("api.anthropic.com", {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-XYZ"})
    assert a == [("authorization", "Bearer sk-ant-oat-XYZ")], a
    b = injection_for("api.anthropic.com", {"ANTHROPIC_API_KEY": "sk-ant-api-XYZ"})
    assert b == [("x-api-key", "sk-ant-api-XYZ"), ("authorization", None)], b
    # OAuth token wins over an also-present API key, and casing is ignored.
    c = injection_for("API.ANTHROPIC.COM", {
        "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-1", "ANTHROPIC_API_KEY": "sk-ant-api-2",
    })
    assert c == [("authorization", "Bearer sk-ant-oat-1")], c
    # OpenAI / Gemini (Project 2, but the rules are provisioned now).
    assert injection_for("api.openai.com", {"OPENAI_API_KEY": "sk-oai"}) == [
        ("authorization", "Bearer sk-oai")], "openai"
    assert injection_for("generativelanguage.googleapis.com", {"GEMINI_API_KEY": "g"}) == [
        ("x-goog-api-key", "g")], "gemini"
    # Non-provider host has no injection rule.
    assert injection_for("evil.example.com", {}) is None
    assert injection_for("registry.npmjs.org", {}) is None

    # Exact allowlist membership — no substring escape.
    assert host_allowed("registry.npmjs.org", {"registry.npmjs.org"})
    assert host_allowed("REGISTRY.npmjs.org", {"registry.npmjs.org"})  # case-insensitive
    assert not host_allowed("registry.npmjs.org.attacker.net", {"registry.npmjs.org"})
    assert not host_allowed("registry.npmjs.org", set())

    # CONNECT policy: provider -> mitm, allowlisted -> tunnel, else -> deny.
    allow = {"registry.npmjs.org"}
    assert connect_decision("api.anthropic.com", allow) == "mitm"
    assert connect_decision("api.anthropic.com", set()) == "mitm"  # provider always intercepted
    assert connect_decision("registry.npmjs.org", allow) == "tunnel"
    assert connect_decision("evil.example.com", allow) == "deny"
    assert connect_decision("api.anthropic.com.attacker.net", allow) == "deny"

    # Allowlist parsing from the env string.
    assert parse_allowlist({"ALLOWED_DOMAINS": "a.com, b.com ,, c.com"}) == {"a.com", "b.com", "c.com"}
    assert parse_allowlist({}) == set()

    # _apply strips caller auth before injecting, and honors removals.
    hdrs = {"authorization": "Bearer caller-placeholder", "anthropic-version": "2023-06-01"}
    _apply(hdrs, [("authorization", "Bearer real-oat")])
    assert hdrs == {"authorization": "Bearer real-oat", "anthropic-version": "2023-06-01"}, hdrs
    hdrs2 = {"authorization": "Bearer caller", "x-api-key": "caller-key"}
    _apply(hdrs2, [("x-api-key", "real-api"), ("authorization", None)])
    assert hdrs2 == {"x-api-key": "real-api"}, hdrs2

    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
