"""
mitmproxy addon for Context Lens.

Captures LLM API requests passing through mitmproxy and forwards them
to Context Lens's ingest API for visualization.

This addon is used for Codex (subscription mode) and other tools that
connect directly to their APIs over HTTPS and cannot be redirected to
a custom base URL. The CLI starts mitmproxy automatically when needed.

Manual usage:
    context-lens background start
    mitmdump -p 8888 -s mitm_addon.py
    https_proxy=http://localhost:8888 SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem codex "prompt"

View at http://localhost:4041

Environment variables:
  CONTEXT_LENS_INGEST_URL  - ingest endpoint (default: "http://localhost:4041/api/ingest")
  CONTEXT_LENS_SESSION_ID  - session ID for grouping (default: "")
"""

import json
import os
import time
import urllib.request
from mitmproxy import http

INGEST_URL = os.environ.get("CONTEXT_LENS_INGEST_URL", "http://localhost:4041/api/ingest")
CONTEXT_LENS_SESSION_ID = os.environ.get("CONTEXT_LENS_SESSION_ID", "").strip()

# Patterns to capture: (host_substring, path_substring) -> (provider, source)
# More specific patterns must come before generic ones.
CAPTURE_PATTERNS = [
    # Codex subscription (specific tool identity, keep as-is)
    ("chatgpt.com", "/backend-api/codex/responses", "chatgpt", "codex"),
    # OpenAI API — source left as None so detectSource can identify the tool
    # from headers/system prompts (opencode, aider, etc.)
    ("api.openai.com", "/v1/responses", "openai", None),
    ("api.openai.com", "/v1/chat/completions", "openai", None),
    # Anthropic API — same: leave source unset for tool detection
    ("api.anthropic.com", "/v1/messages", "anthropic", None),
    # Gemini API
    ("generativelanguage.googleapis.com", "/v1", "gemini", None),
]

# Catch-all path patterns: match any host with these path substrings.
# Used for OpenAI-compatible providers (OpenCode Zen, OpenRouter, etc.)
CATCHALL_PATH_PATTERNS = [
    ("/v1/chat/completions", "openai"),
    ("/v1/messages", "anthropic"),
    ("/v1/responses", "openai"),
]


def match_request(flow: http.HTTPFlow):
    """Check if this request matches a known LLM API pattern."""
    host = flow.request.pretty_host
    path = flow.request.path
    for host_pat, path_pat, provider, source in CAPTURE_PATTERNS:
        if host_pat in host and path_pat in path:
            return provider, source
    # Fall back to catch-all path matching for OpenAI-compatible providers
    for path_pat, provider in CATCHALL_PATH_PATTERNS:
        if path_pat in path:
            # Use the host as the source tag so sessions are labelled by provider
            source = host.split(".")[0] if "." in host else host
            return provider, source
    return None, None


def _detect_api_format(path: str) -> str:
    """Detect API format from the request path."""
    if "/backend-api/" in path:
        return "responses"
    if "/responses" in path:
        return "responses"
    if "/chat/completions" in path:
        return "chat-completions"
    if "/v1/messages" in path:
        return "anthropic-messages"
    return "unknown"


def _parse_sse_response(text: str) -> str:
    """Parse SSE event stream, extracting data lines as raw text.

    Returns the raw SSE text for the capture. The analysis server
    handles SSE parsing during ingestion.
    """
    return text


def response(flow: http.HTTPFlow):
    """Called when a response is received."""
    if flow.request.method != "POST":
        return

    provider, source = match_request(flow)
    if not provider:
        return

    # Parse request body (mitmproxy auto-decompresses zstd/gzip)
    try:
        request_text = flow.request.get_text()
        request_body = json.loads(request_text)
    except (json.JSONDecodeError, ValueError, Exception) as e:
        print(f"[context-lens] Could not parse request body: {e}")
        return

    # Get response body (may be JSON or SSE event stream)
    response_body = ""
    response_is_streaming = False
    try:
        response_text = flow.response.get_text()
        content_type = flow.response.headers.get("content-type", "")

        if "text/event-stream" in content_type or response_text.startswith("event:"):
            response_body = response_text
            response_is_streaming = True
        else:
            response_body = response_text
    except Exception as e:
        print(f"[context-lens] Could not read response body: {e}")
        response_body = ""

    # Build capture in the same format as proxy/capture.ts
    api_format = _detect_api_format(flow.request.path)

    # Select safe headers (no auth tokens)
    safe_request_headers = {}
    for k, v in flow.request.headers.items():
        lower = k.lower()
        if lower in ("content-type", "content-encoding", "accept",
                      "user-agent", "anthropic-version", "openai-beta",
                      "x-request-id"):
            safe_request_headers[k] = v

    safe_response_headers = {}
    for k, v in flow.response.headers.items():
        lower = k.lower()
        if lower in ("content-type", "x-request-id", "x-ratelimit-limit-requests",
                      "x-ratelimit-remaining-requests", "x-ratelimit-limit-tokens",
                      "x-ratelimit-remaining-tokens", "openai-processing-ms",
                      "anthropic-ratelimit-requests-limit",
                      "anthropic-ratelimit-requests-remaining"):
            safe_response_headers[k] = v

    capture = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "method": "POST",
        "path": flow.request.path,
        "source": source,
        "provider": provider,
        "apiFormat": api_format,
        "targetUrl": flow.request.pretty_url,
        "requestHeaders": safe_request_headers,
        "requestBody": request_body,
        "requestBytes": len(flow.request.raw_content),
        "responseStatus": flow.response.status_code,
        "responseHeaders": safe_response_headers,
        "responseBody": response_body,
        "responseIsStreaming": response_is_streaming,
        "responseBytes": len(flow.response.raw_content),
        "sessionId": CONTEXT_LENS_SESSION_ID or None,
        "timings": {
            "send_ms": 0,
            "wait_ms": 0,
            "receive_ms": 0,
            "total_ms": int((flow.response.timestamp_end - flow.request.timestamp_start) * 1000)
            if flow.response.timestamp_end and flow.request.timestamp_start else 0,
        },
    }

    payload = json.dumps(capture).encode()

    try:
        req = urllib.request.Request(
            INGEST_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
        model = request_body.get("model", "unknown")
        print(f"[context-lens] Captured {source}/{provider} request (model={model})")
    except Exception as e:
        print(f"[context-lens] Failed to ingest: {e}")
