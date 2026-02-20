/**
 * Capture directory watcher.
 *
 * Watches for new capture files written by the proxy, reads them,
 * and feeds them into the analysis pipeline (Store).
 *
 * On startup, replays all existing capture files in sorted order.
 * Then watches for new files via fs.watch. Ignores .tmp files
 * (the proxy writes atomically: .tmp then rename).
 */

import fs from "node:fs";
import { join } from "node:path";

import type { CaptureData } from "../proxy/capture.js";

export type CaptureHandler = (capture: CaptureData, filename: string) => void;

export interface CaptureWatcherOptions {
  captureDir: string;
  onCapture: CaptureHandler;
  /** Delete capture files after successful processing (default: true) */
  deleteAfterProcessing?: boolean;
  /** Poll interval in ms when fs.watch is unreliable (default: 0 = disabled) */
  pollInterval?: number;
}

export class CaptureWatcher {
  private readonly captureDir: string;
  private readonly onCapture: CaptureHandler;
  private readonly deleteAfterProcessing: boolean;
  private readonly pollInterval: number;
  private readonly processed = new Set<string>();
  private readonly processing = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: CaptureWatcherOptions) {
    this.captureDir = opts.captureDir;
    this.onCapture = opts.onCapture;
    this.deleteAfterProcessing = opts.deleteAfterProcessing ?? true;
    this.pollInterval = opts.pollInterval ?? 0;
  }

  /**
   * Start watching. Replays existing captures first, then watches for new ones.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Replay existing captures
    this.replayExisting();

    // Start watching for new files
    this.startWatch();
  }

  /**
   * Stop watching.
   */
  stop(): void {
    this.running = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Process all existing capture files in sorted order.
   */
  private replayExisting(): void {
    if (!fs.existsSync(this.captureDir)) return;

    const files = fs
      .readdirSync(this.captureDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .sort();

    for (const filename of files) {
      this.processFile(filename);
    }

    if (files.length > 0) {
      console.log(`📂 Replayed ${this.processed.size} existing captures`);
    }
  }

  /**
   * Start fs.watch on the capture directory, with optional polling fallback.
   */
  private startWatch(): void {
    // Ensure the directory exists before watching
    if (!fs.existsSync(this.captureDir)) {
      fs.mkdirSync(this.captureDir, { recursive: true });
    }

    try {
      this.watcher = fs.watch(this.captureDir, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return;
        // Small delay to ensure rename is complete
        setTimeout(() => this.processFile(filename), 10);
      });

      this.watcher.on("error", (err) => {
        console.error("Watcher error:", err.message);
        // Fall back to polling
        this.watcher = null;
        this.startPolling();
      });
    } catch (err: unknown) {
      console.error(
        "fs.watch failed, falling back to polling:",
        err instanceof Error ? err.message : String(err),
      );
      this.startPolling();
    }

    // Optional: also poll for reliability (fs.watch can miss events on some platforms)
    if (this.pollInterval > 0) {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const interval = this.pollInterval > 0 ? this.pollInterval : 1000;
    this.pollTimer = setInterval(() => {
      if (!this.running) return;
      this.scanForNew();
    }, interval);
  }

  private scanForNew(): void {
    if (!fs.existsSync(this.captureDir)) return;

    const files = fs
      .readdirSync(this.captureDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .sort();
    const present = new Set(files);

    // Keep dedupe state bounded to files that still exist.
    // This prevents unbounded growth in long-running processes.
    for (const filename of this.processed) {
      if (!present.has(filename)) this.processed.delete(filename);
    }

    for (const filename of files) {
      if (!this.processed.has(filename)) {
        this.processFile(filename);
      }
    }
  }

  /**
   * Read and process a single capture file.
   */
  private processFile(filename: string): void {
    if (this.processed.has(filename) || this.processing.has(filename)) return;

    const filePath = join(this.captureDir, filename);
    this.processing.add(filename);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const capture: CaptureData = JSON.parse(content);
      this.processed.add(filename);
      this.onCapture(capture, filename);

      if (this.deleteAfterProcessing) {
        try {
          fs.unlinkSync(filePath);
          this.processed.delete(filename);
        } catch {
          /* file may already be gone */
        }
      }
    } catch (err: unknown) {
      // File might still be being written, or it's corrupt
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) return; // File disappeared, ignore
      console.error(`Capture read error (${filename}):`, msg);
    } finally {
      this.processing.delete(filename);
    }
  }
}
