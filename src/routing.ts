import type { Provider, ApiFormat, ExtractSourceResult, ParsedUrl, Upstreams, ResolveTargetResult } from './types.js';

// Known API path segments — not treated as source prefixes
export const API_PATH_SEGMENTS = new Set([
  'v1', 'v1beta', 'v1alpha', 'v1internal', 'responses', 'chat', 'models', 'embeddings', 'backend-api', 'api',
]);

// Detect provider from request
export function detectProvider(pathname: string, headers: Record<string, string | undefined>): Provider {
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt';
  if (pathname.includes('/v1/messages') || pathname.includes('/v1/complete')) return 'anthropic';
  if (headers['anthropic-version']) return 'anthropic';
  // Gemini: must come BEFORE openai catch-all (which matches /models/)
  if (pathname.includes(':generateContent') || pathname.includes(':streamGenerateContent') || pathname.match(/\/v1(beta|alpha)\/models\//) || pathname.includes('/v1internal:'))
    return 'gemini';
  if (headers['x-goog-api-key']) return 'gemini';
  if (pathname.match(/\/(responses|chat\/completions|models|embeddings)/)) return 'openai';
  if (headers['authorization']?.startsWith('Bearer sk-')) return 'openai';
  return 'unknown';
}

// Detect which API format is being used
export function detectApiFormat(pathname: string): ApiFormat {
  if (pathname.includes('/v1/messages')) return 'anthropic-messages';
  if (pathname.match(/^\/(api|backend-api)\//)) return 'chatgpt-backend';
  if (pathname.includes(':generateContent') || pathname.includes(':streamGenerateContent') || pathname.match(/\/v1(beta|alpha)\/models\//) || pathname.includes('/v1internal:'))
    return 'gemini';
  if (pathname.includes('/responses')) return 'responses';
  if (pathname.includes('/chat/completions')) return 'chat-completions';
  return 'unknown';
}

// Extract source tag from URL path
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match && match[2] && !API_PATH_SEGMENTS.has(match[1])) {
    // `decodeURIComponent` may introduce `/` via `%2f` (path traversal) or throw on bad encodings.
    // Treat suspicious/invalid tags as "no source tag" and route the request normally.
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..')) {
      return { source: null, cleanPath: pathname };
    }
    return { source: decoded, cleanPath: match[2] || '/' };
  }
  return { source: null, cleanPath: pathname };
}

// Determine target URL for a request
export function resolveTargetUrl(parsedUrl: ParsedUrl, headers: Record<string, string | undefined>, upstreams: Upstreams): ResolveTargetResult {
  const provider = detectProvider(parsedUrl.pathname, headers);
  const search = parsedUrl.search || '';
  let targetUrl = headers['x-target-url'];
  if (!targetUrl) {
    if (provider === 'chatgpt') {
      targetUrl = upstreams.chatgpt + parsedUrl.pathname + search;
    } else if (provider === 'anthropic') {
      targetUrl = upstreams.anthropic + parsedUrl.pathname + search;
    } else if (provider === 'gemini') {
      const isCodeAssist = parsedUrl.pathname.includes('/v1internal');
      targetUrl = (isCodeAssist ? upstreams.geminiCodeAssist : upstreams.gemini) + parsedUrl.pathname + search;
    } else {
      targetUrl = upstreams.openai + parsedUrl.pathname + search;
    }
  } else if (!targetUrl.startsWith('http')) {
    targetUrl = targetUrl + parsedUrl.pathname + search;
  }
  return { targetUrl, provider };
}

