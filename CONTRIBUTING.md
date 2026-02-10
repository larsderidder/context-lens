# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

`npm run dev` starts the TypeScript compiler in watch mode.

## Architecture

Context Lens has three parts: a **Node.js HTTP proxy** (`src/server.ts`, port 4040) that intercepts LLM API calls, a **web UI** (`src/server/`, port 4041) that visualizes captured data, and a **CLI wrapper** (`src/cli.ts` + `src/cli-utils.ts`) that manages the proxy lifecycle and spawns tools with the right env vars. Core logic — parsing, routing, source detection, token estimation — lives in `src/core/`.

For tools behind Cloudflare (Codex subscription), a **mitmproxy addon** (`mitm_addon.py`) acts as a forward HTTPS proxy and posts captured data to the web UI's `/api/ingest` endpoint.

## Adding a new tool

1. **Provider detection** — If the tool uses a new API format, add a detection rule in `src/core/routing.ts:detectProvider()`. Most tools use Anthropic or OpenAI format and don't need this.

2. **Source detection** — Add an entry to `HEADER_SIGNATURES` or `SOURCE_SIGNATURES` in `src/core/source.ts` so the UI can label requests from your tool.

3. **CLI integration** — If the tool supports a base-URL env var, add a tool config to `src/cli-utils.ts` so `context-lens <tool>` works out of the box.

Add tests in `test/` for any new detection logic.

## Testing

```bash
npm test              # build + run all tests (node:test)
npm run build:test    # build tests only
```

For manual testing, `npm start` launches the proxy and web UI, then point your tool at `http://localhost:4040`.
