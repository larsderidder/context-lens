# Architecture

Context Lens has two interception paths depending on the tool being observed.

## Path 1: Reverse Proxy (Claude, aider, API-key tools)

Tools that use standard API SDKs with configurable base URLs.

```
claude ──ANTHROPIC_BASE_URL──> Context Lens :4040 ──> api.anthropic.com
                                     │
                                     ▼
                               Web UI :4041
```

The SDK sends requests to `localhost:4040` instead of the real API. Context Lens
parses the request body, captures the context, and forwards the request upstream.
The response flows back through the proxy transparently.

**Why this works:** The Anthropic SDK (and standard OpenAI SDK with API keys) lets
you override the base URL with an env var. No TLS issues because the local leg is
plain HTTP and the upstream leg is a normal HTTPS request from Node.js.

## Path 2: Forward HTTPS Proxy (Codex subscription)

Tools behind Cloudflare that reject reverse proxies.

```
codex ──https_proxy──> mitmproxy :8080 ──MITM TLS──> chatgpt.com
                            │
                      mitm_addon.py
                            │
                            ▼
                    Context Lens :4041/api/ingest
                            │
                            ▼
                      Web UI :4041
```

Codex with a subscription authenticates via OAuth against `chatgpt.com`, which sits
behind Cloudflare. A reverse proxy gets 403'd because Cloudflare checks TLS
fingerprints. Instead, we use mitmproxy as a forward HTTPS proxy:

1. codex connects to chatgpt.com normally (preserving its TLS fingerprint to Cloudflare)
2. But routes through mitmproxy via the `https_proxy` env var
3. mitmproxy MITMs the TLS connection (codex trusts its CA via `SSL_CERT_FILE`)
4. A Python addon (`mitm_addon.py`) captures the request body
5. The addon POSTs the captured data to Context Lens's ingest API

## Components

| File | Role |
|------|------|
| `server.js` | HTTP reverse proxy (:4040) + web UI (:4041) + ingest API |
| `cli.js` | CLI wrapper — spawns proxy, mitmproxy (if needed), and the target tool |
| `mitm_addon.py` | mitmproxy addon — captures HTTPS traffic and feeds it to Context Lens |

## Request parsing

Three API formats are supported:

| Format | Provider | System prompt field | Messages field |
|--------|----------|-------------------|----------------|
| Anthropic Messages | `anthropic` | `system` | `messages` |
| OpenAI Responses | `openai` | `instructions` | `input` |
| OpenAI Chat Completions | `openai` | `role: "system"` | `messages` |
| ChatGPT Backend | `chatgpt` | best-effort | best-effort |

The ChatGPT backend format (used by codex subscription) is parsed best-effort since
it's a proprietary, undocumented protocol.

## Source tagging

When using the CLI wrapper, requests are tagged by source tool (e.g., "claude", "codex")
so the web UI can show which tool generated each request.

- **Reverse proxy path:** The base URL includes a path prefix (e.g., `http://localhost:4040/claude/v1/messages`).
  `extractSource()` strips the prefix before routing and uses it as the source tag.
- **mitmproxy path:** The addon explicitly sets the source field when posting to the ingest API.
