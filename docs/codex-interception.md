# Intercepting Codex (Subscription Mode)

This documents the journey of getting Context Lens to work with OpenAI's Codex CLI
when using a ChatGPT/Codex subscription (not an API key).

## The problem

Codex CLI has two completely separate code paths for authentication:

- **API key mode:** Uses `OPENAI_BASE_URL` (default `https://api.openai.com/v1`)
  with a standard `Authorization: Bearer sk-...` header
- **Subscription mode:** Uses an OAuth token against `https://chatgpt.com/backend-api/codex`
  with Cloudflare protection

These paths are mutually exclusive. Setting `OPENAI_BASE_URL` forces codex into
API key mode, even if you're authenticated via subscription.

## What we tried (and why it failed)

### Attempt 1: `OPENAI_BASE_URL=http://localhost:4040`

**Result:** 401 Unauthorized — "Missing scopes: api.responses.write"

Setting `OPENAI_BASE_URL` switches codex to the API key code path. The subscription
OAuth token gets sent to `api.openai.com/v1/responses`, which rejects it because
the token doesn't carry API scopes.

### Attempt 2: `UPSTREAM_OPENAI_URL=https://chatgpt.com/backend-api/codex`

**Result:** 400 Bad Request

Even if we forward to the right upstream, the request format is wrong. `OPENAI_BASE_URL`
makes codex send standard OpenAI API format, which the chatgpt.com backend doesn't
understand.

### Attempt 3: `-c chatgpt_base_url="http://localhost:4040"`

Found by binary analysis (`strings` on the codex binary). This config key controls
where the subscription code path sends requests, without switching to API key mode.

**Result:** Requests reached the proxy but were routed to the wrong upstream.
After fixing routing: requests hit chatgpt.com but returned nothing to Context Lens.

The real problem was deeper: codex sends to `/backend-api/wham/usage` first (a GET
quota check), and only then to `/backend-api/codex/responses` (the actual API call).
The reverse proxy approach was mangling these paths.

### Attempt 4: mitmproxy as reverse proxy

```
mitmdump --mode reverse:https://chatgpt.com --listen-port 9090
```

**Result:** 403 Forbidden (10.6k Cloudflare challenge page)

Cloudflare detects TLS fingerprint mismatches. When mitmproxy connects to chatgpt.com,
its TLS handshake looks different from codex's, so Cloudflare blocks it.

### Attempt 5: mitmproxy as forward HTTPS proxy (the one that worked)

```
https_proxy=http://localhost:8080 SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem codex "prompt"
```

**Result:** 200 OK. Full context captured.

In forward proxy mode:
1. Codex connects to chatgpt.com directly (its own TLS fingerprint)
2. The connection routes through mitmproxy via `https_proxy`
3. mitmproxy MITMs the TLS (codex trusts the CA via `SSL_CERT_FILE`)
4. Cloudflare sees codex's normal-looking TLS handshake and lets it through

This works because `reqwest` (the Rust HTTP client codex uses) respects standard
proxy env vars (`https_proxy`) and custom CA certificates (`SSL_CERT_FILE`).

## What codex actually sends

Discovered via mitmproxy traffic capture:

```
GET  /backend-api/wham/usage           <- quota check (1.0k response)
POST /backend-api/codex/responses      <- actual API call (64-69k response)
```

The POST body uses a format similar to OpenAI's Responses API (`instructions`, `input`,
`tools`) but served through chatgpt.com's proprietary backend.

## Key binary analysis findings

Using `strings` on the compiled Rust binary at
`~/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex`:

- `chatgpt_base_url` — config key for subscription endpoint (default: `https://chatgpt.com`)
- `startup: base_url=` — debug logging
- `OPENAI_BASE_URL` — API key mode base URL
- `reqwest` proxy support — standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env vars
- `SSL_CERT_FILE` — custom CA certificate path
- `responses-api-proxy` — built-in proxy component (unused in our approach)

## Final architecture

```
codex ──https_proxy──> mitmproxy :8080 ──> chatgpt.com
                            │
                      mitm_addon.py ──POST──> Context Lens :4041/api/ingest
```

The CLI wrapper (`npx context-lens codex "prompt"`) automates all of this:
spawning mitmproxy, setting env vars, managing lifecycle.
