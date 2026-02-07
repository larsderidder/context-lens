"""
mitmproxy addon for Context Lens.

Captures LLM API requests passing through mitmproxy and forwards them
to Context Lens's ingest API for visualization.

Usage:
    mitmdump -s mitm_addon.py

Then run codex through the proxy:
    https_proxy=http://localhost:8080 SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem codex "prompt"

View at http://localhost:4041
"""

import json
import urllib.request
from mitmproxy import http

INGEST_URL = "http://localhost:4041/api/ingest"

# Patterns to capture: (host_substring, path_substring) -> (provider, source)
CAPTURE_PATTERNS = [
    # Codex subscription
    ("chatgpt.com", "/backend-api/codex/responses", "chatgpt", "codex"),
    # OpenAI API (if someone uses forward proxy for API key tools too)
    ("api.openai.com", "/v1/responses", "openai", "openai"),
    ("api.openai.com", "/v1/chat/completions", "openai", "openai"),
    # Anthropic API
    ("api.anthropic.com", "/v1/messages", "anthropic", "anthropic"),
]


def match_request(flow: http.HTTPFlow):
    """Check if this request matches a known LLM API pattern."""
    host = flow.request.pretty_host
    path = flow.request.path
    for host_pat, path_pat, provider, source in CAPTURE_PATTERNS:
        if host_pat in host and path_pat in path:
            return provider, source
    return None, None


def response(flow: http.HTTPFlow):
    """Called when a response is received."""
    if flow.request.method != "POST":
        return

    provider, source = match_request(flow)
    if not provider:
        return

    try:
        request_body = json.loads(flow.request.get_text())
    except (json.JSONDecodeError, ValueError):
        return

    try:
        response_body = json.loads(flow.response.get_text())
    except (json.JSONDecodeError, ValueError):
        response_body = {}

    # Detect API format from path
    path = flow.request.path
    if "/responses" in path:
        api_format = "responses"
    elif "/chat/completions" in path:
        api_format = "chat-completions"
    elif "/v1/messages" in path:
        api_format = "anthropic-messages"
    else:
        api_format = "chatgpt-backend"

    payload = json.dumps({
        "provider": provider,
        "apiFormat": api_format,
        "source": source,
        "body": request_body,
        "response": response_body,
    }).encode()

    try:
        req = urllib.request.Request(
            INGEST_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception as e:
        print(f"[context-lens] Failed to ingest: {e}")
