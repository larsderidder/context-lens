/**
 * Capture writer for the proxy.
 *
 * Two modes (zero external dependencies in both):
 *   - File mode (default): atomic JSON writes to a capture directory.
 *   - Ingest mode: POST captures to a remote ingest URL over HTTP.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { URL } from "node:url";

export interface CaptureData {
  timestamp: string;
  method: string;
  path: string;
  source: string | null;
  provider: string;
  apiFormat: string;
  targetUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: Record<string, any> | null;
  requestBytes: number;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseIsStreaming: boolean;
  responseBytes: number;
  sessionId?: string | null;
  timings: {
    send_ms: number;
    wait_ms: number;
    receive_ms: number;
    total_ms: number;
  };
}

/**
 * Create a capture writer for a given directory.
 *
 * Ensures the directory exists on first use. File names are
 * `{timestamp}-{counter}.json` for natural sort order and uniqueness.
 */
export function createCaptureWriter(captureDir: string) {
  let dirReady = false;
  let counter = 0;

  function ensureDir(): void {
    if (dirReady) return;
    fs.mkdirSync(captureDir, { recursive: true });
    dirReady = true;
  }

  /**
   * Write a capture to disk atomically.
   *
   * Returns the filename (without directory) on success, or null on error.
   */
  function write(capture: CaptureData): string | null {
    ensureDir();
    const seq = String(counter++).padStart(6, "0");
    const ts = Date.now();
    const filename = `${ts}-${seq}.json`;
    const filePath = join(captureDir, filename);
    const tmpPath = `${filePath}.tmp`;

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(capture));
      fs.renameSync(tmpPath, filePath);
      return filename;
    } catch (err: unknown) {
      console.error(
        "Capture write error:",
        err instanceof Error ? err.message : String(err),
      );
      // Clean up temp file if rename failed
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* may not exist */
      }
      return null;
    }
  }

  return { write };
}

/**
 * Create a capture poster that sends captures to a remote ingest endpoint.
 *
 * Used when CONTEXT_LENS_INGEST_URL is set, so the proxy can run without
 * a shared filesystem (split-container or remote analysis server setups).
 * Fire-and-forget: errors are logged but never bubble up to the caller.
 */
export function createCaptureIngestor(ingestUrl: string) {
  const parsed = new URL(ingestUrl);
  const protocol = parsed.protocol === "https:" ? https : http;

  function post(capture: CaptureData): void {
    const body = JSON.stringify(capture);
    const req = protocol.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + (parsed.search || ""),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // Drain the response so the socket is released
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          console.error(`Ingest HTTP error: ${res.statusCode} ${ingestUrl}`);
        }
      },
    );

    req.on("error", (err) => {
      console.error("Ingest POST error:", err.message);
    });

    req.write(body);
    req.end();
  }

  return { post };
}
