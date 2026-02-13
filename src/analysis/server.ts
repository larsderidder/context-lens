#!/usr/bin/env node

/**
 * Context Lens Analysis Server.
 *
 * Watches the capture directory for new files from the proxy,
 * processes them through the analysis pipeline, and serves
 * the Web UI and API.
 */

import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../server/store.js";
import { createWebUIHandler, loadHtmlUI } from "../server/webui.js";
import type { PrivacyLevel } from "../types.js";
import { ingestCapture } from "./ingest.js";
import { CaptureWatcher } from "./watcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---

const bindHost = process.env.CONTEXT_LENS_BIND_HOST || "127.0.0.1";
const port = parseInt(process.env.CONTEXT_LENS_ANALYSIS_PORT || "4041", 10);

const captureDir =
  process.env.CONTEXT_LENS_CAPTURE_DIR ||
  path.join(homedir(), ".context-lens", "captures");

const privacyEnv = (
  process.env.CONTEXT_LENS_PRIVACY || "standard"
).toLowerCase();
const privacy: PrivacyLevel =
  privacyEnv === "minimal" || privacyEnv === "full" ? privacyEnv : "standard";

// Data directory: alongside captures in the same parent
const dataDir =
  process.env.CONTEXT_LENS_DATA_DIR ||
  path.join(homedir(), ".context-lens", "data");

const maxSessions = 100;
const maxCompactMessages = 60;

// --- Setup ---

const store = new Store({
  dataDir,
  stateFile: path.join(dataDir, "state.jsonl"),
  maxSessions,
  maxCompactMessages,
  privacy,
});

store.loadState();

// --- Capture watcher ---

const isUtilityEndpoint = (capturePath: string): boolean =>
  /\/count_tokens\b|:countTokens\b|:loadCodeAssist\b|:retrieveUserQuota\b|:listExperiments\b|:onboardUser\b|:fetchAdminControls\b|:recordCodeAssistMetrics\b/.test(
    capturePath,
  );

const watcher = new CaptureWatcher({
  captureDir,
  onCapture: (capture, filename) => {
    // Skip utility endpoints
    if (isUtilityEndpoint(capture.path)) return;

    try {
      ingestCapture(store, capture);
    } catch (err: unknown) {
      console.error(
        `Ingest error (${filename}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
  deleteAfterProcessing: true,
});

watcher.start();

// --- Web UI server ---

// baseDir for webui: the analysis server lives in dist/analysis/,
// so project root is two levels up
const projectDistDir = path.resolve(__dirname, "..");
const htmlUI = loadHtmlUI();
const webUIServer = http.createServer(
  createWebUIHandler(store, htmlUI, projectDistDir),
);

webUIServer.listen(port, bindHost, () => {
  console.log(`🌐 Context Lens Analysis running on http://${bindHost}:${port}`);
  console.log(`📁 Watching captures → ${captureDir}`);
  console.log(`💾 Data → ${dataDir}`);
});

// --- Graceful shutdown ---

function shutdown(): void {
  watcher.stop();
  webUIServer.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
