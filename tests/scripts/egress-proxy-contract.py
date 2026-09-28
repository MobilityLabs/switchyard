"""Run inside the built proxy image: exercise real mitmproxy 12 API objects.

No sockets, provider credentials, or paid model calls are used. The ordinary
Vitest suite also tests the policy without requiring Python dependencies.
"""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from mitmproxy import connection, http

spec = importlib.util.spec_from_file_location(
    "addon", Path(__file__).resolve().parents[2] / "scripts/egress-inject-addon.py"
)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)


def flow(url, headers=None):
    result = http.HTTPFlow(
        connection.Client(peername=("127.0.0.1", 1234), sockname=("127.0.0.1", 8888)),
        connection.Server(address=("api.anthropic.com", 443)),
    )
    result.request = http.Request.make("POST", url, b'{"stream":true}', headers or {})
    return result


class ProxyContract(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {
            "ALLOWED_DOMAINS": "api.anthropic.com,registry.npmjs.org",
            "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-fixture",
            "CODEX_OAUTH_TOKEN": "codex-fixture",
            "OPENAI_API_KEY": "openai-fixture",
            "GEMINI_API_KEY": "gemini-fixture",
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_provider_injection_replaces_case_insensitive_duplicate_auth(self):
        cases = [
            ("api.anthropic.com", "authorization", "Bearer sk-ant-oat-fixture"),
            ("chatgpt.com", "authorization", "Bearer codex-fixture"),
            ("api.openai.com", "authorization", "Bearer openai-fixture"),
            ("generativelanguage.googleapis.com", "x-goog-api-key", "gemini-fixture"),
        ]
        for host, header, value in cases:
            with self.subTest(host=host):
                f = flow(f"https://{host}/v1/test")
                f.request.headers.add("Authorization", "Bearer caller-1")
                f.request.headers.add("authorization", "Bearer caller-2")
                f.request.headers["X-API-Key"] = "caller-3"
                f.request.headers["X-Goog-Api-Key"] = "caller-4"
                addon.request(f)
                self.assertIsNone(f.response)
                self.assertEqual(f.request.headers.get_all(header), [value])
                self.assertEqual(f.request.content, b'{"stream":true}')
                for other in set(addon._AUTH_HEADERS) - {header}:
                    self.assertNotIn(other, f.request.headers)

    def test_rejects_forbidden_cleartext_and_mismatched_destinations(self):
        for url, host in [
            ("https://evil.example/test", "evil.example"),
            ("http://api.anthropic.com/test", "api.anthropic.com"),
            ("https://registry.npmjs.org/test", "api.anthropic.com"),
            ("https://api.openai.com/test", "api.anthropic.com"),
        ]:
            with self.subTest(url=url, host=host):
                f = flow(url, {"Host": host})
                addon.request(f)
                self.assertEqual(f.response.status_code, 403)
                self.assertNotIn("authorization", f.request.headers)

    def test_redirect_remains_client_side_and_followup_is_denied(self):
        initial = flow("https://api.anthropic.com/test")
        addon.request(initial)
        initial.response = http.Response.make(307, headers={"Location": "https://evil.example/"})
        addon.responseheaders(initial)
        self.assertEqual(initial.response.status_code, 307)
        self.assertEqual(initial.response.headers["Location"], "https://evil.example/")
        followup = flow(initial.response.headers["Location"])
        addon.http_connect(followup)
        self.assertEqual(followup.response.status_code, 403)
        addon.request(followup)
        self.assertEqual(followup.response.status_code, 403)
        self.assertNotIn("authorization", followup.request.headers)

    def test_streaming_preserves_events_and_leaves_json_buffered(self):
        for content_type, streams in [("text/event-stream; charset=utf-8", True), ("application/json", False)]:
            with self.subTest(content_type=content_type):
                f = flow("https://chatgpt.com/backend-api/codex/responses")
                f.response = http.Response.make(200, b"data: chunk\n\n", {"Content-Type": content_type})
                addon.responseheaders(f)
                self.assertIs(f.response.stream, streams)
                self.assertEqual(f.response.content, b"data: chunk\n\n")
                self.assertEqual(f.response.headers["Content-Type"], content_type)


if __name__ == "__main__":
    unittest.main()
