import http from 'node:http';

// Keep filenames predictable and prevent traversal or weird platform behavior.
export function safeFilenamePart(input: string): string {
  const s = String(input || '').trim();
  let out = s.replace(/[^a-zA-Z0-9._-]+/g, '_');
  out = out.replace(/\.\.+/g, '_'); // collapse any ".." runs
  out = out.replace(/^_+|_+$/g, '');
  if (!out || out === '.' || out === '..') return 'unknown';
  return out.slice(0, 80);
}

export function isLocalRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function headersForResolution(
  headers: http.IncomingHttpHeaders,
  remoteAddr: string | undefined,
  allowTargetOverride: boolean,
): Record<string, string | undefined> {
  const h = headers as Record<string, string | undefined>;
  if (h['x-target-url'] && !(allowTargetOverride && isLocalRemote(remoteAddr))) {
    // Ignore override unless explicitly enabled and coming from localhost.
    const { ['x-target-url']: _drop, ...rest } = h;
    return rest;
  }
  return h;
}

// Headers to exclude from capture (auth/sensitive)
const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'x-target-url']);

export function selectHeaders(headers: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (REDACTED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof val === 'string') result[key] = val;
  }
  return result;
}

