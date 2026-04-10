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

### Startup performance

The analysis server loads the full state from `state.jsonl` on startup. With thousands of entries this file can grow to tens of megabytes, so keep `loadState()` fast. Measure with real data after any changes to the Store or its migrations:

```bash
pnpm build && node -e "
const { Store } = require('./dist/server/store.js');
const path = require('path');
const dataDir = path.resolve('data');   // or wherever your state.jsonl lives
const store = new Store({
  dataDir,
  stateFile: path.join(dataDir, 'state.jsonl'),
  maxSessions: 100,
  maxCompactMessages: 60,
});
const t0 = performance.now();
store.loadState();
console.log((performance.now() - t0).toFixed(0) + 'ms');
"
```

Target: under 1 second for ~3000 entries. Watch out for:

- **Disk I/O in migrations.** Reading detail files (details/*.json) is expensive. Gate file reads behind cheap in-memory checks and use marker files to skip completed migrations.
- **O(n^2) loops.** Migrations that filter all entries per entry (e.g. finding prior conversation entries) add up fast.
- **Full state rewrites.** `saveState()` rewrites the entire file. New entries use `appendToState()` instead. Only call `saveState()` after structural changes (eviction, deletion, migrations).

## Releasing

Publishing to npm is automated via GitHub Actions using [npm trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers). No tokens or secrets are needed.

### Normal release

1. Bump the version in `package.json`
2. Commit and push to `main`
3. Run:

```bash
pnpm release -- --notes "release notes here"
```

This script checks that:
- you are on `main`
- the working tree is clean
- `HEAD` matches `origin/main`
- the git tag and GitHub release do not already exist

It then creates the annotated tag, pushes it, and creates the GitHub release. That triggers `publish.yml`, which builds, lints, tests, and publishes to npm automatically.

### Dependency release check

`context-lens` depends on separately published `@contextio/*` packages, even though local development often uses the shared workspace. That means local changes in `../contextio` can make `context-lens` appear healthy before those packages are actually published.

Before releasing `context-lens`, check whether the release depends on unpublished `contextio` changes:

```bash
npm view @contextio/core version
npm view @contextio/proxy version
npm view @contextio/redact version
```

If `context-lens` now imports or relies on new `@contextio/*` APIs:
- publish the needed `contextio` packages first
- update `context-lens` to the published versions
- verify the lockfile matches the intended published versions
- only then release `context-lens`

Do not trust local workspace resolution alone for this check.

### If a release already exists and needs to be re-run

If the tag or release points at the wrong commit, recreate it from current `main`:

```bash
pnpm release -- --recreate --notes "release notes here"
```

That will delete the existing GitHub release, delete the remote and local tag, recreate the tag on current `HEAD`, and publish a fresh GitHub release.

### Watch the publish workflow

```bash
gh run list --workflow publish.yml --limit 5
gh run watch <run-id> --exit-status
```

### How trusted publishing works

The workflow uses GitHub Actions OIDC to authenticate with npm directly. No `NPM_TOKEN` secret is involved. The trust relationship is configured in two places:

- **npm**: package settings > Trusted Publisher, linked to `larsderidder/context-lens`, workflow `publish.yml`, environment `npm`
- **GitHub**: an environment called `npm` exists under repo Settings > Environments

If either side is misconfigured, the publish step will fail with `ENEEDAUTH` or an OIDC token exchange error.
