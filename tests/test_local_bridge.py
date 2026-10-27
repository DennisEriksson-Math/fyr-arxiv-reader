"""Local HTTP integration and mocked inference; never run a paid model."""
from __future__ import annotations

import http.client
import io
import json
import os
import subprocess
import sys
import time
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from scripts import local_bridge as bridge

REQUEST = {"instructions": "Return JSON only.", "input": "Private profile and abstracts", "maxTokens": 12000}


class FakeProvider:
    name = "test"
    model = "test-model"
    max_tokens_enforced = True

    def __init__(self):
        self.calls = []

    def respond(self, request):
        self.calls.append(request)
        return {"text": "[]", "input": 50, "output": 2}


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.dist = Path(cls.folder.name) / "dist"
        cls.dist.mkdir()
        (cls.dist / "index.html").write_text("<html>Fyr</html>")
        (cls.dist / "file.js").write_text("console.log('Fyr');")
        (Path(cls.folder.name) / "private.txt").write_text("private")
        (cls.dist / "escape.txt").symlink_to(Path(cls.folder.name) / "private.txt")
        cls.provider = FakeProvider()
        cls.server = bridge.BridgeServer(cls.provider, cls.dist, port=0, token="test-session-token")
        cls.port = cls.server.server_address[1]
        cls.origin = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.folder.cleanup()

    def setUp(self):
        self.provider.calls.clear()
        self.server.requests.clear()

    def request(self, method="GET", path="/api/health", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        all_headers = {"Origin": self.origin}
        all_headers.update(headers or {})
        if body is not None:
            body = json.dumps(body).encode()
            all_headers.setdefault("Content-Type", "application/json")
        try:
            connection.request(method, path, body=body, headers=all_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, **kwargs):
        headers = {"Authorization": "Bearer test-session-token"}
        headers.update(kwargs.pop("headers", {}))
        return self.request("POST", "/api/respond", body=kwargs.pop("body", REQUEST), headers=headers, **kwargs)

    def test_health_authenticates_without_model_call(self):
        status, _, raw = self.request()
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(raw)["authenticated"])
        status, _, raw = self.request(headers={"Authorization": "Bearer test-session-token"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["authenticated"])
        status, _, _ = self.request(headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(self.provider.calls, [])

    def test_authorized_request_reaches_only_selected_provider(self):
        status, headers, raw = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.origin)
        self.assertEqual(json.loads(raw), {"text": "[]", "input": 50, "output": 2})
        self.assertEqual(self.provider.calls[0], REQUEST | {"model": None})

    def test_rejects_bad_token_foreign_null_and_absent_origin(self):
        for headers, expected in [({"Authorization": "Bearer wrong"}, 401),
                                  ({"Origin": "https://evil.example"}, 403),
                                  ({"Origin": "null"}, 403),
                                  ({"Origin": ""}, 403),
                                  ({"Authorization": "Bearer café"}, 401)]:
            with self.subTest(headers=headers):
                status, response_headers, _ = self.post(headers=headers)
                self.assertEqual(status, expected)
                if expected == 403:
                    self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        self.assertEqual(self.provider.calls, [])

    def test_rejects_dns_rebinding_host(self):
        self.assertEqual(self.request(headers={"Host": "evil.example"})[0], 403)

    def test_github_origin_preflight_is_exact_and_does_not_infer(self):
        status, headers, _ = self.request("OPTIONS", "/api/respond", headers={
            "Origin": bridge.GITHUB_ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
            "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], bridge.GITHUB_ORIGIN)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.request(headers={"Origin": bridge.GITHUB_ORIGIN + ".evil.example"})[0], 403)

    def test_static_app_and_path_boundaries(self):
        self.assertEqual(self.request(path=bridge.APP_PATH)[2], b"<html>Fyr</html>")
        self.assertEqual(self.request(path="/")[1]["Location"], bridge.APP_PATH)
        for path in ["/private.txt", bridge.APP_PATH + "../private.txt", bridge.APP_PATH + "%2e%2e/private.txt",
                     bridge.APP_PATH + "escape.txt", bridge.APP_PATH + ".env"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path=path)[0], 404)

    def test_request_validation_and_size_limit(self):
        for body in [REQUEST | {"command": "rm -rf anything"}, REQUEST | {"model": "--dangerous"},
                     REQUEST | {"maxTokens": True}, REQUEST | {"maxTokens": 20000},
                     REQUEST | {"input": "x" * (bridge.MAX_INPUT + 1)}]:
            with self.subTest(body_keys=list(body)):
                self.assertEqual(self.post(body=body)[0], 400)
        self.assertEqual(self.post(headers={"Content-Length": str(bridge.MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.provider.calls, [])

    def test_rate_and_concurrent_inference_limits(self):
        for _ in range(6):
            self.assertEqual(self.post()[0], 200)
        self.assertEqual(self.post()[0], 429)
        self.server.requests.clear()
        self.server.inference.acquire()
        try:
            self.assertEqual(self.post()[0], 429)
        finally:
            self.server.inference.release()


class ProviderTests(unittest.TestCase):
    def test_loopback_only_urls(self):
        self.assertEqual(bridge.local_base_url("http://localhost:11434/v1/"), "http://127.0.0.1:11434/v1")
        self.assertEqual(bridge.local_base_url("http://[::1]:1234"), "http://[::1]:1234/v1")
        for value in ["https://api.example/v1", "http://127.0.0.1.evil.example/v1",
                      "http://user:secret@127.0.0.1/v1", "file:///tmp/server", "http://127.0.0.1/v1?key=secret"]:
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                bridge.local_base_url(value)

    def test_model_request_has_no_tools_and_reports_usage(self):
        provider = bridge.LocalModel("http://127.0.0.1:1234/v1", "local-model")
        reply = {"choices": [{"message": {"content": "[]"}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 35, "completion_tokens": 2}}
        with mock.patch.object(provider, "request", return_value=reply) as request:
            result = provider.respond(bridge.validate_request(REQUEST))
        path, payload = request.call_args.args
        self.assertEqual(path, "/chat/completions")
        self.assertNotIn("tools", payload)
        self.assertEqual(payload["max_tokens"], 12000)
        self.assertEqual(payload["messages"][1]["content"], REQUEST["input"])
        self.assertEqual(result, {"text": "[]", "input": 35, "output": 2})

    def test_local_transport_uses_json_and_optional_key(self):
        provider = bridge.LocalModel("http://127.0.0.1:1234/v1", "local-model", api_key="local-secret")
        response = io.BytesIO(b'{"choices":[]}')
        with mock.patch.object(provider.opener, "open", return_value=response) as opener:
            provider.request("/chat/completions", {"messages": []})
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:1234/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer local-secret")
        self.assertEqual(json.loads(request.data), {"messages": []})
        with self.assertRaises(bridge.BridgeError):
            bridge.NoRedirect().redirect_request(None, None, 302, "found", {}, "https://evil.example")

    def test_model_discovery_is_metadata_only_and_unambiguous(self):
        with mock.patch.object(bridge.LocalModel, "request", return_value={"data": [{"id": "loaded-model"}]}) as request:
            provider = bridge.LocalModel("http://127.0.0.1:1234/v1")
        self.assertEqual(provider.model, "loaded-model")
        request.assert_called_once_with("/models")
        with mock.patch.object(bridge.LocalModel, "request", return_value={"data": []}):
            with self.assertRaises(bridge.BridgeError):
                bridge.LocalModel("http://127.0.0.1:1234/v1")

    def test_model_tool_calls_and_truncation_are_rejected(self):
        provider = bridge.LocalModel("http://127.0.0.1:1234/v1", "local-model")
        for choice in [{"message": {"content": "hello", "tool_calls": [{"function": "anything"}]}},
                       {"message": {"content": "partial"}, "finish_reason": "length"}]:
            with mock.patch.object(provider, "request", return_value={"choices": [choice]}), self.assertRaises(bridge.BridgeError):
                provider.respond(bridge.validate_request(REQUEST))

    def test_claude_result_and_usage_are_validated(self):
        provider = object.__new__(bridge.Claude)
        provider.executable, provider.model, provider.timeout = "/bin/claude", "sonnet", 180
        success = {"type": "result", "subtype": "success", "is_error": False, "result": "[]",
                   "usage": {"input_tokens": 20, "cache_creation_input_tokens": 30,
                             "cache_read_input_tokens": 10, "output_tokens": 2}}
        with mock.patch.object(bridge, "run_claude", return_value=json.dumps(success)):
            self.assertEqual(provider.respond(bridge.validate_request(REQUEST)), {"text": "[]", "input": 60, "output": 2})
        for bad in [success | {"is_error": True}, success | {"subtype": "error_max_turns"},
                    success | {"stop_reason": "max_tokens"}]:
            with mock.patch.object(bridge, "run_claude", return_value=json.dumps(bad)), self.assertRaises(bridge.BridgeError):
                provider.respond(bridge.validate_request(REQUEST))

    def test_claude_invocation_disables_tools_and_isolates_private_input(self):
        observed = {}
        class Process:
            returncode = 0
            def poll(self): return 0
        def spawn(argv, **kwargs):
            observed.update(argv=argv, **kwargs)
            observed["source"] = kwargs["stdin"].read().decode()
            observed["instructions"] = Path(argv[argv.index("--system-prompt-file") + 1]).read_text()
            self.assertTrue(Path(kwargs["cwd"]).is_dir())
            kwargs["stdout"].write(b'{"type":"result"}')
            return Process()
        original_env = os.environ.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")
        with mock.patch.object(bridge.subprocess, "Popen", side_effect=spawn):
            raw = bridge.run_claude("/trusted/claude", bridge.validate_request(REQUEST), "sonnet", 180)
        self.assertEqual(raw, b'{"type":"result"}')
        args = observed["argv"]
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertEqual(args[args.index("--disallowedTools") + 1], "mcp__*")
        self.assertIn("--safe-mode", args)
        self.assertIn("--no-session-persistence", args)
        self.assertIn("--strict-mcp-config", args)
        self.assertEqual(observed["source"], REQUEST["input"])
        self.assertEqual(observed["instructions"], REQUEST["instructions"])
        self.assertNotIn(REQUEST["input"], args)
        self.assertNotIn(REQUEST["instructions"], args)
        self.assertFalse(observed["shell"])
        self.assertEqual(observed["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "12000")
        self.assertEqual(os.environ.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), original_env)
        self.assertFalse(Path(observed["cwd"]).exists())

    def test_claude_timeout_stops_process(self):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(bridge.subprocess, "Popen", return_value=process), \
                mock.patch.object(bridge.time, "monotonic", side_effect=[0, 181]), \
                mock.patch.object(bridge, "stop_process") as stop:
            with self.assertRaisesRegex(bridge.BridgeError, "timed out"):
                bridge.run_claude("/trusted/claude", bridge.validate_request(REQUEST), "sonnet", 180)
        stop.assert_called_once_with(process)

    def test_server_close_kills_active_child_and_removes_private_input(self):
        # A harmless real child exercises process-group cancellation without a CLI/model.
        provider = object.__new__(bridge.Claude)
        provider._process_lock = threading.Lock()
        provider._processes = {}
        provider._closed = False
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / "private-request"
            folder.mkdir()
            (folder / "input.txt").write_text("private test input")
            process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"],
                                       cwd=folder, start_new_session=(os.name == "posix"))
            try:
                provider._processes[process] = folder
                server = bridge.BridgeServer(provider, temporary, port=0)
                server.server_close()
                self.assertIsNotNone(process.poll())
                self.assertFalse(folder.exists())
                self.assertEqual(provider._processes, {})
            finally:
                bridge.stop_process(process)

    def test_local_read_budget_is_remaining_time_not_full_timeout(self):
        class Socket:
            def __init__(self): self.timeouts = []
            def settimeout(self, value): self.timeouts.append(value)
        transport = Socket()
        response = io.BytesIO(b'{"ok":true}')
        response.fp = mock.Mock()
        response.fp.raw._sock = transport
        provider = bridge.LocalModel("http://127.0.0.1:1234/v1", "test", timeout=1)
        with mock.patch.object(provider.opener, "open", return_value=response), \
                mock.patch.object(bridge.time, "monotonic", side_effect=[0, 0.1, 0.9]):
            self.assertEqual(provider.request("/models"), {"ok": True})
        self.assertEqual(len(transport.timeouts), 2)
        self.assertAlmostEqual(transport.timeouts[0], 0.9)
        self.assertAlmostEqual(transport.timeouts[1], 0.1)

    def test_local_server_byte_then_stall_respects_remaining_budget(self):
        class Handler(bridge.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                time.sleep(0.4)
                try:
                    self.wfile.write(b"{")
                    self.wfile.flush()
                    time.sleep(0.7)
                except OSError:
                    pass
        class Server(bridge.ThreadingHTTPServer):
            daemon_threads = True
        with Server(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
            thread.start()
            provider = bridge.LocalModel(f"http://127.0.0.1:{server.server_address[1]}/v1", "test", timeout=0.5)
            started = time.monotonic()
            try:
                with self.assertRaises(bridge.BridgeError) as caught:
                    provider.request("/models")
                self.assertEqual(caught.exception.status, 504)
                # Old code reset a full .5s after the byte, taking about .9s.
                self.assertLess(time.monotonic() - started, 0.8)
            finally:
                server.shutdown()
                thread.join(timeout=1)

    def test_closing_provider_prevents_new_child_launch(self):
        provider = object.__new__(bridge.Claude)
        provider._process_lock = threading.Lock()
        provider._processes = {}
        provider._closed = False
        provider.close()
        with mock.patch.object(bridge.subprocess, "Popen") as spawn:
            with self.assertRaises(bridge.BridgeError):
                provider._spawn(["claude"], {}, Path("/tmp"))
        spawn.assert_not_called()

    def test_truncated_http_body_becomes_structured_bridge_error(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read1.side_effect = http.client.IncompleteRead(b"partial")
        provider = bridge.LocalModel("http://127.0.0.1:1234/v1", "test")
        with mock.patch.object(provider.opener, "open", return_value=response):
            with self.assertRaises(bridge.BridgeError) as caught:
                provider.request("/models")
        self.assertEqual(caught.exception.status, 504)

    def test_fast_claude_stderr_cannot_bypass_output_limit(self):
        class Process:
            returncode = 0
            def poll(self): return 0
        def spawn(argv, **kwargs):
            kwargs["stderr"].write(b"x" * 40)
            kwargs["stderr"].flush()
            kwargs["stdout"].write(b"{}")
            kwargs["stdout"].flush()
            return Process()
        with mock.patch.object(bridge, "MAX_RESPONSE", 32), \
                mock.patch.object(bridge.subprocess, "Popen", side_effect=spawn):
            with self.assertRaisesRegex(bridge.BridgeError, "too much output"):
                bridge.run_claude("/trusted/claude", bridge.validate_request(REQUEST), "sonnet", 180)

    def test_unsupported_codex_refuses_without_subprocess(self):
        with mock.patch.object(bridge.subprocess, "Popen") as process, \
                mock.patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit):
                bridge.main(["--provider", "codex"])
        process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
