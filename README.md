# Context Lens

![Early Development](https://img.shields.io/badge/status-early%20development-orange)
[![CI](https://github.com/larsderidder/context-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/larsderidder/context-lens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/context-lens)](https://www.npmjs.com/package/context-lens)

Context window visualizer for LLM coding tools. Sits between your tool and the API as a proxy, captures every request, and gives you a web UI to explore what's actually in the context window: composition treemaps, turn-by-turn diffs, cost tracking, and automatic findings.

Zero dependencies. Works with Claude Code, Codex, Gemini CLI, Aider, Kimi, Pi, and anything else that talks to OpenAI/Anthropic/Google APIs.

![Context Lens UI](screenshot-overview.png)

## Installation

```bash
npm install -g context-lens
```

Or run directly:

```bash
npx context-lens ...
```

## Quick Start

```bash
npx context-lens claude "your prompt"
npx context-lens codex "your prompt"
npx context-lens gemini "your prompt"
npx context-lens aider --model claude-sonnet-4
npx context-lens -- python my_agent.py
```

This starts the proxy (port 4040), opens the web UI (http://localhost:4041), sets the right env vars, and runs your command. Multiple tools can share one proxy; just open more terminals.

## Supported Providers

| Provider | Method | Status | Environment Variable |
| :--- | :--- | :--- | :--- |
| **Anthropic** | Reverse Proxy | ✅ Stable | `ANTHROPIC_BASE_URL` |
| **OpenAI** | Reverse Proxy | ✅ Stable | `OPENAI_BASE_URL` |
| **Google Gemini** | Reverse Proxy | 🧪 Experimental | `GOOGLE_GEMINI_BASE_URL` |
| **ChatGPT (Subscription)** | MITM Proxy | ✅ Stable | `https_proxy` |
| **Aider / Generic** | Reverse Proxy | ✅ Stable | Detects standard patterns |

## What You Get

- **Composition treemap:** visual breakdown of what's filling your context (system prompts, tool definitions, tool results, messages, thinking, images)
- **Cost tracking:** per-turn and per-session cost estimates across models
- **Conversation threading:** groups API calls by session, shows main agent vs subagent turns
- **Agent breakdown:** token usage and cost per agent within a session
- **Timeline:** bar chart of context size over time, filterable by main/all/cost
- **Context diff:** turn-to-turn delta showing what grew, shrank, or appeared
- **Findings:** flags large tool results, unused tool definitions, context overflow risk, compaction events
- **Auto-detection:** recognizes Claude Code, Codex, aider, Pi, and others by source tag or system prompt
- **LHAR export:** download session data as LHAR (LLM HTTP Archive) format ([doc](docs/LHAR.md))
- **State persistence:** data survives restarts; delete individual sessions or reset all from the UI
- **Streaming support:** passes through SSE chunks in real-time

### Screenshots

**Findings**

![Findings panel](findings-screenshot.png)

**Diff view**

![Context diff view](diff.png)

**Drill-down details**

![Drill-down details panel](overview-sidebar.png)

## Manual Mode

```bash
npm start
# Port 4040 = proxy, port 4041 = web UI

ANTHROPIC_BASE_URL=http://localhost:4040 claude "your prompt"
OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"
GOOGLE_GEMINI_BASE_URL=http://localhost:4040 gemini "your prompt"  # experimental
```

### Source Tagging

Add a path prefix to tag requests by tool:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040/claude claude "prompt"
OPENAI_BASE_URL=http://localhost:4040/aider aider "prompt"
```

### Pi Coding Agent

Pi ignores standard base-URL environment variables, so the CLI wrapper can't redirect it automatically. Instead, configure Pi to point at the proxy via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "http://localhost:4040/pi" },
    "openai": { "baseUrl": "http://localhost:4040/pi" },
    "google-gemini-cli": { "baseUrl": "http://localhost:4040/pi" },
    "google-antigravity": { "baseUrl": "http://localhost:4040/pi" }
  }
}
```

Start the proxy (`npm start`), then run Pi normally. No CLI wrapper needed. The config hot-reloads when you switch models via `/model`, but adding new provider overrides requires restarting Pi.

Tested with: Claude Opus 4.6, Gemini 2.5 Flash (via Gemini CLI subscription), GPT-OSS 120B (via Antigravity). The `openai-codex` provider (ChatGPT subscription) has the same Cloudflare limitation as Codex and is not supported through the reverse proxy.

### Codex Subscription Mode

Codex with a ChatGPT subscription needs mitmproxy for HTTPS interception (Cloudflare blocks reverse proxies). The CLI handles this automatically. Just make sure `mitmdump` is installed:

```bash
pipx install mitmproxy
npx context-lens codex "your prompt"
```

## How It Works

Context Lens sits between your coding tool and the LLM API, capturing requests in transit.

**Reverse proxy (Claude Code, aider, OpenAI API tools)**

```
Tool  ─HTTP─▶  Context Lens (:4040)  ─HTTPS─▶  api.anthropic.com / api.openai.com
                      │
                      ▼
                 Web UI (:4041)
```

The CLI sets env vars like `ANTHROPIC_BASE_URL=http://localhost:4040` so the tool sends requests to the proxy instead of the real API. The proxy buffers each request body, parses the JSON to extract context structure (system prompts, tools, messages), forwards the raw bytes upstream with all original headers intact, then captures the response on the way back. The tool never knows it's being proxied.

**Forward HTTPS proxy (Codex subscription mode)**

Some tools can't be reverse-proxied. Codex with a ChatGPT subscription authenticates against `chatgpt.com`, which is behind Cloudflare. A reverse proxy changes the TLS fingerprint, causing Cloudflare to reject the request with a 403. For these tools, Context Lens uses mitmproxy as a forward HTTPS proxy instead:

```
Tool  ─HTTPS via proxy─▶  mitmproxy (:8080)  ─HTTPS─▶  chatgpt.com
                                  │
                            mitm_addon.py
                                  │
                                  ▼
                          Web UI /api/ingest
```

The tool makes its own TLS connection through the proxy, preserving its native TLS fingerprint. The mitmproxy addon intercepts completed request/response pairs and posts them to Context Lens's ingest API. The tool needs `https_proxy` and `SSL_CERT_FILE` env vars set to route through mitmproxy and trust its CA certificate.

**What the proxy captures**

Each request is parsed to extract: model name, system prompts, tool definitions, message history (with per-message token estimates), and content block types (text, tool calls, tool results, images, thinking). The response is captured to extract usage stats and cost. Requests are grouped into conversations using session IDs (Anthropic `metadata.user_id`), response chaining (OpenAI `previous_response_id`), or a fingerprint of the system prompt + first user message.

## Data

Captured requests are kept in memory (last 100) and persisted to `data/state.jsonl` across restarts. Each session is also logged as a separate `.lhar` file in `data/`. Use the Reset button in the UI to clear everything.

## License

MIT
