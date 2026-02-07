# Context Lens

See what's actually in your LLM's context window. A zero-dependency HTTP proxy that intercepts API calls and visualizes token usage in real-time.

> **Early Development** — Expect rough edges. Contributions welcome.

## Quick Start

```bash
npx context-lens claude "your prompt"
npx context-lens codex "your prompt"
npx context-lens aider --model claude-sonnet-4
npx context-lens -- python my_agent.py
```

This starts the proxy (port 4040), opens the web UI (http://localhost:4041), sets the right env vars, and runs your command. Multiple tools can share one proxy — just open more terminals.

## What You Get

- **Token breakdown** — system prompts, tools, messages with visual context bar
- **Conversation threading** — groups API calls by session/conversation, shows agents and turns
- **Content formatting** — collapsible system prompts, typed message blocks (text/tool_use/tool_result), per-tool schemas
- **Auto-detection** — recognizes Claude Code, Codex, aider, and others by source tag or system prompt
- **Streaming support** — passes through SSE chunks in real-time

## Manual Mode

```bash
node server.js
# Port 4040 = proxy, port 4041 = web UI

ANTHROPIC_BASE_URL=http://localhost:4040 claude "your prompt"
OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"
```

### Source Tagging

Add a path prefix to tag requests by tool:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040/claude claude "prompt"
OPENAI_BASE_URL=http://localhost:4040/aider aider "prompt"
```

### Codex Subscription Mode

Codex with a ChatGPT subscription needs mitmproxy for HTTPS interception (Cloudflare blocks reverse proxies). The CLI handles this automatically — just make sure `mitmdump` is installed:

```bash
pipx install mitmproxy
npx context-lens codex "your prompt"
```

## Data

All captured requests are logged to `data/requests.jsonl` and kept in memory (last 100). Restart clears the in-memory state; the JSONL log persists.

## License

MIT
