#!/usr/bin/env node

/**
 * Context Lens Proxy — standalone entry point.
 *
 * A minimal HTTP proxy that forwards LLM API requests to their upstream
 * providers and writes raw captures to disk for analysis. Zero external
 * dependencies; uses only Node.js built-ins.
 *
 * Capture files are written to CONTEXT_LENS_CAPTURE_DIR (default:
 * ~/.context-lens/captures/) as atomic JSON files. A separate analysis
 * server watches that directory and provides the web UI.
 */

import http from "node:http";

import { createCaptureWriter } from "./capture.js";
import { loadProxyConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";

const config = loadProxyConfig();
const captureWriter = createCaptureWriter(config.captureDir);

const server = http.createServer(
  createProxyHandler({
    upstreams: config.upstreams,
    allowTargetOverride: config.allowTargetOverride,
    onCapture: (capture) => {
      captureWriter.write(capture);
    },
  }),
);

server.listen(config.port, config.bindHost, () => {
  console.log(
    `🔍 Context Lens Proxy running on http://${config.bindHost}:${config.port}`,
  );
  console.log(`📁 Captures → ${config.captureDir}`);
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${config.upstreams.openai}`);
    console.log(`         Anthropic → ${config.upstreams.anthropic}`);
    console.log(`         Gemini → ${config.upstreams.gemini}`);
  }
});
