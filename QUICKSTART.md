# Quick Start Guide

## Installation

```bash
cd /home/lars/xithing/context-lens
npm link  # Makes 'context-lens' available globally
```

Or use directly with `npx`:
```bash
# No installation needed, just run from the project directory
npx context-lens <command>
```

## Basic Usage

### Single Tool
```bash
# Claude CLI
context-lens claude "What is the capital of France?"

# Codex
context-lens codex "Write a hello world function"

# Any command
context-lens -- python my_script.py
context-lens -- node my_bot.js
```

The browser will automatically open at http://localhost:4041 showing the context dashboard.

## Multi-Tool Usage

Open multiple terminals and run different tools simultaneously:

### Terminal 1
```bash
context-lens claude "Explain machine learning"
# → Proxy starts, browser opens
# → Shows: "🔍 Starting Context Lens proxy and web UI..."
```

### Terminal 2 (while Terminal 1 is running)
```bash
context-lens codex "Refactor this code: def foo(): pass"
# → Attaches to existing proxy
# → Shows: "🔍 Context Lens proxy already running, attaching to it..."
```

### Terminal 3 (while 1 & 2 are running)
```bash
context-lens aider --help
# → Also attaches
# → Shows: "🔍 Context Lens proxy already running, attaching to it..."
```

All three tools' requests appear in the same web UI at http://localhost:4041, each tagged with its source (`[claude]`, `[codex]`, `[aider]`).

## What You'll See

### In the Terminal
When you run a wrapped tool, you'll see:

1. **Startup message:**
   - First client: `🔍 Starting Context Lens proxy and web UI...`
   - Additional clients: `🔍 Context Lens proxy already running, attaching to it...`

2. **Server ready messages** (first client only):
   ```
   🔍 Context Lens Proxy running on http://localhost:4040
   🌐 Context Lens Web UI running on http://localhost:4041
   ```

3. **Launch confirmation:**
   ```
   🚀 Launching: <tool-name> <args>
   ```

4. **Your tool's output** (stdin/stdout/stderr all work normally)

5. **Exit message:**
   - Last client: `🧹 Last client exiting, shutting down Context Lens proxy...`
   - Other clients: `👋 Detaching (N other client(s) still active)`

### In the Web UI (http://localhost:4041)

Each request shows:

```
┌─────────────────────────────────────────────────────────────┐
│ [anthropic] [claude] claude-sonnet-4    12:34:56 PM         │
│ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ (context bar)      │
│ System: 1,234 tokens | Tools: 567 | Messages: 890           │
│ 15% of context used (2,691 / 200,000 tokens)                │
│ [Click to expand and see full message details]              │
└─────────────────────────────────────────────────────────────┘
```

## Testing

Run this to verify multi-client support:

```bash
# Terminal 1
context-lens -- sleep 10

# Terminal 2 (while sleep is running)
context-lens -- echo "Multi-client test"
# Should show: "attaching to it..." and "1 other client(s) still active"
```

## Troubleshooting

### Port Already in Use
If you see `EADDRINUSE` errors:
```bash
# Kill any existing proxy
pkill -f "context-lens.*server.js"

# Clean lockfile
rm /tmp/context-lens.lock

# Try again
context-lens claude "test"
```

### Lockfile Stuck
If the proxy keeps running after all clients exit:
```bash
rm /tmp/context-lens.lock
pkill -f "node.*server.js"
```

### Browser Doesn't Open
The web UI is still running! Just open manually:
```
http://localhost:4041
```

### Tool Not Found
Make sure the tool is in your PATH:
```bash
which claude
which codex
# If not found, install them or use full path
context-lens -- /full/path/to/claude "prompt"
```

## Environment Variables Set

The wrapper automatically sets these for your tool:

| Tool    | ANTHROPIC_BASE_URL                  | OPENAI_BASE_URL                     |
|---------|-------------------------------------|-------------------------------------|
| claude  | http://localhost:4040/claude        | _(not set)_                         |
| codex   | _(not set)_                         | http://localhost:4040/codex         |
| aider   | http://localhost:4040/aider         | http://localhost:4040/aider         |
| other   | http://localhost:4040/<tool-name>   | http://localhost:4040/<tool-name>   |

The tool name in the URL is used to tag requests in the UI.

## Advanced: Direct Proxy Usage

If you want to run the proxy separately without the wrapper:

```bash
# Terminal 1 - Start proxy
node server.js

# Terminal 2 - Use it
ANTHROPIC_BASE_URL=http://localhost:4040 claude "test"
OPENAI_BASE_URL=http://localhost:4040 codex "test"
```

But you lose:
- Automatic startup/shutdown
- Browser auto-open
- Multi-client reference counting
- Source tagging (unless you manually use paths like `/claude/v1/messages`)

## Next Steps

- See [MULTI-CLIENT.md](MULTI-CLIENT.md) for deep dive on multi-client support
- See [README.md](README.md) for API details and architecture
- See [CLI-IMPLEMENTATION.md](CLI-IMPLEMENTATION.md) for technical implementation details

## Publishing to npm (Optional)

To make it available globally via `npm install -g context-lens`:

```bash
# Update version
npm version patch  # or minor, major

# Publish
npm publish

# Then anyone can use:
npx context-lens@latest claude "test"
```

## Pro Tips

1. **Keep the UI open** - The web UI updates every 2 seconds, so you can watch requests flow in real-time

2. **Compare tools** - Run claude and codex side-by-side to compare their context usage for the same task

3. **Debug context bloat** - If your app is slow, check if you're sending huge system prompts or tool definitions

4. **Share your screen** - The UI is great for demos - show people what's actually being sent to the LLM

5. **Pipe output** - The wrapper preserves stdin/stdout, so you can pipe:
   ```bash
   echo "Summarize this: $(cat article.txt)" | context-lens claude
   ```
