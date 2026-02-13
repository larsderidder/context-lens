# Contributing

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm dev` starts the TypeScript compiler in watch mode.

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
pnpm test              # build + run all tests (node:test)
pnpm build:test        # build tests only
```

For manual testing, `pnpm start` launches the proxy and web UI, then point your tool at `http://localhost:4040`.

## Releasing

Publishing to npm is automated via GitHub Actions using [npm trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers). No tokens or secrets are needed.

1. Bump the version in `package.json`
2. Commit and push to `main`
3. Create and publish a GitHub release:

```bash
gh release create v0.X.0 --title "v0.X.0" --target main --latest --notes "release notes here"
gh release edit v0.X.0 --draft=false --latest
```

The `publish.yml` workflow will build, lint, test, and publish to npm automatically.

### How trusted publishing works

The workflow uses GitHub Actions OIDC to authenticate with npm directly. No `NPM_TOKEN` secret is involved. The trust relationship is configured in two places:

- **npm**: package settings > Trusted Publisher, linked to `larsderidder/context-lens`, workflow `publish.yml`, environment `npm`
- **GitHub**: an environment called `npm` exists under repo Settings > Environments

If either side is misconfigured, the publish step will fail with `ENEEDAUTH` or an OIDC token exchange error.
