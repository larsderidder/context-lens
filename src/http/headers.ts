/**
 * Shared header redaction utilities.
 *
 * Context Lens captures and exports some headers for debugging and provenance,
 * but must never persist secrets (API keys, cookies, auth challenges, etc.).
 *
 * Keep this as the single source of truth to avoid drift between "capture" and "export".
 */

/** Case-insensitive set of header names that must never be persisted/exported. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'x-target-url',
  'proxy-authorization',
  'x-auth-token',
  'x-forwarded-authorization',
  'www-authenticate',
  'proxy-authenticate',
  'x-goog-api-key',
]);

/**
 * Remove sensitive headers from a header map.
 *
 * @param headers - Header map (string -> string)
 * @returns A new object with sensitive headers removed.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = val;
  }
  return result;
}

/**
 * Select a safe subset of request/response headers for capture.
 *
 * - Drops sensitive headers (see `SENSITIVE_HEADERS`)
 * - Keeps only string-valued headers (Node can represent multi-valued headers as arrays)
 */
export function selectHeaders(headers: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    if (typeof val === 'string') result[key] = val;
  }
  return result;
}

