#!/usr/bin/env node

/**
 * Context Lens Proxy — standalone entry point.
 *
 * A minimal HTTP proxy that forwards LLM API requests to their upstream
 * providers and writes raw captures to disk for analysis.
 *
 * ZERO DEPENDENCIES CONSTRAINT
 * ============================
 * This proxy (everything under src/proxy/) must stay zero external
 * dependencies. Only Node.js built-in modules (node:http, node:https,
 * node:fs, node:path, node:os, node:url) are allowed. No npm packages.
 *
 * Why: users route their API keys through this proxy. Keeping the code
 * small and dependency-free means the entire proxy can be audited by
 * reading a single directory. No transitive supply-chain risk.
 *
 * The analysis server, CLI, and web UI are separate processes that
 * communicate via capture files on disk, and those are free to use
 * whatever dependencies they need.
 *
 * Capture files are written to CONTEXT_LENS_CAPTURE_DIR (default:
 * ~/.context-lens/captures/) as atomic JSON files. A separate analysis
 * server watches that directory and provides the web UI.
 */

import http from "node:http";

import { createCaptureIngestor, createCaptureWriter } from "./capture.js";
import { loadProxyConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";

const config = loadProxyConfig();

let onCapture: (capture: import("./capture.js").CaptureData) => void;

if (config.ingestUrl) {
  const ingestor = createCaptureIngestor(config.ingestUrl);
  onCapture = (capture) => ingestor.post(capture);
  console.log(`📡 Captures → ${config.ingestUrl}`);
} else {
  const writer = createCaptureWriter(config.captureDir);
  onCapture = (capture) => writer.write(capture);
}

const server = http.createServer(
  createProxyHandler({
    upstreams: config.upstreams,
    allowTargetOverride: config.allowTargetOverride,
    onCapture,
  }),
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.log(`🔍 Context Lens Proxy already running on port ${config.port}`);
    process.exit(0);
  }
  throw err;
});

server.listen(config.port, config.bindHost, () => {
  console.log(
    `🔍 Context Lens Proxy running on http://${config.bindHost}:${config.port}`,
  );
  if (!config.ingestUrl) {
    console.log(`📁 Captures → ${config.captureDir}`);
  }
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${config.upstreams.openai}`);
    console.log(`         Anthropic → ${config.upstreams.anthropic}`);
    console.log(`         Gemini → ${config.upstreams.gemini}`);
    if (process.env.UPSTREAM_OPENAI_URL) {
      console.log(`\n⚠️  OpenAI upstream overridden via UPSTREAM_OPENAI_URL`);
    }
  }
});
