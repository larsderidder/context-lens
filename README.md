# 🔍 Context Lens

A zero-config HTTP proxy that intercepts LLM API calls and visualizes what's in the context window.

## What Is This?

Ever wondered what's actually being sent to Claude or GPT? Context Lens sits between your app and the LLM API, captures every request, and shows you:

- **Token breakdown** - System prompts, tools, and messages
- **Context usage** - Percentage of the model's context window used
- **Visual timeline** - All captured requests with expandable details
- **Provider-agnostic** - Works with Anthropic, OpenAI, and others

Perfect for debugging context bloat, optimizing prompts, or just understanding what your LLM sees.

## Features

- ✅ Zero configuration required
- ✅ No external dependencies (pure Node.js)
- ✅ Auto-detects Anthropic vs OpenAI format
- ✅ Handles streaming responses correctly
- ✅ Real-time web UI with auto-refresh
- ✅ Stores last 100 requests in memory
- ✅ Token estimation (simple char/4 heuristic)
- ✅ **CLI wrapper** - Automatically starts proxy, sets env vars, and opens browser
- ✅ **Multi-client support** - Multiple tools can share one proxy instance

## Quick Start

### CLI Wrapper (Recommended)

The easiest way to use Context Lens is with the CLI wrapper, which automatically:
1. Starts the proxy server (port 4040) and web UI (port 4041)
2. Opens the web UI in your browser
3. Sets the correct environment variables for your tool
4. Runs your command with full interactivity
5. Cleans up when you're done

```bash
# Run any LLM tool through Context Lens
npx context-lens claude "What is the capital of France?"
npx context-lens codex "refactor the auth module"
npx context-lens aider --help

# Or wrap any command with --
npx context-lens -- python my_agent.py
```

The web UI will open automatically at http://localhost:4041 so you can watch requests in real-time.

**Multi-client support:** You can run multiple `context-lens` commands simultaneously in different terminals! The first one starts the proxy, subsequent ones attach to it. Each tool's requests are tagged with its name in the UI. See [MULTI-CLIENT.md](MULTI-CLIENT.md) for details.

### Manual Mode

If you prefer to run the proxy separately:

```bash
# Start the proxy
node server.js
```

This starts two servers:
- **Port 4040** - Proxy server (point your API calls here)
- **Port 4041** - Web UI (open in browser to view captured requests)

Then set environment variables manually:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040 claude "your prompt"
OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"
```

## Usage Examples

### With CLI Wrapper (Easiest)

```bash
# Claude CLI
npx context-lens claude "What is the capital of France?"

# OpenAI Codex
npx context-lens codex "Write a function to validate email addresses"

# Aider (gets both Anthropic and OpenAI env vars)
npx context-lens aider --model claude-sonnet-4

# Any Python script
npx context-lens -- python my_llm_agent.py

# Any command (use -- to separate)
npx context-lens -- node my_chatbot.js
```

The wrapper automatically:
- Starts the proxy and web UI
- Sets `ANTHROPIC_BASE_URL` and/or `OPENAI_BASE_URL` based on the tool
- Opens http://localhost:4041 in your browser
- Passes through all stdin/stdout/stderr (fully interactive)
- Cleans up when your command exits

### Manual API Calls (Advanced)

If you're running the proxy separately (`node server.js`), you can make direct API calls:

#### Anthropic (Claude)

```bash
curl http://localhost:4040/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "x-target-url: https://api.anthropic.com" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

#### OpenAI (GPT)

```bash
curl http://localhost:4040/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "x-target-url: https://api.openai.com" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

#### With Tools/Functions

```bash
curl http://localhost:4040/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "x-target-url: https://api.anthropic.com" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "Get the current weather in a location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          }
        }
      }
    ],
    "messages": [
      {"role": "user", "content": "What is the weather in Paris?"}
    ]
  }'
```

## How It Works

1. **Intercept** - Your app sends requests to localhost:4040 instead of the real API
2. **Analyze** - Context Lens parses the request to extract system prompts, tools, and messages
3. **Forward** - The request is forwarded to the real API (specified in `x-target-url`)
4. **Capture** - The response is captured and stored in memory
5. **Display** - Open localhost:4041 in your browser to see the visualization

## Headers

- `x-target-url` - (optional) Target API URL. If omitted, auto-detected from path:
  - `/v1/messages` → `https://api.anthropic.com`
  - `/v1/chat/completions` → `https://api.openai.com`
- `x-api-key` or `Authorization` - Your actual API key (passed through to target)

## Web UI

Open http://localhost:4041 to see:

- **Timeline view** - All captured requests (newest first)
- **Provider badges** - Anthropic, OpenAI, or Unknown
- **Context bar** - Visual breakdown of token usage by type
- **Usage percentage** - How much of the context window is used
- **Expandable details** - Click any request to see full message list

The UI auto-refreshes every 2 seconds.

## Token Estimation

Uses a simple heuristic: `characters / 4 ≈ tokens`

This is not exact (real tokenizers are model-specific), but good enough for a PoC. For production, integrate tiktoken or similar.

## Streaming Responses

Context Lens correctly handles streaming responses (SSE). It passes chunks through in real-time while capturing the full response for analysis.

## Limitations

- **In-memory only** - Restart clears all data (stores last 100 requests)
- **No persistence** - No database, no logs to disk
- **Simple token counting** - Char/4 heuristic, not actual tokenizer
- **No authentication** - Don't expose ports publicly
- **Local only** - Designed for development, not production

## Use Cases

- Debug why your context is hitting limits
- Optimize system prompts and tool definitions
- Visualize what an LLM actually sees
- Compare context usage across providers
- Learn how different frameworks structure requests

## Architecture

Single Node.js file, zero dependencies:
- `http` module for servers
- `https` module for API forwarding
- Inline HTML/CSS/JS for web UI
- In-memory array for storage

## License

MIT - Do whatever you want with it.

---

Built by a robot (OpenClaw agent) for Lars. Ship ugly, ship fast. 🚀
