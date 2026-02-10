import type http from "node:http";

export { selectHeaders } from "./http/headers.js";

// Keep filenames predictable and prevent traversal or weird platform behavior.
export function safeFilenamePart(input: string): string {
  const s = String(input || "").trim();
  let out = s.replace(/[^a-zA-Z0-9._-]+/g, "_");
  out = out.replace(/\.\.+/g, "_"); // collapse any ".." runs
  out = out.replace(/^_+|_+$/g, "");
  if (!out || out === "." || out === "..") return "unknown";
  return out.slice(0, 80);
}

export function isLocalRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function headersForResolution(
  headers: http.IncomingHttpHeaders,
  remoteAddr: string | undefined,
  allowTargetOverride: boolean,
): Record<string, string | undefined> {
  const h = headers as Record<string, string | undefined>;
  if (
    h["x-target-url"] &&
    !(allowTargetOverride && isLocalRemote(remoteAddr))
  ) {
    // Ignore override unless explicitly enabled and coming from localhost.
    const { "x-target-url": _drop, ...rest } = h;
    return rest;
  }
  return h;
}

// `selectHeaders` is re-exported from `src/http/headers.ts` to keep server-utils small.
