/**
 * Proxy configuration.
 *
 * Reads from environment variables with safe defaults.
 * Zero external dependencies.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Upstreams } from "./routing.js";

export interface ProxyConfig {
  upstreams: Upstreams;
  bindHost: string;
  port: number;
  allowTargetOverride: boolean;
  captureDir: string;
  /** When set, POST captures to this URL instead of writing files to captureDir. */
  ingestUrl: string | null;
}

export function loadProxyConfig(): ProxyConfig {
  const upstreams: Upstreams = {
    openai: process.env.UPSTREAM_OPENAI_URL || "https://api.openai.com/v1",
    anthropic:
      process.env.UPSTREAM_ANTHROPIC_URL || "https://api.anthropic.com",
    chatgpt: process.env.UPSTREAM_CHATGPT_URL || "https://chatgpt.com",
    gemini:
      process.env.UPSTREAM_GEMINI_URL ||
      "https://generativelanguage.googleapis.com",
    geminiCodeAssist:
      process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL ||
      "https://cloudcode-pa.googleapis.com",
    vertex:
      process.env.UPSTREAM_VERTEX_URL ||
      "https://us-central1-aiplatform.googleapis.com",
  };

  // Bind only to localhost unless explicitly overridden.
  const bindHost = process.env.CONTEXT_LENS_BIND_HOST || "127.0.0.1";
  const port = parseInt(process.env.CONTEXT_LENS_PROXY_PORT || "4040", 10);

  // Do not honor `x-target-url` unless explicitly enabled.
  const allowTargetOverride =
    process.env.CONTEXT_LENS_ALLOW_TARGET_OVERRIDE === "1";

  const captureDir =
    process.env.CONTEXT_LENS_CAPTURE_DIR ||
    join(homedir(), ".context-lens", "captures");

  const ingestUrl = process.env.CONTEXT_LENS_INGEST_URL || null;

  return {
    upstreams,
    bindHost,
    port,
    allowTargetOverride,
    captureDir,
    ingestUrl,
  };
}
