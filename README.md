# Context Lens

![Beta](https://img.shields.io/badge/status-beta-blue)
[![CI](https://github.com/larsderidder/context-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/larsderidder/context-lens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/context-lens)](https://www.npmjs.com/package/context-lens)

See what's actually filling your context window. Context Lens is a local proxy that captures LLM API calls from your coding tools and shows you a composition breakdown: what percentage is system prompts, tool definitions, conversation history, tool results, thinking blocks. It answers the question every developer asks: "why is this session so expensive?"

Works with Claude Code, Codex, Gemini CLI, Aider, Pi, and anything else that talks to OpenAI/Anthropic/Google APIs. No code changes needed.

![Context Lens UI](screenshot-overview.png)

## Installation

```bash
pnpm add -g context-lens
```

Or with npm:

```bash
npm install -g context-lens
```

Or run directly:

```bash
npx context-lens ...
```

## Quick Start

```bash
context-lens claude
context-lens codex
context-lens gemini
context-lens gm               # alias for gemini
context-lens aider --model claude-sonnet-4
context-lens pi
context-lens -- python my_agent.py
```

Or without installing: replace `context-lens` with `npx context-lens`.

This starts the proxy (port 4040), opens the web UI (http://localhost:4041), sets the right env vars, and runs your command. Multiple tools can share one proxy; just open more terminals.

## CLI options

```bash
context-lens --help
context-lens --version
context-lens --privacy=minimal claude
context-lens --no-open codex
context-lens --no-ui -- claude
context-lens doctor
context-lens background start --no-ui
context-lens background status
context-lens background stop
```

- `--help`, `--version`: show usage/version and exit
- `--privacy <minimal|standard|full>`: controls privacy mode passed to the analysis server
- `--no-open`: do not auto-open `http://localhost:4041` when launching a command
- `--no-ui`: run proxy only (no analysis/web UI server) for capture-only data gathering
- `--no-update-check`: skip npm update check for this run

`--no-ui` is not compatible with `codex` subscription mode (`mitmproxy` ingestion depends on `http://localhost:4041/api/ingest`).

Built-in commands:
- `doctor`: run local diagnostics (ports, mitmproxy availability, cert path, writable dirs, background state)
- `background start [--no-ui]`: start detached proxy (and analysis/web UI unless `--no-ui`)
- `background status`: show detached process state
- `background stop`: stop detached process state

Aliases:
- `cc` -> `claude`
- `cpi` -> `pi`
- `cx` -> `codex`
- `gm` -> `gemini`

By default, the CLI does a cached (once per day) non-blocking check for new npm versions and prints an upgrade hint when a newer release is available. Disable globally with `CONTEXT_LENS_NO_UPDATE_CHECK=1`.

## Docker

A pre-built image is published to GitHub Container Registry on every release:

```bash
docker run -d \
  -p 4040:4040 \
  -p 4041:4041 \
  -e CONTEXT_LENS_BIND_HOST=0.0.0.0 \
  -v ~/.context-lens:/root/.context-lens \
  ghcr.io/larsderidder/context-lens:latest
```

Or with Docker Compose (uses `~/.context-lens` on the host, so data is shared with any local install):

```bash
docker compose up -d
```

Then open http://localhost:4041 and point your tools at the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040/claude claude
OPENAI_BASE_URL=http://localhost:4040 codex
```

### Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CONTEXT_LENS_BIND_HOST` | `127.0.0.1` | Set to `0.0.0.0` to accept connections from outside the container |
| `CONTEXT_LENS_INGEST_URL` | _(file-based)_ | POST captures to a remote URL instead of writing to disk |
| `CONTEXT_LENS_PRIVACY` | `standard` | Privacy level: `minimal`, `standard`, or `full` |
| `CONTEXT_LENS_NO_UPDATE_CHECK` | `0` | Set to `1` to skip the npm update check |

### Split-container setup

If you want to run the proxy and the analysis server as separate containers (no shared filesystem needed), set `CONTEXT_LENS_INGEST_URL` so the proxy POSTs captures directly to the analysis server over the Docker network:

```yaml
services:
  proxy:
    image: ghcr.io/larsderidder/context-lens:latest
    command: ["node", "dist/proxy/server.js"]
    ports:
      - "4040:4040"
    environment:
      CONTEXT_LENS_BIND_HOST: "0.0.0.0"
      CONTEXT_LENS_INGEST_URL: "http://analysis:4041/api/ingest"

  analysis:
    image: ghcr.io/larsderidder/context-lens:latest
    command: ["node", "dist/analysis/server.js"]
    ports:
      - "4041:4041"
    environment:
      CONTEXT_LENS_BIND_HOST: "0.0.0.0"
    volumes:
      - ~/.context-lens:/root/.context-lens
```

## Supported Providers

| Provider | Method | Status | Environment Variable |
| :--- | :--- | :--- | :--- |
| **Anthropic** | Reverse Proxy | ✅ Stable | `ANTHROPIC_BASE_URL` |
| **OpenAI** | Reverse Proxy | ✅ Stable | `OPENAI_BASE_URL` |
| **Google Gemini** | Reverse Proxy | 🧪 Experimental | `GOOGLE_GEMINI_BASE_URL` |
| **ChatGPT (Subscription)** | MITM Proxy | ✅ Stable | `https_proxy` |
| **Pi Coding Agent** | Reverse Proxy (temporary per-run config) | ✅ Stable | `PI_CODING_AGENT_DIR` (set by wrapper) |
| **OpenAI-Compatible** | Reverse Proxy | ✅ Stable | `UPSTREAM_OPENAI_URL` + `OPENAI_BASE_URL` |
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

**Sessions list**

![Sessions list](sessions-screenshot.png)

**Messages view with drill-down details**

![Messages view](messages-screenshot.png)

**Timeline view**

![Timeline view](timeline-screenshot.png)

**Findings panel**

![Findings panel](findings-screenshot.png)

## Advanced

Add a path prefix to tag requests by tool in the UI:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040/claude claude
OPENAI_BASE_URL=http://localhost:4040/aider aider
```

### Pi Coding Agent

Pi ignores standard base-URL environment variables. `context-lens pi` works by creating a private per-run temporary Pi config directory under `/tmp/context-lens-pi-agent-*`, symlinking your normal `~/.pi/agent/*` files, and injecting proxy `baseUrl` overrides into its temporary `models.json`.

Your real `~/.pi/agent/models.json` is never modified, and the temporary directory is removed when the command exits.

```bash
context-lens pi
```

Pi config paths:

- Real Pi config dir: `~/.pi/agent`
- Real Pi models file: `~/.pi/agent/models.json` (left untouched)
- Temporary per-run config dir: `/tmp/context-lens-pi-agent-*`
- Runtime override providers in temp `models.json`: `anthropic`, `openai`, `google-gemini-cli`, `google-antigravity`

If you prefer not to use the temporary runtime override, you can also edit your real `~/.pi/agent/models.json` directly and set those providers' `baseUrl` values to `http://localhost:4040/pi`.

Example `~/.pi/agent/models.json`:

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

Tested with: Claude Opus 4.6, Gemini 2.5 Flash (via Gemini CLI subscription), GPT-OSS 120B (via Antigravity). The `openai-codex` provider (ChatGPT subscription) has the same Cloudflare limitation as Codex and is not supported through the reverse proxy.

### OpenAI-Compatible Endpoints

Many providers expose OpenAI-compatible APIs (OpenRouter, Together, Groq, Fireworks, Ollama, vLLM, OpenCode Zen, etc.). Context Lens supports these out of the box since it already parses `/v1/chat/completions` and `/v1/responses` request formats. The model name is extracted from the request body, so token estimates and cost tracking work automatically for known models.

To route traffic through the proxy, override the OpenAI upstream URL to point at your provider:

```bash
UPSTREAM_OPENAI_URL=https://opencode.ai/zen/v1 context-lens -- opencode "prompt"
```

Or in manual/standalone mode:

```bash
UPSTREAM_OPENAI_URL=https://openrouter.ai/api context-lens background start
OPENAI_BASE_URL=http://localhost:4040/my-tool my-tool "prompt"
```

The `UPSTREAM_OPENAI_URL` variable tells the proxy where to forward requests that are classified as OpenAI format. The source tag (`/my-tool/` prefix) is still stripped before forwarding, so the upstream receives clean API paths.

Note: `UPSTREAM_OPENAI_URL` is global. All OpenAI-format requests go to that upstream. If you need to use a custom endpoint and the real OpenAI API simultaneously, use separate proxy instances or the mitmproxy approach below.

### Codex Subscription Mode

Codex with a ChatGPT subscription needs mitmproxy for HTTPS interception (Cloudflare blocks reverse proxies). The CLI handles this automatically. Just make sure `mitmdump` is installed:

```bash
pipx install mitmproxy
context-lens codex
```

If Codex fails with certificate trust errors, install/trust the mitmproxy CA certificate (`~/.mitmproxy/mitmproxy-ca-cert.pem`) for your environment.

## How It Works

Context Lens sits between your coding tool and the LLM API, capturing requests in transit. It has two parts: a **proxy** and an **analysis server**.

```
Tool  ─HTTP─▶  Proxy (:4040)  ─HTTPS─▶  api.anthropic.com / api.openai.com
                    │
              capture files
                    │
            Analysis Server (:4041)  →  Web UI
```

The **proxy** (`src/proxy/`) forwards requests to the LLM API and writes each request/response pair to disk. It has **zero external dependencies** (only Node.js built-ins), so you can read the entire proxy source and verify it does nothing unexpected with your API keys. This is an intentional architectural constraint: your API keys pass through the proxy, so it must stay small, auditable, and free of transitive supply-chain risk.

The **analysis server** picks up those captures, parses request bodies, estimates tokens, groups requests into conversations, computes composition breakdowns, calculates costs, scores context health, and scans for prompt injection patterns. It serves the web UI and API. The two sides communicate only through capture files on disk, so the analysis server, CLI, and web UI are free to use whatever dependencies they need without affecting the proxy's trust boundary.

The CLI sets env vars like `ANTHROPIC_BASE_URL=http://localhost:4040` so the tool sends requests to the proxy instead of the real API. The tool never knows it's being proxied.

**Forward HTTPS proxy (Codex subscription mode)**

Codex with a ChatGPT subscription authenticates against `chatgpt.com`, which is behind Cloudflare. A reverse proxy changes the TLS fingerprint, causing Cloudflare to reject the request. For this case, Context Lens uses mitmproxy as a forward HTTPS proxy:

```
Tool  ─HTTPS via proxy─▶  mitmproxy (:8080)  ─HTTPS─▶  chatgpt.com
                                  │
                            mitm_addon.py
                                  │
                                  ▼
                          Analysis Server /api/ingest
```

The tool makes its own TLS connection through the proxy, preserving its native fingerprint. The mitmproxy addon intercepts completed request/response pairs and posts them to the analysis server's ingest API. The tool needs `https_proxy` and `SSL_CERT_FILE` env vars set to route through mitmproxy and trust its CA certificate.

## Why Context Lens?

Tools like [Langfuse](https://langfuse.com/) and [Braintrust](https://braintrust.dev/) are great for observability when you control the code: you add their SDK, instrument your calls, and get traces in a dashboard. Context Lens solves a different problem.

**You can't instrument tools you don't own.** Claude Code, Codex, Gemini CLI, and Aider are closed-source binaries. You can't add an SDK to them. Context Lens works as a transparent proxy, so it captures everything without touching the tool's code.

**Context composition, not just token counts.** Most observability tools show you input/output token totals. Context Lens breaks down *what's inside* the context window: how much is system prompts vs. tool definitions vs. conversation history vs. tool results vs. thinking blocks. That's what you need to understand why sessions get expensive.

**Local and private.** Everything runs on your machine. No accounts, no cloud, no data leaving your network. Start it, use it, stop it.

| | Context Lens | Langfuse / Braintrust |
|:---|:---|:---|
| **Setup** | `context-lens claude` | Add SDK, configure API keys |
| **Works with closed-source tools** | Yes (proxy) | No (needs instrumentation) |
| **Context composition breakdown** | Yes (treemap, per-category) | Token totals only |
| **Runs locally** | Yes, entirely | Cloud or self-hosted server |
| **Prompt management & evals** | No | Yes |
| **Team/production use** | No (single-user, local) | Yes |

Context Lens is for developers who want to understand and optimize their coding agent sessions. If you need production monitoring, prompt versioning, or team dashboards, use Langfuse.

## Data

Captured requests are kept in memory (last 200 sessions) and persisted to `~/.context-lens/data/state.jsonl` across restarts. Each session is also logged as a separate `.lhar` file in `~/.context-lens/data/`. Use the Reset button in the UI to clear everything.

## License

MIT
