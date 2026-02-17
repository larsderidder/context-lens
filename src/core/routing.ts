import type {
  ApiFormat,
  ExtractSourceResult,
  ParsedUrl,
  Provider,
  ResolveTargetResult,
  Upstreams,
} from "../types.js";

/**
 * URL path segments that represent API resources rather than "source tool" prefixes.
 *
 * Example: `/v1/messages` should not treat `v1` as a source tag.
 */
export const API_PATH_SEGMENTS = new Set([
  "v1",
  "v1beta",
  "v1beta1",
  "v1alpha",
  "v1internal",
  "responses",
  "chat",
  "models",
  "embeddings",
  "backend-api",
  "api",
]);

/**
 * Infer provider based on request path + headers.
 *
 * This is used for routing (choosing which upstream base URL to use) and parsing.
 */
export function detectProvider(
  pathname: string,
  headers: Record<string, string | undefined>,
): Provider {
  return classifyRequest(pathname, headers).provider;
}

/**
 * Infer the API "format" (schema family) from the request path.
 *
 * This is distinct from provider: e.g. OpenAI can be `responses` or `chat-completions`.
 */
export function detectApiFormat(pathname: string): ApiFormat {
  return classifyRequest(pathname, {}).apiFormat;
}

/**
 * Classify an incoming request into `{ provider, apiFormat }`.
 *
 * Keep all path/format heuristics in one place to avoid drift between
 * routing decisions and parsing decisions.
 */
export function classifyRequest(
  pathname: string,
  headers: Record<string, string | undefined>,
): { provider: Provider; apiFormat: ApiFormat } {
  // ChatGPT backend traffic (Codex subscription)
  if (pathname.match(/^\/(api|backend-api)\//))
    return { provider: "chatgpt", apiFormat: "chatgpt-backend" };

  // Anthropic Messages API
  if (pathname.includes("/v1/messages"))
    return { provider: "anthropic", apiFormat: "anthropic-messages" };
  if (pathname.includes("/v1/complete"))
    return { provider: "anthropic", apiFormat: "unknown" };
  if (headers["anthropic-version"])
    return { provider: "anthropic", apiFormat: "unknown" };

  // Vertex AI: must come BEFORE Gemini (Vertex paths also contain :generateContent)
  // Matches /v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
  const isVertexPath = pathname.match(
    /\/v1[^/]*\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\//,
  );
  if (isVertexPath) {
    return { provider: "vertex", apiFormat: "gemini" };
  }

  // Gemini: must come BEFORE openai catch-all (which matches /models/)
  const isGeminiPath =
    pathname.includes(":generateContent") ||
    pathname.includes(":streamGenerateContent") ||
    pathname.match(/\/v1(beta|alpha)\/models\//) ||
    pathname.includes("/v1internal:");
  if (isGeminiPath || headers["x-goog-api-key"])
    return { provider: "gemini", apiFormat: "gemini" };

  // OpenAI
  if (pathname.includes("/responses"))
    return { provider: "openai", apiFormat: "responses" };
  if (pathname.includes("/chat/completions"))
    return { provider: "openai", apiFormat: "chat-completions" };
  if (pathname.match(/\/(models|embeddings)/))
    return { provider: "openai", apiFormat: "unknown" };
  if (headers.authorization?.startsWith("Bearer sk-"))
    return { provider: "openai", apiFormat: "unknown" };

  return { provider: "unknown", apiFormat: "unknown" };
}

/**
 * Extract a "source tool" tag from a request path.
 *
 * Example: `/claude/v1/messages` => `{ source: 'claude', cleanPath: '/v1/messages' }`.
 *
 * This tag is used for attribution in the UI/LHAR and for per-tool grouping.
 */
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match?.[2] && !API_PATH_SEGMENTS.has(match[1])) {
    // `decodeURIComponent` may introduce `/` via `%2f` (path traversal) or throw on bad encodings.
    // Treat suspicious/invalid tags as "no source tag" and route the request normally.
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("..")
    ) {
      return { source: null, sessionId: null, cleanPath: pathname };
    }
    return { source: decoded, sessionId: null, cleanPath: match[2] || "/" };
  }
  return { source: null, sessionId: null, cleanPath: pathname };
}

/**
 * Determine the final upstream target URL for a request.
 *
 * @param parsedUrl - Path + query extracted from the incoming request.
 * @param headers - Headers used for detection and optional override.
 * @param upstreams - Base URLs for each provider.
 * @returns `{ targetUrl, provider }`.
 */
export function resolveTargetUrl(
  parsedUrl: ParsedUrl,
  headers: Record<string, string | undefined>,
  upstreams: Upstreams,
): ResolveTargetResult {
  const provider = classifyRequest(parsedUrl.pathname, headers).provider;
  const search = parsedUrl.search || "";
  let targetUrl = headers["x-target-url"];
  if (!targetUrl) {
    if (provider === "chatgpt") {
      targetUrl = upstreams.chatgpt + parsedUrl.pathname + search;
    } else if (provider === "anthropic") {
      targetUrl = upstreams.anthropic + parsedUrl.pathname + search;
    } else if (provider === "gemini") {
      const isCodeAssist = parsedUrl.pathname.includes("/v1internal");
      targetUrl =
        (isCodeAssist ? upstreams.geminiCodeAssist : upstreams.gemini) +
        parsedUrl.pathname +
        search;
    } else if (provider === "vertex") {
      // Extract location from Vertex path to build the regional endpoint.
      // Path: /v1beta1/projects/{project}/locations/{location}/...
      const locMatch = parsedUrl.pathname.match(/\/locations\/([^/]+)\//);
      const location = locMatch?.[1];
      if (location && location !== "global") {
        targetUrl =
          `https://${location}-aiplatform.googleapis.com` +
          parsedUrl.pathname +
          search;
      } else {
        targetUrl = upstreams.vertex + parsedUrl.pathname + search;
      }
    } else {
      targetUrl = upstreams.openai + parsedUrl.pathname + search;
    }
  } else if (!targetUrl.startsWith("http")) {
    targetUrl = targetUrl + parsedUrl.pathname + search;
  }
  return { targetUrl, provider };
}
