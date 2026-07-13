import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// SYD-190: the egress addon's CONNECT-time allowlist could be bypassed with
// plain http:// requests — worker containers get HTTP_PROXY/http_proxy, so
// absolute-form HTTP requests reach the addon's request() hook without ever
// passing http_connect(). These tests drive the *actual mitmproxy hooks*
// (request()) under a bare python3 with a stubbed `mitmproxy.http` module —
// same no-mitmproxy-needed layer as the addon's own --selftest.

const ADDON = path.resolve(__dirname, "../../scripts/egress-inject-addon.py");

// Prelude: stub mitmproxy.http (the only lazy import the hooks make), load the
// addon from its file path, and provide minimal Flow/Request doubles matching
// the attributes the hooks touch (scheme, host, pretty_host, headers).
const PRELUDE = `
import importlib.util, os, sys, types

http_mod = types.ModuleType("mitmproxy.http")
class Response:
    @staticmethod
    def make(status_code, content=b"", headers=None):
        r = types.SimpleNamespace()
        r.status_code = status_code
        r.content = content
        return r
http_mod.Response = Response
mitm = types.ModuleType("mitmproxy")
mitm.http = http_mod
sys.modules["mitmproxy"] = mitm
sys.modules["mitmproxy.http"] = http_mod

spec = importlib.util.spec_from_file_location("addon", os.environ["ADDON"])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

class Req:
    def __init__(self, scheme, host, pretty_host=None, headers=None):
        self.scheme = scheme
        self.host = host
        self.pretty_host = pretty_host or host
        self.headers = {} if headers is None else headers

class Flow:
    def __init__(self, req):
        self.request = req
        self.response = None
`;

function runHook(body: string, env: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", PRELUDE + body], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1", // no __pycache__ litter in scripts/
      ADDON,
      ALLOWED_DOMAINS: "registry.npmjs.org,nas.local",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-REALSECRET",
      ...env,
    },
  });
}

function expectOk(r: ReturnType<typeof spawnSync>) {
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
}

describe("egress-inject-addon.py --selftest (pure policy functions)", () => {
  it("passes under bare python3 (no mitmproxy installed)", () => {
    const r = spawnSync("python3", [ADDON, "--selftest"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("selftest ok");
  });
});

describe("request() hook — plain-HTTP allowlist gate (SYD-190)", () => {
  it("denies a plain http:// request to a non-allowlisted host with 403", () => {
    const r = runHook(`
f = Flow(Req("http", "evil.example.com"))
addon.request(f)
assert f.response is not None, "denied http flow must get a response, got pass-through"
assert f.response.status_code == 403, f.response.status_code
`);
    expectOk(r);
  });

  it("lets a plain http:// request to an allowlisted host through, without injection", () => {
    const r = runHook(`
f = Flow(Req("http", "registry.npmjs.org"))
addon.request(f)
assert f.response is None, "allowlisted http flow must pass through"
assert "authorization" not in f.request.headers, f.request.headers
`);
    expectOk(r);
  });

  it("denies plain http:// to a provider host — credentials are never injected over cleartext", () => {
    const r = runHook(`
f = Flow(Req("http", "api.anthropic.com"))
addon.request(f)
assert f.response is not None and f.response.status_code == 403, f.response
assert "sk-ant-oat-REALSECRET" not in repr(f.request.headers), f.request.headers
`);
    expectOk(r);
  });

  it("denies the Host-header smuggle: http:// to an allowlisted target with a provider Host header", () => {
    const r = runHook(`
f = Flow(Req("http", "registry.npmjs.org", pretty_host="api.anthropic.com",
             headers={"authorization": "Bearer placeholder"}))
addon.request(f)
assert f.response is not None and f.response.status_code == 403, f.response
assert "sk-ant-oat-REALSECRET" not in repr(f.request.headers), f.request.headers
`);
    expectOk(r);
  });

  it("still injects the real credential on the MITM'd https provider path", () => {
    const r = runHook(`
f = Flow(Req("https", "api.anthropic.com",
             headers={"authorization": "Bearer placeholder"}))
addon.request(f)
assert f.response is None, f.response
assert f.request.headers.get("authorization") == "Bearer sk-ant-oat-REALSECRET", f.request.headers
`);
    expectOk(r);
  });

  it("denies an https flow to a non-allowlisted host (defense in depth behind the CONNECT gate)", () => {
    const r = runHook(`
f = Flow(Req("https", "evil.example.com"))
addon.request(f)
assert f.response is not None and f.response.status_code == 403, f.response
`);
    expectOk(r);
  });
});
