#!/usr/bin/env python3
"""Run Fyr locally with Claude CLI or an OpenAI-compatible loopback model.

Examples:
  python3 scripts/local_bridge.py --provider claude
  python3 scripts/local_bridge.py --provider local-llm --model MODEL
  python3 scripts/local_bridge.py --provider local-llm --base-url http://127.0.0.1:11434/v1 --model MODEL

Build the app first with npm run build. The printed connection token belongs to
this process only. Claude uses its configured account/provider; local-llm sends
requests only to the configured loopback server. No model tools are exposed.
"""
from __future__ import annotations

import argparse
import collections
import hmac
import http.client
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_PATH = "/fyr-arxiv-reader/"
GITHUB_ORIGIN = "https://denniseriksson-math.github.io"
MAX_BODY = 512_000
MAX_INPUT = 300_000
MAX_INSTRUCTIONS = 16_000
MAX_RESPONSE = 2_000_000
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,159}\Z")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class BridgeError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def model_name(value):
    if not isinstance(value, str) or not MODEL_NAME.fullmatch(value):
        raise BridgeError("Use a model identifier without spaces or command-line flags.", 400)
    return value


def validate_request(value):
    if not isinstance(value, dict) or set(value) - {"instructions", "input", "maxTokens", "model"}:
        raise BridgeError("Expected instructions, input, maxTokens, and optional model.", 400)
    for key, limit in (("instructions", MAX_INSTRUCTIONS), ("input", MAX_INPUT)):
        if not isinstance(value.get(key), str) or not value[key].strip() or len(value[key]) > limit:
            raise BridgeError(f"{key} must be nonempty text of at most {limit} characters.", 400)
    tokens = value.get("maxTokens", 4000)
    if isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= 16384:
        raise BridgeError("maxTokens must be an integer between 1 and 16384.", 400)
    model = value.get("model")
    if model not in (None, ""):
        model = model_name(model)
    return {"instructions": value["instructions"], "input": value["input"],
            "maxTokens": tokens, "model": model or None}


def counter(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise BridgeError("The local model server redirected the request; redirects are disabled.")


def local_base_url(value):
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
    except ValueError as exc:
        raise BridgeError("Invalid local model server URL.", 400) from exc
    if (url.scheme not in {"http", "https"} or url.hostname not in LOOPBACK_HOSTS
            or url.username or url.password or url.query or url.fragment
            or url.path.rstrip("/") not in {"", "/v1"}):
        raise BridgeError("The model server must be http(s)://127.0.0.1, localhost, or [::1], with /v1.", 400)
    # A proxy or a changed localhost DNS entry must not receive private prompts.
    host = "127.0.0.1" if url.hostname == "localhost" else url.hostname
    authority = f"[{host}]" if host == "::1" else host
    if port is not None:
        authority += f":{port}"
    return f"{url.scheme}://{authority}/v1"


class LocalModel:
    name = "local-llm"
    max_tokens_enforced = True

    def __init__(self, base_url, model=None, timeout=180, api_key=None):
        self.base_url = local_base_url(base_url)
        self.timeout = timeout
        self.api_key = api_key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.model = model_name(model) if model else self.discover_model()

    def request(self, path, payload=None):
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            deadline = time.monotonic() + self.timeout
            with self.opener.open(request, timeout=self.timeout) as response:
                chunks, size = [], 0
                # urllib's HTTPResponse wraps the socket in BufferedReader/SocketIO.
                # Shrink its timeout before every read: dribbling a byte cannot
                # reset the entire response budget. Mock responses need no socket.
                transport = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise BridgeError("The local model response timed out.", 504)
                    if transport is not None:
                        transport.settimeout(remaining)
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_RESPONSE:
                        raise BridgeError("The local model returned too much output.")
                    chunks.append(chunk)
            result = json.loads(b"".join(chunks))
            if not isinstance(result, dict):
                raise ValueError("not an object")
            return result
        except urllib.error.HTTPError as exc:
            raise BridgeError(f"The local model server returned HTTP {exc.code}. Check its model and authentication.") from exc
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
            raise BridgeError("Could not reach the local model server, or it timed out. Check that it is running.", 504) from exc
        except (ValueError, UnicodeError) as exc:
            raise BridgeError("The local model server returned invalid JSON.") from exc

    def discover_model(self):
        data = self.request("/models").get("data", [])
        ids = [item.get("id") for item in data if isinstance(item, dict)] if isinstance(data, list) else []
        ids = [value for value in ids if isinstance(value, str) and MODEL_NAME.fullmatch(value)]
        if len(ids) != 1:
            raise BridgeError("Launch with --model MODEL using an identifier from your local server; exactly one model was not available.", 400)
        return ids[0]

    def respond(self, request):
        result = self.request("/chat/completions", {
            "model": request["model"] or self.model,
            "messages": [{"role": "system", "content": request["instructions"]},
                         {"role": "user", "content": request["input"]}],
            "max_tokens": request["maxTokens"], "stream": False,
        })
        choices = result.get("choices")
        choice = choices[0] if isinstance(choices, list) and choices else {}
        message = choice.get("message", {}) if isinstance(choice, dict) else {}
        if not isinstance(message, dict) or message.get("tool_calls"):
            raise BridgeError("The model requested a tool; this bridge only accepts text responses.")
        text = message.get("content")
        if not isinstance(text, str) or not text.strip():
            raise BridgeError("The model returned no text.")
        if choice.get("finish_reason") == "length":
            raise BridgeError("The local model reached its output limit. Try a smaller shortlist.")
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        return {"text": text, "input": counter(usage.get("prompt_tokens")),
                "output": counter(usage.get("completion_tokens"))}


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        process.kill()
    process.wait(timeout=5)


def run_claude(executable, request, model, timeout, *, spawn_process=None, on_stop=None):
    """Private temporary input files avoid profile text in process arguments."""
    with tempfile.TemporaryDirectory(prefix="fyr-cli-") as temporary:
        folder = Path(temporary)
        instructions = folder / "instructions.txt"
        instructions.write_text(request["instructions"], encoding="utf-8")
        input_path = folder / "input.txt"
        input_path.write_text(request["input"], encoding="utf-8")
        argv = [executable, "--print", "--output-format", "json", "--tools", "",
                "--disallowedTools", "mcp__*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--safe-mode", "--settings", '{"disableAllHooks":true}', "--no-session-persistence",
                "--disable-slash-commands", "--no-chrome", "--permission-prompts", "none",
                "--max-turns", "1", "--system-prompt-file", str(instructions), "--model", model]
        environment = os.environ.copy()
        # Claude documents this for most requests; timeout/output-size limits remain necessary.
        environment["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(request["maxTokens"])
        with input_path.open("rb") as source, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            options = dict(stdin=source, stdout=output, stderr=errors, cwd=folder,
                           env=environment, shell=False, start_new_session=(os.name == "posix"))
            process = (spawn_process(argv, options, folder) if spawn_process else
                       subprocess.Popen(argv, **options))
            deadline = time.monotonic() + timeout
            try:
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        raise BridgeError("Claude timed out. Try a smaller shortlist.", 504)
                    if os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size > MAX_RESPONSE:
                        raise BridgeError("Claude returned too much output.")
                    time.sleep(0.1)
                if os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size > MAX_RESPONSE:
                    raise BridgeError("Claude returned too much output.")
                output.seek(0)
                raw = output.read(MAX_RESPONSE + 1)
                if process.returncode != 0:
                    raise BridgeError("Claude could not complete the request. Check its login in a separate terminal.")
                if len(raw) > MAX_RESPONSE:
                    raise BridgeError("Claude returned too much output.")
                return raw
            finally:
                stop_process(process)
                if on_stop:
                    on_stop(process)


class Claude:
    name = "claude"
    max_tokens_enforced = False

    def __init__(self, model="sonnet", timeout=180):
        self.model = model_name(model)
        self.timeout = timeout
        self._process_lock = threading.Lock()
        self._processes = {}
        self._closed = False
        self.executable = shutil.which("claude")
        if not self.executable:
            raise BridgeError("Claude CLI is not installed. Install it and sign in before starting the bridge.", 400)
        # Help-only capability check; never starts a model request.
        with tempfile.TemporaryDirectory(prefix="fyr-cli-check-") as temporary:
            try:
                result = subprocess.run([self.executable, "--help"], capture_output=True,
                                        timeout=10, cwd=temporary, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise BridgeError("Could not inspect Claude CLI. Check its installation.", 400) from exc
        help_text = result.stdout.decode("utf-8", errors="replace")
        required = ("--safe-mode", "--tools", "--strict-mcp-config", "--permission-prompts",
                    "--no-session-persistence", "--disable-slash-commands", "--no-chrome")
        if result.returncode or not all(flag in help_text for flag in required):
            raise BridgeError("Update Claude CLI: this bridge requires safe mode and explicit tool/MCP disabling.", 400)

    def _spawn(self, argv, options, folder):
        # Launch and registration share the shutdown lock: closing the server
        # cannot race between Popen and adding its child to the registry.
        with self._process_lock:
            if self._closed:
                raise BridgeError("The bridge is shutting down.", 503)
            process = subprocess.Popen(argv, **options)
            self._processes[process] = folder
            return process

    def _stopped(self, process):
        with self._process_lock:
            self._processes.pop(process, None)

    def close(self):
        # HTTP handlers are daemon threads. Cancel detached CLI children explicitly
        # before Python exits, and remove their private temporary prompt files.
        with self._process_lock:
            self._closed = True
            active = list(self._processes.items())
        for process, folder in active:
            stop_process(process)
            shutil.rmtree(folder, ignore_errors=True)
        with self._process_lock:
            self._processes.clear()

    def respond(self, request):
        try:
            raw = run_claude(self.executable, request, request["model"] or self.model, self.timeout,
                            spawn_process=self._spawn, on_stop=self._stopped)
            result = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise BridgeError("Claude returned an unreadable result.") from exc
        except OSError as exc:
            raise BridgeError("Could not start Claude CLI.") from exc
        if (not isinstance(result, dict) or result.get("type") != "result"
                or result.get("subtype") != "success" or result.get("is_error") is not False
                or not isinstance(result.get("result"), str) or not result["result"].strip()):
            raise BridgeError("Claude did not return a successful text result.")
        if result.get("stop_reason") == "max_tokens":
            raise BridgeError("Claude reached its output limit. Try a smaller shortlist.")
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        incoming = counter(usage.get("input_tokens"))
        if incoming is not None:
            incoming += (counter(usage.get("cache_creation_input_tokens")) or 0)
            incoming += (counter(usage.get("cache_read_input_tokens")) or 0)
        return {"text": result["result"], "input": incoming,
                "output": counter(usage.get("output_tokens"))}


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, provider, dist, port=8790, token=None):
        self.provider = provider
        self.dist = Path(dist).resolve()
        self.token = token or secrets.token_urlsafe(32)
        self.inference = threading.Lock()
        self.rate_lock = threading.Lock()
        self.requests = collections.deque()
        self.connections = threading.BoundedSemaphore(8)
        super().__init__(("127.0.0.1", port), BridgeHandler)
        actual_port = self.server_address[1]
        self.hosts = {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
        self.origins = {f"http://{host}" for host in self.hosts} | {GITHUB_ORIGIN}

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def server_close(self):
        close = getattr(self.provider, "close", None)
        if close:
            close()
        super().server_close()

    def rate_allowed(self):
        with self.rate_lock:
            now = time.monotonic()
            while self.requests and self.requests[0] <= now - 60:
                self.requests.popleft()
            if len(self.requests) >= 6:
                return False
            self.requests.append(now)
            return True


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "FyrLocalBridge/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass  # Never log prompts, auth headers, query strings, or provider output.

    def trusted(self, require_origin=False):
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or hosts[0].lower() not in self.server.hosts:
            raise BridgeError("Use this bridge through its printed localhost address.", 403)
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and origins[0] not in self.server.origins):
            raise BridgeError("This website is not allowed to use the bridge.", 403)
        if require_origin and not origins:
            raise BridgeError("An explicit trusted Origin is required.", 403)
        return origins[0] if origins else None

    def authorized(self, required=True):
        headers = self.headers.get_all("Authorization", [])
        provided = headers[0] if len(headers) == 1 else None
        valid = isinstance(provided, str) and hmac.compare_digest(provided.encode("utf-8"), ("Bearer " + self.server.token).encode("utf-8"))
        if not valid and (required or headers):
            raise BridgeError("Enter the connection token printed by this bridge process.", 401)
        return valid

    def headers_for(self, status, content_type, size, preflight=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
        if preflight:
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def json(self, status, value):
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.headers_for(status, "application/json; charset=utf-8", len(raw))
        self.wfile.write(raw)

    def do_OPTIONS(self):
        try:
            self.trusted(require_origin=True)
            if self.path not in {"/api/respond", "/api/health"}:
                raise BridgeError("Unknown endpoint.", 404)
            requested = {h.strip().lower() for h in self.headers.get("Access-Control-Request-Headers", "").split(",") if h.strip()}
            if (self.headers.get("Access-Control-Request-Method") not in {"GET", "POST"}
                    or not requested <= {"authorization", "content-type"}):
                raise BridgeError("Unsupported request headers or method.", 403)
            self.headers_for(204, "text/plain", 0, preflight=True)
        except BridgeError as exc:
            self.json(exc.status, {"error": str(exc)})

    def do_GET(self):
        try:
            self.trusted()
            path = urllib.parse.urlsplit(self.path).path
            if path == "/api/health":
                authenticated = self.authorized(required=False)
                self.json(200, {"provider": self.server.provider.name,
                                "model": self.server.provider.model, "authenticated": authenticated,
                                "maxTokensEnforced": self.server.provider.max_tokens_enforced})
                return
            if path in {"/", APP_PATH.rstrip("/")}:
                self.send_response(302)
                self.send_header("Location", APP_PATH)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if not path.startswith(APP_PATH):
                raise BridgeError("Not found.", 404)
            relative = urllib.parse.unquote(path[len(APP_PATH):]) or "index.html"
            if any(part.startswith(".") for part in Path(relative).parts):
                raise BridgeError("Not found.", 404)
            target = (self.server.dist / relative).resolve()
            if not target.is_relative_to(self.server.dist) or not target.is_file():
                raise BridgeError("Not found.", 404)
            if target.stat().st_size > 16_000_000:
                raise BridgeError("File is too large.", 413)
            raw = target.read_bytes()
            mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.headers_for(200, mime, len(raw))
            self.wfile.write(raw)
        except BridgeError as exc:
            self.json(exc.status, {"error": str(exc)})
        except (OSError, ValueError):
            self.json(404, {"error": "Not found."})

    def do_POST(self):
        acquired = False
        try:
            self.trusted(require_origin=True)
            self.authorized()
            if self.path != "/api/respond":
                raise BridgeError("Unknown endpoint.", 404)
            lengths = self.headers.get_all("Content-Length", [])
            if (len(lengths) != 1 or not lengths[0].isdigit()
                    or self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding")):
                raise BridgeError("Use one Content-Length with uncompressed JSON.", 400)
            length = int(lengths[0])
            if not 0 < length <= MAX_BODY:
                raise BridgeError("Request is too large or empty.", 413)
            if self.headers.get_content_type() != "application/json":
                raise BridgeError("Use application/json.", 415)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise BridgeError("Incomplete request body.", 400)
            try:
                request = validate_request(json.loads(raw))
            except (ValueError, UnicodeError) as exc:
                raise BridgeError("Invalid JSON request.", 400) from exc
            acquired = self.server.inference.acquire(blocking=False)
            if not acquired:
                raise BridgeError("A model request is already running. Try again when it finishes.", 429)
            if not self.server.rate_allowed():
                raise BridgeError("The bridge allows six model requests per minute. Try again shortly.", 429)
            self.json(200, self.server.provider.respond(request))
        except BridgeError as exc:
            self.json(exc.status, {"error": str(exc)})
        except (TimeoutError, OSError):
            self.json(504, {"error": "The request timed out or the local connection closed."})
        finally:
            if acquired:
                self.server.inference.release()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider", choices=("claude", "local-llm", "codex"), default="claude")
    parser.add_argument("--model", help="Claude alias/model ID, or local server model ID; blank uses the provider default")
    parser.add_argument("--base-url", default="http://127.0.0.1:1234/v1", help="Loopback model server; local-llm only")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[1] / "dist")
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535 or not 10 <= args.timeout <= 300:
        parser.error("Use a port from 1024 to 65535 and timeout from 10 to 300 seconds.")
    if args.provider == "codex":
        parser.error("Codex CLI has no verified all-tools-disabled mode. Use --provider claude or local-llm.")
    if not (args.dist / "index.html").is_file():
        parser.error("Build the app first with npm run build; dist/index.html was not found.")
    try:
        provider = (Claude(args.model or "sonnet", args.timeout) if args.provider == "claude" else
                    LocalModel(args.base_url, args.model, args.timeout, os.environ.get("FYR_LOCAL_LLM_API_KEY")))
        with BridgeServer(provider, args.dist, args.port) as server:
            print(f"Fyr: http://127.0.0.1:{args.port}{APP_PATH}")
            print(f"Connection token: {server.token}")
            print(f"Provider: {provider.name} / {provider.model}. Model tools are disabled.")
            if provider.name == "claude":
                print("Claude uses its configured account and network provider; existing managed policies still apply.")
            print("Keep this terminal open. Press Ctrl+C to stop.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        return 0
    except (BridgeError, OSError) as exc:
        print(f"Could not start bridge: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
