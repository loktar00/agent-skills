#!/usr/bin/env python3
"""Minimal streaming proxy: forwards OpenAI-compatible requests to an upstream OpenAI-compatible server (e.g. local vLLM),
injecting chat_template_kwargs {"reasoning_effort": <effort>} into every /chat/completions body
(omp cannot send that parameter itself). No retry/continuation logic — local servers are stable.

Usage: python effort_proxy.py [--port 8798] [--effort medium]
"""
import argparse
import http.server
import json
import socketserver
import urllib.request

UPSTREAM = "http://127.0.0.1:8080/v1"
EFFORT = "medium"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):  # /v1/models passthrough for discovery
        try:
            with urllib.request.urlopen(UPSTREAM + self.path.replace("/v1", "", 1), timeout=30) as r:
                data = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            self.send_error(502, str(e)[:100])

    def do_POST(self):
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                obj = json.loads(body)
                kw = obj.get("chat_template_kwargs") or {}
                kw.setdefault("reasoning_effort", EFFORT)
                obj["chat_template_kwargs"] = kw
                body = json.dumps(obj).encode()
            except Exception:  # noqa: BLE001
                pass  # non-JSON: forward untouched
            req = urllib.request.Request(
                UPSTREAM + self.path.replace("/v1", "", 1), data=body, method="POST",
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=1800) as r:
                self.send_response(r.status)
                ct = r.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", ct)
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    chunk = r.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:  # noqa: BLE001
            try:
                self.send_error(502, str(e)[:100])
            except Exception:  # noqa: BLE001
                pass


def main():
    global UPSTREAM, EFFORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8798)
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--upstream", default=UPSTREAM)
    a = ap.parse_args()
    EFFORT = a.effort
    UPSTREAM = a.upstream
    with socketserver.ThreadingTCPServer(("127.0.0.1", a.port), Handler) as srv:
        srv.daemon_threads = True
        print(f"effort proxy on 127.0.0.1:{a.port} -> {UPSTREAM} (reasoning_effort={EFFORT})")
        srv.serve_forever()


if __name__ == "__main__":
    main()
