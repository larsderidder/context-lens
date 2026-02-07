# Multi-Client Support

## Overview

Context Lens now supports multiple simultaneous clients sharing a single proxy instance. This allows you to:
- Run multiple LLM tools at the same time
- Compare context usage across different tools
- See all requests in one unified dashboard
- Avoid port conflicts and resource waste

## How It Works

### 1. Proxy Detection
When you launch `context-lens`:
1. It checks if port 4040 is already listening (TCP connect test)
2. If the proxy is running → attaches to it
3. If not running → starts a new proxy instance

### 2. Reference Counting
- Uses a lockfile at `/tmp/context-lens.lock`
- Each client increments the counter on start
- Each client decrements on exit
- Last client to exit (count → 0) shuts down the proxy

### 3. Source Tagging
Each client is tagged with its tool name:
- Encoded in the base URL path: `http://localhost:4040/<tool-name>`
- Example: `ANTHROPIC_BASE_URL=http://localhost:4040/claude`
- The proxy extracts the source and displays it in the UI

### 4. Shared Dashboard
All requests from all clients appear in http://localhost:4041 with:
- Provider badge (Anthropic/OpenAI)
- **Source badge** (tool name - `claude`, `codex`, etc.)
- Model name
- Context usage stats

## Usage Examples

### Terminal 1: Start Claude
```bash
npx context-lens claude "Explain quantum computing"
# Output: 🔍 Starting Context Lens proxy and web UI...
# Opens browser at localhost:4041
```

### Terminal 2: Attach Codex (while Claude is running)
```bash
npx context-lens codex "refactor this code"
# Output: 🔍 Context Lens proxy already running, attaching to it...
```

### Terminal 3: Attach Aider (while both are running)
```bash
npx context-lens aider --model claude-sonnet-4
# Output: 🔍 Context Lens proxy already running, attaching to it...
```

Now the web UI shows requests from all three tools, each tagged with its source!

### Exit Behavior

**Terminal 2 exits first:**
```
👋 Detaching (2 other client(s) still active)
```

**Terminal 3 exits second:**
```
👋 Detaching (1 other client(s) still active)
```

**Terminal 1 exits last:**
```
🧹 Last client exiting, shutting down Context Lens proxy...
```

## Web UI Display

Each request card shows:
```
[anthropic] [claude] claude-sonnet-4-20250514  12:45:32 PM
[openai]    [codex]  gpt-4o                    12:46:15 PM
[anthropic] [aider]  claude-sonnet-4-20250514  12:47:03 PM
```

The source badge (e.g., `[claude]`) is color-coded blue and appears between the provider and model name.

## Technical Details

### URL Path Structure
Client sets: `ANTHROPIC_BASE_URL=http://localhost:4040/claude`

When the SDK makes a request:
- Request: `GET http://localhost:4040/claude/v1/messages`
- Proxy extracts: `source="claude"`, `cleanPath="/v1/messages"`
- Forwards to: `https://api.anthropic.com/v1/messages`
- Stores: `{ source: "claude", contextInfo: {...}, ... }`

### Lockfile Format
Simple integer counter:
```
/tmp/context-lens.lock
---
3
```
This means 3 clients are currently attached.

### Port Check Implementation
```javascript
function isProxyRunning() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: 4040, host: 'localhost' }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}
```

### Reference Count Operations
```javascript
incrementRefCount()  // Atomically add 1, return new count
decrementRefCount()  // Atomically sub 1, return new count
                     // Auto-deletes lockfile when count reaches 0
```

## Edge Cases Handled

✅ **Port already in use by non-Context-Lens process**
- First client fails to start server, detects port is taken
- User sees error, can investigate

✅ **Proxy crashes while clients are running**
- Clients continue working (they don't check continuously)
- Next client to start will detect proxy is down and restart it

✅ **Lockfile manually deleted**
- Worst case: multiple clients shut down proxy
- Last one wins, proxy stops
- No data corruption, just suboptimal cleanup

✅ **Client crashes without cleanup**
- Lockfile counter stays incremented
- Proxy keeps running (harmless)
- Manual cleanup: `rm /tmp/context-lens.lock && pkill -f context-lens`

## Comparison to Single-Client Mode

| Aspect | Single-Client | Multi-Client |
|--------|---------------|--------------|
| Browser opens | Every launch | Only first launch |
| Proxy starts | Every launch | Only first launch |
| Exit speed | Immediate | Immediate (no wait) |
| Source tracking | N/A | ✅ Per-tool tagging |
| Resource usage | N × (proxy + UI) | 1 × (proxy + UI) |

## Testing

Verify multi-client works:
```bash
# Terminal 1
npx context-lens -- sleep 10

# Terminal 2 (while sleep is running)
npx context-lens -- echo "hello"

# Expected: Terminal 2 shows "attaching" and "1 other client(s) still active"
```

Verify source tagging:
```bash
# Start proxy
npx context-lens my-tool -- sleep 30

# In another terminal, make a test request
curl http://localhost:4040/test-source/v1/models -H "Authorization: Bearer test"

# Check the UI at localhost:4041
# You should see [test-source] badge in the request card
```

## Future Enhancements

- [ ] WebSocket push for real-time UI updates (instead of 2s polling)
- [ ] Filter requests by source in the UI
- [ ] Color-code source badges by tool type
- [ ] Show active clients count in UI header
- [ ] Persist captured requests to disk (SQLite?)
- [ ] CLI flag to force new proxy instance (`--isolated`)
