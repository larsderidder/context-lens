/**
 * Header redaction for the proxy.
 *
 * The proxy captures headers for debugging but must never persist secrets.
 * This is the single source of truth for what gets stripped.
 */

/** Case-insensitive set of header names that must never be persisted. */
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "x-target-url",
  "proxy-authorization",
  "x-auth-token",
  "x-forwarded-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "x-goog-api-key",
]);

/**
 * Select a safe subset of headers for capture.
 *
 * Drops sensitive headers and keeps only string-valued entries
 * (Node can represent multi-valued headers as arrays).
 */
export function selectHeaders(
  headers: Record<string, any>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    if (typeof val === "string") result[key] = val;
  }
  return result;
}
