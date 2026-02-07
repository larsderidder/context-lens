# Why Codex Subscription Interception Is Hard

A short explainer on why intercepting Codex CLI traffic requires mitmproxy while
Claude Code works with a simple env var.

## Claude Code: one env var

```
ANTHROPIC_BASE_URL=http://localhost:4040 claude "prompt"
```

That's it. The Anthropic SDK reads the env var, sends requests to localhost instead
of api.anthropic.com, and the proxy forwards them upstream. No TLS complications
because api.anthropic.com doesn't sit behind aggressive bot protection.

## Codex subscription: three layers of defense

### Layer 1: Dual code paths

Codex has completely separate code for API key users and subscription users.
Setting `OPENAI_BASE_URL` (the standard SDK override) forces it into API key mode.
If you only have a subscription, the token gets rejected: *"Missing scopes: api.responses.write"*.

**Workaround:** Found `chatgpt_base_url` config key via binary analysis.

### Layer 2: Different backend protocol

The subscription endpoint (`chatgpt.com/backend-api/codex/responses`) speaks a
proprietary protocol, not the standard OpenAI API. A reverse proxy that just
changes the base URL and forwards to the wrong upstream gets *400 Bad Request*.

**Workaround:** Route to chatgpt.com instead of api.openai.com.

### Layer 3: Cloudflare TLS fingerprinting

chatgpt.com is behind Cloudflare, which checks TLS handshake fingerprints (JA3/JA4).
A reverse proxy (including mitmproxy in reverse mode) creates its own TLS connection
to chatgpt.com, which has a different fingerprint than codex's native `reqwest`
client. Cloudflare returns *403 Forbidden*.

**Workaround:** Use a forward HTTPS proxy. Codex handles TLS directly with
chatgpt.com (preserving its fingerprint), while mitmproxy sits in the middle via
the `https_proxy` env var and MITMs the connection using a trusted CA cert.

## The resulting complexity

| Aspect | Claude | Codex (subscription) |
|--------|--------|---------------------|
| Interception method | Reverse proxy | Forward HTTPS proxy |
| Dependencies | None | mitmproxy |
| Env vars needed | 1 (`ANTHROPIC_BASE_URL`) | 2 (`https_proxy`, `SSL_CERT_FILE`) |
| TLS handling | None (HTTP to proxy) | MITM with custom CA |
| Cloudflare | Not involved | Must be bypassed |
| Auth type | API key (simple header) | OAuth token (Cloudflare-scoped) |

The CLI wrapper hides all of this behind `context-lens codex "prompt"`, but
the underlying machinery is significantly heavier.
