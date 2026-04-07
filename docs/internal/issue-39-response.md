Both issues fixed on `main` (releasing shortly as 0.7.1).

What was happening: `context-lens pi` had a hardcoded list of provider keys it would rewrite through the proxy (`anthropic`, `openai`, `google-gemini-cli`, etc.), and `opencode` wasn't on it, so its traffic bypassed entirely. When you manually pointed `opencode`'s `baseUrl` at the proxy, it received the request but forwarded to `api.openai.com` instead of `opencode.ai/zen/v1`; the proxy treats all OpenAI-format traffic as going to OpenAI, which is normally correct but not here.

Fix: instead of the hardcoded list, `context-lens pi` now rewrites every provider with an external `baseUrl`. For providers the proxy doesn't natively understand (like `opencode`), it injects `x-target-url` into the provider's headers so the proxy knows where to actually send it. No manual `models.json` editing needed, and any other non-standard providers you have configured should just work too.
