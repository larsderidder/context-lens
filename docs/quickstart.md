# Quickstart

## Prerequisites

- Node.js 18+
- For codex subscription interception: `pipx install mitmproxy`

## Install

```bash
cd context-lens
npm link
```

## Usage

### Claude Code

```bash
context-lens claude "your prompt"
```

Uses a simple reverse proxy. No extra dependencies needed.

### Codex (subscription)

```bash
context-lens codex "your prompt"
```

Automatically starts mitmproxy as a forward HTTPS proxy to intercept
Cloudflare-protected traffic. Requires mitmproxy to be installed.

On first run, mitmproxy generates a CA certificate at `~/.mitmproxy/mitmproxy-ca-cert.pem`.

### Codex (API key)

If you have an OpenAI API key with `api.responses.write` scope, codex can go
through the simple reverse proxy. Set `OPENAI_API_KEY` and run:

```bash
OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"
```

### Any tool (generic)

For tools not explicitly configured, Context Lens sets both `ANTHROPIC_BASE_URL`
and `OPENAI_BASE_URL`:

```bash
context-lens my-custom-tool --flag arg
```

### Standalone server

Run the proxy and web UI without wrapping a tool:

```bash
context-lens
# or: node server.js
```

Then manually set env vars on your tool:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040 claude "prompt"
```

## Viewing context

Open http://localhost:4041 in your browser. The UI auto-refreshes every 2 seconds.

Features:
- Conversation grouping (requests with the same system prompt + first user message)
- Token breakdown: system prompts, tools, messages
- Context usage bar (percentage of model's context window)
- Expandable details: full system prompts, tool schemas, message history
- Content block rendering: text, tool_use, tool_result, images
