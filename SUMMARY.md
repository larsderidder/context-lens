# Context Lens - Build Summary

## ✅ What Was Built

A fully functional PoC for visualizing LLM context windows via HTTP proxy interception.

### Files Created

1. **server.js** (17KB) - Single-file Node.js server
   - Proxy server on port 4040
   - Web UI server on port 4041
   - Zero external dependencies
   - Handles both Anthropic and OpenAI formats
   - Streaming response support
   - In-memory storage (last 100 requests)

2. **README.md** (5KB) - Complete documentation
   - Quick start guide
   - Usage examples for both providers
   - Architecture explanation
   - Limitations and use cases

3. **package.json** - NPM metadata

4. **test-demo.sh** - Demo script for testing

5. **.gitignore** - Git ignore rules

## ✅ Verified Working

All core functionality tested and confirmed:
- ✅ Both servers start correctly
- ✅ Web UI serves HTML interface
- ✅ API endpoint returns JSON
- ✅ Proxy intercepts and parses requests
- ✅ Requests captured and stored
- ✅ Token estimation working
- ✅ Provider auto-detection working

## 🎯 Key Features Delivered

### Proxy (port 4040)
- Accepts LLM API requests
- Auto-detects Anthropic vs OpenAI format
- Parses system prompts, tools, and messages
- Estimates tokens (char/4 heuristic)
- Forwards to real API
- Handles streaming responses
- Stores request/response pairs

### Web UI (port 4041)
- Dark theme interface
- Timeline view (newest first)
- Provider badges (Anthropic/OpenAI/Unknown)
- Visual bar chart of context composition
- Usage percentage with color coding
- Expandable details per request
- Auto-refresh every 2 seconds
- Shows token counts for all components

## 📊 Architecture

- **Pure Node.js** - No external dependencies
- **Single process** - Both servers in one file
- **In-memory storage** - No database needed
- **Inline UI** - HTML/CSS/JS embedded in server
- **~500 LOC total** - Minimal, focused code

## 🚀 Usage

```bash
# Start it
node server.js

# Use it
curl http://localhost:4040/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "x-target-url: https://api.anthropic.com" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[...]}'

# View it
open http://localhost:4041
```

## 🎨 Design Decisions

1. **Zero config** - Just works out of the box
2. **Provider-agnostic** - Same UI for all LLMs
3. **Minimal deps** - Easy to audit and deploy
4. **Streaming support** - Real-world API compatibility
5. **Simple tokens** - Good enough for PoC
6. **In-memory** - Fast, no persistence overhead
7. **Ugly but functional** - Ship fast, iterate later

## ✨ Bonus Features Added

- Color-coded context bar (system/tools/messages)
- Usage percentage with thresholds (high/critical)
- Expandable message details
- Timestamp display
- Content truncation with ellipsis
- Responsive layout
- Empty state messaging

## 📝 Next Steps (if productionizing)

- [ ] Add real tokenizer (tiktoken)
- [ ] Persistent storage (SQLite/JSON files)
- [ ] Request filtering and search
- [ ] Export captured requests
- [ ] Authentication/access control
- [ ] Multi-user support
- [ ] Request replay functionality
- [ ] Diff view between requests
- [ ] Custom model context limits
- [ ] Performance metrics

## 🏁 Status

**COMPLETE** - All requirements met, tested, and documented.

Ready to use. Point your LLM traffic at it and watch the context unfold.

---

Built in one session by OpenClaw agent "smith" for Lars.
Shipped ugly. Shipped fast. Shipped working. 🚀
