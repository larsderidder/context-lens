"""Offline capture-delivery regressions using real urllib transports."""

import contextlib
import io
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast
from unittest.mock import patch

if TYPE_CHECKING:
    from mitmproxy import http

    import mitm_addon
else:
    # Only HTTPFlow annotations need mitmproxy; capture delivery uses real urllib.
    with patch.dict(sys.modules, {"mitmproxy": SimpleNamespace(http=SimpleNamespace(HTTPFlow=object))}):
        import mitm_addon


class IngestDeliveryTests(unittest.TestCase):
    """Exercise HTTP and WebSocket capture callbacks without provider traffic."""

    def setUp(self) -> None:
        """Start independent ingestion and simulated ambient-proxy listeners."""
        self.requests: list[tuple[str, bytes]] = []
        self.proxy_requests: list[str] = []
        self.status = 200
        self.location = ""
        test = self

        class IngestHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                """Record captures and optionally return an error or redirect."""
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                test.requests.append((self.path, body))
                self.send_response(test.status)
                if test.location:
                    self.send_header("Location", test.location)
                self.end_headers()

            def do_GET(self) -> None:
                """Record redirect follow-ups even when urllib changes the method."""
                test.requests.append((self.path, b""))
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                """Keep expected HTTP errors out of test output."""

        class ProxyHandler(IngestHandler):
            def do_POST(self) -> None:
                """Record accidental proxy use or redirected capture delivery."""
                test.proxy_requests.append(self.path)
                super().do_POST()

            def do_GET(self) -> None:
                """Record redirected GET requests too."""
                test.proxy_requests.append(self.path)
                super().do_GET()

        self.ingest = ThreadingHTTPServer(("127.0.0.1", 0), IngestHandler)
        self.proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
        for server in (self.ingest, self.proxy):
            self.addCleanup(server.server_close)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join)
            self.addCleanup(server.shutdown)

        self.url = f"http://127.0.0.1:{self.ingest.server_port}/api/ingest?source=test"
        self.proxy_url = f"http://127.0.0.1:{self.proxy.server_port}"
        self.enterContext(patch.object(mitm_addon, "INGEST_URL", self.url))
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "HTTP_PROXY": self.proxy_url,
                    "http_proxy": self.proxy_url,
                    "HTTPS_PROXY": self.proxy_url,
                    "https_proxy": self.proxy_url,
                    "NO_PROXY": "",
                    "no_proxy": "",
                },
            )
        )

    def emit_capture(self, websocket: bool = False, status: int = 200) -> None:
        """Pass a synthetic provider exchange through the actual addon callbacks."""
        request_body = {"model": "test", "messages": []}
        request_bytes = json.dumps(request_body).encode()
        flow = SimpleNamespace(
            id="offline-flow",
            request=SimpleNamespace(
                method="POST",
                pretty_host="chatgpt.com",
                path="/backend-api/codex/responses",
                pretty_url="https://chatgpt.com/backend-api/codex/responses",
                headers={},
                raw_content=request_bytes,
                timestamp_start=1,
                get_text=lambda: request_bytes.decode(),
            ),
            response=SimpleNamespace(
                status_code=status,
                headers={"content-type": "application/json"},
                raw_content=b"{}",
                timestamp_end=2,
                get_text=lambda: "{}",
            ),
        )
        capture_flow = cast("http.HTTPFlow", flow)
        with contextlib.redirect_stdout(io.StringIO()):
            if websocket:
                flow.websocket = SimpleNamespace(
                    messages=[
                        SimpleNamespace(
                            from_client=True,
                            text=json.dumps({"type": "response.create", **request_body}),
                        )
                    ]
                )
                mitm_addon.websocket_message(capture_flow)
                flow.websocket.messages.append(
                    SimpleNamespace(
                        from_client=False,
                        text=json.dumps({"type": "response.completed", "response": {"id": "offline-response"}}),
                    )
                )
                mitm_addon.websocket_message(capture_flow)
            else:
                mitm_addon.response(capture_flow)

    def test_all_capture_paths_ignore_ambient_proxies(self) -> None:
        """Deliver success, provider-error and WebSocket captures directly."""
        self.emit_capture()
        self.emit_capture(status=429)
        self.emit_capture(websocket=True)
        self.assertEqual(self.proxy_requests, [])
        self.assertEqual([path for path, _ in self.requests], ["/api/ingest?source=test"] * 3)
        captures = [json.loads(body) for _, body in self.requests]
        self.assertEqual([capture["responseStatus"] for capture in captures], [200, 429, 200])
        self.assertEqual(captures[2]["requestBody"]["type"], "response.create")

    def test_ingest_errors_do_not_retry_through_proxy(self) -> None:
        """Both callback error branches keep failed delivery at the configured URL."""
        self.status = 500
        self.emit_capture()
        self.emit_capture(websocket=True)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.proxy_requests, [])

    def test_redirects_are_rejected(self) -> None:
        """Neither local nor cross-origin redirects may relocate captures."""
        for destination in (self.url + "&redirected=1", self.proxy_url + "/external"):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(destination=destination, status=status):
                    self.status = status
                    self.location = destination
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        mitm_addon._post_capture(b'{"capture":"private"}')
                    self.assertEqual(error.exception.code, status)
        self.assertEqual(len(self.requests), 10)
        self.assertEqual(self.proxy_requests, [])

    def test_https_still_verifies_certificates(self) -> None:
        """An explicit HTTPS ingest endpoint must reject an untrusted certificate."""
        with tempfile.TemporaryDirectory(prefix="context-lens-ingest-tls-") as directory:
            cert = Path(directory) / "cert.pem"
            key = Path(directory) / "key.pem"
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    str(key),
                    "-out",
                    str(cert),
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
                    "-addext",
                    "subjectAltName=DNS:localhost",
                ],
                check=True,
                capture_output=True,
            )
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            self.ingest.socket = context.wrap_socket(self.ingest.socket, server_side=True)
            mitm_addon.INGEST_URL = f"https://localhost:{self.ingest.server_port}/api/ingest"
            with self.assertRaises(urllib.error.URLError) as error:
                mitm_addon._post_capture(b"{}")
            self.assertIsInstance(error.exception.reason, ssl.SSLCertVerificationError)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.proxy_requests, [])


if __name__ == "__main__":
    unittest.main()
