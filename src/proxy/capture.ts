/**
 * Capture writer for the proxy.
 *
 * Writes raw request/response pairs as JSON files to the capture directory.
 * Uses atomic writes (write to .tmp, then rename) so readers never see
 * partial files. Zero external dependencies.
 */

import fs from "node:fs";
import { join } from "node:path";

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
