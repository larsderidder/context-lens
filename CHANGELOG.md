# Changelog

## [0.2.0] - 2026-02-07

### Added - CLI Wrapper with Multi-Client Support

#### Major Features
- **CLI Wrapper** (`cli.js`) - Launch any tool through Context Lens with automatic setup
  - Usage: `npx context-lens <tool> [args...]`
  - Automatically starts proxy and web UI
  - Sets environment variables for the tool
  - Opens browser at http://localhost:4041
  - Full TTY/interactivity support

- **Multi-Client Support** - Run multiple tools simultaneously sharing one proxy
  - First client starts the proxy
  - Subsequent clients detect and attach to existing proxy
  - Reference counting via `/tmp/context-lens.lock`
  - Only last client to exit shuts down the proxy
  - Each client shows attachment status and active client count

- **Source Tagging** - Identify which tool made each request
  - Tool name encoded in base URL path: `http://localhost:4040/<tool-name>`
  - Proxy extracts source and stores with each request
  - Web UI displays source badge for each request
  - Example: `[anthropic] [claude] claude-sonnet-4`

#### Technical Changes
- `cli.js` (new):
  - Port detection via TCP connect
  - Reference counting with atomic file operations
  - Smart shutdown logic
  - Signal handling (SIGINT/SIGTERM)
  - Tool-specific environment variable mapping

- `server.js`:
  - Added `extractSource()` function for URL path parsing
  - Updated `storeRequest()` to accept source parameter
  - Modified `handleProxy()` to extract and pass source
  - Enhanced web UI to display source badges
  - Added CSS styling for source tags

- `package.json`:
  - Added `bin` field for `npx` support

#### Documentation
- **README.md** - Updated with CLI-first usage examples
- **CLI-IMPLEMENTATION.md** - Technical implementation details
- **MULTI-CLIENT.md** - Comprehensive multi-client guide
- **CHANGELOG.md** - This file

#### Testing
- ✅ Single client mode
- ✅ Multi-client attach/detach
- ✅ Reference counting accuracy
- ✅ Source tag extraction and display
- ✅ Graceful shutdown
- ✅ Lockfile cleanup
- ✅ Port conflict handling

#### Known Limitations
- Lockfile at `/tmp/` may not work on all systems (e.g., Windows without WSL)
- No IPC - relies on filesystem for coordination
- Manual cleanup needed if clients crash without cleanup
- Browser auto-open uses platform detection (may fail on exotic systems)

#### Example Usage

**Single Tool:**
```bash
npx context-lens claude "Explain quantum computing"
# Starts proxy, opens UI, runs claude
```

**Multiple Tools (different terminals):**
```bash
# Terminal 1
npx context-lens claude "task 1"
# → Starts proxy

# Terminal 2 (while T1 running)
npx context-lens codex "task 2"
# → Attaches to proxy

# Terminal 3 (while T1+T2 running)
npx context-lens -- python agent.py
# → Also attaches

# All requests visible in shared UI with source tags
```

---

## [0.1.0] - 2026-02-07

### Initial Release
- HTTP proxy server (port 4040)
- Web UI dashboard (port 4041)
- Request capture and analysis
- Token estimation (char/4 heuristic)
- Provider detection (Anthropic/OpenAI)
- Context usage visualization
- Streaming response support
- Zero external dependencies
