You've nailed the problem. SigV4 signing includes the endpoint URL, so routing through a reverse proxy at a different address breaks the signature before it ever reaches AWS.

The path that would actually work is the same approach we use for Codex: mitmproxy as a forward HTTPS proxy, intercepting after the AWS SDK has already signed the request. The addon would need to handle the Bedrock wire format, which is different from the standard Anthropic messages API.

A PR along those lines would be welcome. It would need three things: a mitmproxy addon (similar to `mitm_addon.py`) that captures and translates Bedrock traffic; parser support in `src/core/parse.ts` for the Bedrock format; and CLI integration to start mitmproxy with the right filters for a `bedrock` tool config. Happy to talk through the approach if you want to take it on.
