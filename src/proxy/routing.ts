/**
 * Request routing for the proxy.
 *
 * Detects which LLM provider a request targets, extracts source tool tags,
 * and resolves the upstream URL. Zero external dependencies.
 */

// --- Types ---

export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt"
  | "gemini"
  | "unknown";

export type ApiFormat =
  | "anthropic-messages"
  | "chatgpt-backend"
  | "responses"
  | "chat-completions"
  | "gemini"
  | "raw"
  | "unknown";

export interface Upstreams {
  openai: string;
  anthropic: string;
  chatgpt: string;
  gemini: string;
  geminiCodeAssist: string;
}

export interface ExtractSourceResult {
  source: string | null;
  cleanPath: string;
}

export interface ResolveTargetResult {
  targetUrl: string;
  provider: Provider;
}

// --- Implementation ---

/**
 * URL path segments that represent API resources rather than "source tool" prefixes.
 *
 * Example: `/v1/messages` should not treat `v1` as a source tag.
 */
const API_PATH_SEGMENTS = new Set([
  "v1",
  "v1beta",
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
 * Classify an incoming request into `{ provider, apiFormat }`.
 *
 * All path/format heuristics live here to avoid drift between
 * routing and detection.
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
 */
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match?.[2] && !API_PATH_SEGMENTS.has(match[1])) {
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
      return { source: null, cleanPath: pathname };
    }
    return { source: decoded, cleanPath: match[2] || "/" };
  }
  return { source: null, cleanPath: pathname };
}

/**
 * Determine the final upstream target URL for a request.
 */
export function resolveTargetUrl(
  pathname: string,
  search: string | null,
  headers: Record<string, string | undefined>,
  upstreams: Upstreams,
): ResolveTargetResult {
  const provider = classifyRequest(pathname, headers).provider;
  const qs = search || "";
  let targetUrl = headers["x-target-url"];
  if (!targetUrl) {
    if (provider === "chatgpt") {
      targetUrl = upstreams.chatgpt + pathname + qs;
    } else if (provider === "anthropic") {
      targetUrl = upstreams.anthropic + pathname + qs;
    } else if (provider === "gemini") {
      const isCodeAssist = pathname.includes("/v1internal");
      targetUrl =
        (isCodeAssist ? upstreams.geminiCodeAssist : upstreams.gemini) +
        pathname +
        qs;
    } else {
      targetUrl = upstreams.openai + pathname + qs;
    }
  } else if (!targetUrl.startsWith("http")) {
    targetUrl = targetUrl + pathname + qs;
  }
  return { targetUrl, provider };
}
