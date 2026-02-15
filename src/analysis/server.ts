#!/usr/bin/env node

/**
 * Context Lens Analysis Server.
 *
 * Watches the capture directory for new files from the proxy,
 * processes them through the analysis pipeline, and serves
 * the Web UI and API.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

import { Store } from "../server/store.js";
import { createApp, loadHtmlUI } from "../server/webui.js";
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

// Data directory: check for explicit env, then legacy location, then new default.
// Pre-split installs stored data in <project>/data/ next to dist/.
function resolveDataDir(): string {
  if (process.env.CONTEXT_LENS_DATA_DIR)
    return process.env.CONTEXT_LENS_DATA_DIR;

  // Legacy location: <project>/data/ (sibling of dist/)
  const legacyDir = path.resolve(__dirname, "..", "..", "data");
  const legacyState = path.join(legacyDir, "state.jsonl");
  if (fs.existsSync(legacyState)) {
    console.log(`📦 Found existing data at legacy location: ${legacyDir}`);
    return legacyDir;
  }

  return path.join(homedir(), ".context-lens", "data");
}

const dataDir = resolveDataDir();

const maxSessions = 200;
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

const projectDistDir = path.resolve(__dirname, "..");
const htmlUI = loadHtmlUI();
const app = createApp(store, htmlUI, projectDistDir);

const server = serve({ fetch: app.fetch, hostname: bindHost, port }, (info) => {
  console.log(
    `🌐 Context Lens Analysis running on http://${info.address}:${info.port}`,
  );
  console.log(`📁 Watching captures → ${captureDir}`);
  console.log(`💾 Data → ${dataDir}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.log(`🌐 Context Lens Analysis already running on port ${port}`);
    watcher.stop();
    process.exit(0);
  }
  throw err;
});

// --- Graceful shutdown ---

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  watcher.stop();
  server.close();

  // Force exit after a short grace period. server.close() waits for
  // active connections (like SSE streams) to drain, which may never
  // happen. A brief timeout lets in-flight responses finish while
  // preventing the process from hanging indefinitely.
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
